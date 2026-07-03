/**
 * Offline downloads: pull a book's audio (and cover) into the app's own
 * storage so it plays without the server, and track how much space that uses.
 *
 * Design:
 * - One folder per item under <documentDir>/downloads/<itemId>/. Audio files
 *   are named track-<index>.<ext>; the cover is cover.jpg.
 * - A manifest per item (enough to rebuild the player's NowPlaying offline:
 *   tracks with local uri + startOffset + duration, chapters, title/author).
 * - The whole index (manifests + in-flight download state) persists to
 *   AsyncStorage so downloads and their metadata survive a restart. In-flight
 *   downloads don't resume across launches yet - a killed download is marked
 *   'failed' on next boot so the user can retry.
 *
 * Plain subscribe/snapshot store (same shape as the other stores) for
 * useSyncExternalStore + non-React reads (offline playback resolution).
 *
 * NOTE: expo-file-system is a native module; download/playback behavior can
 * only be verified in a dev build, not in this environment.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Paths, File, Directory } from 'expo-file-system'
import { createDownloadResumable, type DownloadResumable } from 'expo-file-system/legacy'
import type { ABSChapter } from '@hearthshelf/core'
import { startPlay, mediaUrl, coverUrl, closeSession } from '@/api/abs'

export interface DownloadedTrack {
  index: number
  uri: string
  startOffset: number
  duration: number
}

export type DownloadStatus = 'queued' | 'downloading' | 'done' | 'failed'

export interface DownloadEntry {
  itemId: string
  title: string
  author: string
  status: DownloadStatus
  /** 0-1 across all of the item's tracks. */
  progress: number
  /** Bytes on disk so far (best-effort; finalized when done). */
  bytes: number
  coverUri: string | null
  duration: number
  chapters: ABSChapter[]
  tracks: DownloadedTrack[]
  error?: string
}

/** Device-local auto-download preferences (not synced - storage is per-device). */
export interface AutoDownloadPrefs {
  /** Download a book automatically when you start listening to it. */
  onStart: boolean
  /** Keep the next N queued books downloaded ahead of you (0 = off). */
  queueAhead: number
  /** Auto-download everything in Continue Listening. */
  continueListening: boolean
}

export interface DownloadsState {
  byId: ReadonlyMap<string, DownloadEntry>
  /** Cap on total download bytes; 0 = unlimited. */
  maxBytes: number
  auto: AutoDownloadPrefs
}

const STORE_KEY = 'hs.downloads.v1'
const DEFAULT_MAX_BYTES = 0
const DEFAULT_AUTO: AutoDownloadPrefs = { onStart: false, queueAhead: 0, continueListening: true }

let state: DownloadsState = { byId: new Map(), maxBytes: DEFAULT_MAX_BYTES, auto: DEFAULT_AUTO }
const listeners = new Set<() => void>()
// Live resumables, so a download can be cancelled. Not persisted.
const active = new Map<string, DownloadResumable>()

function emit(next: Partial<DownloadsState>): void {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

function persist(): void {
  const payload = {
    maxBytes: state.maxBytes,
    auto: state.auto,
    // Only finished downloads are worth persisting as playable; in-flight ones
    // can't resume across launches, so drop them (they'll show as absent).
    items: [...state.byId.values()].filter((e) => e.status === 'done'),
  }
  void AsyncStorage.setItem(STORE_KEY, JSON.stringify(payload)).catch(() => {})
}

export function getDownloadsState(): DownloadsState {
  return state
}

export function subscribeDownloads(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function downloadFor(itemId: string): DownloadEntry | undefined {
  return state.byId.get(itemId)
}

export function isDownloaded(itemId: string): boolean {
  return state.byId.get(itemId)?.status === 'done'
}

/** Load persisted downloads on app start. */
export async function hydrateDownloads(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as {
      maxBytes?: number
      auto?: Partial<AutoDownloadPrefs>
      items?: DownloadEntry[]
    }
    const byId = new Map<string, DownloadEntry>()
    for (const e of parsed.items ?? []) byId.set(e.itemId, { ...e, status: 'done' })
    emit({
      byId,
      maxBytes: parsed.maxBytes ?? DEFAULT_MAX_BYTES,
      auto: { ...DEFAULT_AUTO, ...(parsed.auto ?? {}) },
    })
  } catch {
    // start empty on a bad payload
  }
}

function upsert(entry: DownloadEntry): void {
  const byId = new Map(state.byId)
  byId.set(entry.itemId, entry)
  emit({ byId })
}

function patch(itemId: string, p: Partial<DownloadEntry>): void {
  const cur = state.byId.get(itemId)
  if (!cur) return
  upsert({ ...cur, ...p })
}

function itemDir(itemId: string): Directory {
  return new Directory(Paths.document, 'downloads', itemId)
}

function extFor(mimeType: string, contentUrl: string): string {
  if (mimeType.includes('mp4') || mimeType.includes('m4b') || mimeType.includes('m4a')) return 'm4a'
  if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'mp3'
  if (mimeType.includes('ogg')) return 'ogg'
  const m = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(contentUrl)
  return m ? m[1] : 'mp3'
}

/**
 * Download all of an item's audio (and its cover) into app storage. Starts an
 * ABS play session only to enumerate the audio tracks + chapters, then closes
 * it immediately (this is not a listening session). Idempotent: a book already
 * downloaded or in flight is a no-op.
 */
export async function downloadItem(itemId: string, title: string, author: string): Promise<void> {
  const existing = state.byId.get(itemId)
  if (existing && (existing.status === 'done' || existing.status === 'downloading')) return

  upsert({
    itemId,
    title,
    author,
    status: 'queued',
    progress: 0,
    bytes: 0,
    coverUri: null,
    duration: 0,
    chapters: [],
    tracks: [],
  })

  let sessionId: string | null = null
  let sessionResumeTime = 0
  let sessionDuration = 0
  try {
    const session = await startPlay(itemId)
    sessionId = session.id
    sessionResumeTime = Math.max(0, session.currentTime ?? 0)
    sessionDuration = session.duration
    const dir = itemDir(itemId)
    if (!dir.exists) dir.create({ intermediates: true })

    patch(itemId, {
      status: 'downloading',
      duration: session.duration,
      chapters: session.chapters ?? [],
    })

    const audioTracks = session.audioTracks
    const totalDuration = Math.max(1, session.duration)
    const downloaded: DownloadedTrack[] = []
    let cumulativeBytes = 0

    for (const track of audioTracks) {
      const ext = extFor(track.mimeType, track.contentUrl)
      const dest = new File(dir, `track-${track.index}.${ext}`)
      const resumable = createDownloadResumable(
        mediaUrl(track.contentUrl),
        dest.uri,
        {},
        (p) => {
          const trackFrac =
            p.totalBytesExpectedToWrite > 0
              ? p.totalBytesWritten / p.totalBytesExpectedToWrite
              : 0
          // Weight each track by its share of the book's duration.
          const doneDuration = downloaded.reduce((s, t) => s + t.duration, 0)
          const overall = (doneDuration + trackFrac * track.duration) / totalDuration
          patch(itemId, {
            progress: Math.min(0.999, overall),
            bytes: cumulativeBytes + p.totalBytesWritten,
          })
        },
      )
      active.set(itemId, resumable)
      const result = await resumable.downloadAsync()
      active.delete(itemId)
      if (!result) throw new Error('download_cancelled')
      const info = dest.exists ? dest.size ?? 0 : 0
      cumulativeBytes += info
      downloaded.push({
        index: track.index,
        uri: dest.uri,
        startOffset: track.startOffset,
        duration: track.duration,
      })
    }

    // Cover: best-effort, not fatal if it fails.
    let coverUri: string | null = null
    try {
      const coverFile = new File(dir, 'cover.jpg')
      const cres = createDownloadResumable(coverUrl(itemId), coverFile.uri, {})
      const r = await cres.downloadAsync()
      if (r && coverFile.exists) coverUri = coverFile.uri
    } catch {
      // no cover offline; the player falls back to the typeset cover
    }

    patch(itemId, {
      status: 'done',
      progress: 1,
      bytes: cumulativeBytes,
      coverUri,
      tracks: downloaded,
    })
    persist()
  } catch (e) {
    active.delete(itemId)
    const msg = (e as Error).message
    if (msg === 'download_cancelled') {
      // cancel() already removed the entry + files
    } else {
      patch(itemId, { status: 'failed', error: msg })
    }
  } finally {
    if (sessionId) {
      try {
        await closeSession(sessionId, {
          currentTime: Math.round(sessionResumeTime),
          timeListened: 0,
          duration: sessionDuration,
        })
      } catch {
        // ignore
      }
    }
  }
}

/** Cancel an in-flight download and remove its partial files. */
export async function cancelDownload(itemId: string): Promise<void> {
  const resumable = active.get(itemId)
  if (resumable) {
    try {
      await resumable.cancelAsync()
    } catch {
      // ignore
    }
    active.delete(itemId)
  }
  await deleteDownload(itemId)
}

/** Delete a downloaded (or partially downloaded) book and free its space. */
export async function deleteDownload(itemId: string): Promise<void> {
  try {
    const dir = itemDir(itemId)
    if (dir.exists) dir.delete()
  } catch {
    // ignore fs errors; still drop it from the index
  }
  const byId = new Map(state.byId)
  byId.delete(itemId)
  emit({ byId })
  persist()
}

/** Total bytes used by all downloads. */
export function totalBytes(): number {
  let sum = 0
  for (const e of state.byId.values()) sum += e.bytes
  return sum
}

export interface DiskSpace {
  /** Total device internal storage, in bytes. */
  total: number
  /** Free device storage, in bytes. */
  free: number
  /** Bytes this app's downloads currently occupy. */
  used: number
}

/**
 * Device storage snapshot for the storage meter. Reads Paths.total/available
 * DiskSpace (synchronous native getters). Returns zeroed totals if the native
 * module can't report them (e.g. web), so callers can hide the meter.
 */
export function diskSpace(): DiskSpace {
  let total = 0
  let free = 0
  try {
    total = Paths.totalDiskSpace ?? 0
    free = Paths.availableDiskSpace ?? 0
  } catch {
    // native getters unavailable; leave zeroed
  }
  return { total, free, used: totalBytes() }
}

export function setMaxBytes(maxBytes: number): void {
  emit({ maxBytes })
  persist()
}

export function setAutoPrefs(patch: Partial<AutoDownloadPrefs>): void {
  emit({ auto: { ...state.auto, ...patch } })
  persist()
}

/** Kick off a download only if the item isn't already downloaded/in flight and
 *  the size cap (if any) isn't already exceeded. Silent - for auto-download. */
export function autoDownload(itemId: string, title: string, author: string): void {
  const cur = state.byId.get(itemId)
  if (cur && (cur.status === 'done' || cur.status === 'downloading' || cur.status === 'queued')) return
  if (state.maxBytes > 0 && totalBytes() >= state.maxBytes) return
  void downloadItem(itemId, title, author)
}

/**
 * Apply the auto-download preferences given the current playing item and the
 * up-next queue. Called from the play path and on queue changes. Continue-
 * Listening items are passed in by the caller (Home has that list).
 */
export function applyAutoDownloads(input: {
  nowPlaying?: { itemId: string; title: string; author: string } | null
  queue?: { libraryItemId: string; title: string; author?: string }[]
  continueListening?: { itemId: string; title: string; author: string }[]
}): void {
  const { auto } = state
  if (auto.onStart && input.nowPlaying) {
    autoDownload(input.nowPlaying.itemId, input.nowPlaying.title, input.nowPlaying.author)
  }
  if (auto.queueAhead > 0 && input.queue) {
    for (const e of input.queue.slice(0, auto.queueAhead)) {
      autoDownload(e.libraryItemId, e.title, e.author ?? '')
    }
  }
  if (auto.continueListening && input.continueListening) {
    for (const e of input.continueListening) autoDownload(e.itemId, e.title, e.author)
  }
}

/** Build a NowPlaying-shaped source from a completed download, or null if the
 *  item isn't downloaded. Used by playback to prefer local files when offline. */
export function localSourceFor(itemId: string): DownloadEntry | null {
  const e = state.byId.get(itemId)
  return e && e.status === 'done' && e.tracks.length > 0 ? e : null
}
