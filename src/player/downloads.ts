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
 *   AsyncStorage so downloads and their metadata survive a restart. An
 *   interrupted download (app killed in the background, crash, force quit) is
 *   restored as 'failed' on next boot carrying the tracks it already finished
 *   plus a resume token for the track it was mid-way through, so retrying
 *   continues from where it stopped instead of restarting from zero.
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
import {
  startPlay,
  mediaUrl,
  coverUrl,
  closeSession,
  getItemDetail,
  getLibrarySeries,
} from '@/api/abs'
import {
  saveCatalogItem,
  saveSeriesSkeleton,
  removeCatalogItem,
  backfillFromDownloads,
} from './offlineCatalog'
import { subscribeQueue } from './queue'

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
  /**
   * Where an interrupted download left off, so a retry resumes instead of
   * restarting. Present only on 'failed'/'downloading' entries; cleared on 'done'.
   * `tracks` above holds the tracks that fully completed - this describes the one
   * that was in flight when we stopped.
   */
  partial?: PartialTrack
}

/** The in-flight track of an interrupted download, and how to continue it. */
export interface PartialTrack {
  index: number
  /** Absolute uri of the half-written file (rebased on hydrate, like tracks). */
  uri: string
  startOffset: number
  duration: number
  /** Source url, so a resume can rebuild the request without a fresh ABS session. */
  contentUrl: string
  /** expo-file-system resume token (HTTP Range state) from pauseAsync(). */
  resumeData?: string
  /** Bytes already on disk for this track, for progress display before resuming. */
  bytes: number
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

export interface AutoDownloadCandidate {
  itemId: string
  title: string
  author: string
}

/** The subset of a queue entry auto-download needs. Kept structural rather than
 *  importing QueueEntry so this module doesn't depend on the queue's full shape. */
export interface AutoDownloadQueueEntry {
  libraryItemId: string
  title: string
  author?: string
}

/** Sentinel for "no cap - use any available space" (the slider's far right). */
export const UNLIMITED_BYTES = -1

export interface DownloadsState {
  byId: ReadonlyMap<string, DownloadEntry>
  /** Cap on total download bytes; UNLIMITED_BYTES = no cap, 0 = downloads off. */
  maxBytes: number
  auto: AutoDownloadPrefs
}

/** How long a post-connect prefetch waits for the queue sync's pull to land before
 *  giving up on it. Bounded so this never becomes a standing subscription. */
const QUEUE_SETTLE_MS = 30000

/** Minimum gap between download-progress writes to the store.
 *
 *  expo-file-system reports every chunk, which on a fast connection is many
 *  callbacks a second; each one re-renders every subscriber. ~4 updates a second
 *  is smooth for a progress bar and cheap enough that a slow device keeps up. */
const PROGRESS_EMIT_MS = 250

const STORE_KEY = 'hs.downloads.v1'
const DEFAULT_MAX_BYTES = UNLIMITED_BYTES
const DEFAULT_AUTO: AutoDownloadPrefs = { onStart: false, queueAhead: 0, continueListening: true }

let state: DownloadsState = { byId: new Map(), maxBytes: DEFAULT_MAX_BYTES, auto: DEFAULT_AUTO }
const listeners = new Set<() => void>()
// Live resumables, so a download can be cancelled. Not persisted.
const active = new Map<string, DownloadResumable>()
let latestContinueListening: AutoDownloadCandidate[] = []
// The single pending "wait for the queue pull after a reconnect" (see
// applyAutoDownloadsOnReconnect). Module-level so repeat reconnects replace the
// wait instead of stacking subscriptions and timers.
let queueSettleTimer: ReturnType<typeof setTimeout> | null = null
let queueSettleUnsub: (() => void) | null = null

function emit(next: Partial<DownloadsState>): void {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}

function persist(): void {
  const payload = {
    // Cap schema marker: v2 payloads mean maxBytes 0 = downloads off and -1 =
    // unlimited. Absent marker = legacy payload where 0 meant unlimited.
    capV: 2,
    maxBytes: state.maxBytes,
    auto: state.auto,
    // Persist finished downloads (playable) AND interrupted ones (resumable).
    // A 'downloading' entry is written as 'failed': if we're reading it back at
    // all, the process died mid-transfer, so that's what it is on next launch.
    // Its completed tracks + partial-track resume token come along, which is
    // what lets a retry continue instead of restarting from zero.
    items: [...state.byId.values()]
      .filter((e) => e.status === 'done' || e.status === 'failed' || e.status === 'downloading')
      .map((e) => (e.status === 'downloading' ? { ...e, status: 'failed' as const } : e)),
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
      capV?: number
      maxBytes?: number
      auto?: Partial<AutoDownloadPrefs>
      items?: DownloadEntry[]
    }
    const byId = new Map<string, DownloadEntry>()
    // Heal absolute file:// URIs against the current document dir. On iOS the
    // container path changes on every app update/reinstall, so the URIs we
    // persisted point at a dead container path even though the files survive.
    let healed = false
    for (const e of parsed.items ?? []) {
      // Anything not already finished was interrupted mid-transfer (the process
      // died); surface it as failed-but-resumable rather than silently gone.
      const status: DownloadStatus = e.status === 'done' ? 'done' : 'failed'
      const rebased = rebaseEntry({ ...e, status })
      // If nothing survived on disk - no completed tracks AND no partial - the
      // download is truly gone (app data cleared), so drop it rather than claim
      // it's saved. A partial alone is still worth keeping: it's a resume point.
      if (rebased.tracks.length === 0 && !rebased.partial) {
        healed = true
        continue
      }
      if (
        rebased.coverUri !== e.coverUri ||
        rebased.partial?.uri !== e.partial?.uri ||
        rebased.tracks.some((t, i) => t.uri !== e.tracks[i]?.uri)
      ) {
        healed = true
      }
      byId.set(e.itemId, {
        ...rebased,
        error: status === 'failed' ? (e.error ?? 'interrupted') : rebased.error,
      })
    }
    // Migrate legacy payloads (no capV): 0 used to mean "no limit" before it
    // became "downloads off" - carry those users over to the unlimited sentinel.
    let maxBytes = parsed.maxBytes ?? DEFAULT_MAX_BYTES
    if (!parsed.capV && maxBytes <= 0) maxBytes = UNLIMITED_BYTES
    emit({
      byId,
      maxBytes,
      auto: { ...DEFAULT_AUTO, ...(parsed.auto ?? {}) },
    })
    // Rewrite the index with healed URIs so later saves don't reintroduce the
    // stale container path.
    if (healed) persist()
    // Reclaim space from folders no entry points at anymore.
    void sweepOrphanedDownloads(byId)
    // Seed the offline catalog from what we know locally, so downloaded books are
    // browseable offline even before (or without) a richer server-detail backfill.
    // libraryId isn't stored per download; a shared 'offline' placeholder is fine -
    // the Library screen only needs a stable id to mount its list offline.
    void backfillFromDownloads(
      [...byId.values()].map((e) => ({
        id: e.itemId,
        libraryId: 'offline',
        title: e.title,
        author: e.author,
        duration: e.duration,
        addedAt: 0,
      })),
    )
  } catch {
    // start empty on a bad payload
  }
}

function upsert(entry: DownloadEntry): void {
  const byId = new Map(state.byId)
  byId.set(entry.itemId, entry)
  emit({ byId })
}

/**
 * Last path segment of a uri (e.g. "track-0.m4a"), ignoring its directory.
 *
 * Trailing slashes are stripped first: expo-file-system reports DIRECTORY uris
 * with one ("file:///.../downloads/li_abc/") and file uris without, so without
 * the strip a directory would resolve to the empty string.
 */
function baseName(uri: string): string {
  const clean = uri.split('?')[0].replace(/\/+$/, '')
  const slash = clean.lastIndexOf('/')
  return slash >= 0 ? clean.slice(slash + 1) : clean
}

/**
 * Re-point a persisted entry's file URIs at the CURRENT document directory.
 *
 * iOS moves the app's data container to a new UUID path on every update/reinstall,
 * so the absolute file:// URIs we persisted (track uri, coverUri) go stale even
 * though the files themselves survive under Documents. The on-disk layout is
 * deterministic - downloads/<itemId>/<fileName> - so we rebuild each uri from the
 * live document dir plus the file name we stored. Returns the entry with healed
 * URIs, dropping any track/cover whose file is missing under the new path.
 */
function rebaseEntry(entry: DownloadEntry): DownloadEntry {
  const dir = itemDir(entry.itemId)
  const tracks = entry.tracks
    .map((t) => {
      const file = new File(dir, baseName(t.uri))
      return file.exists ? { ...t, uri: file.uri } : null
    })
    .filter((t): t is DownloadedTrack => t !== null)

  let coverUri: string | null = null
  if (entry.coverUri) {
    const coverFile = new File(dir, baseName(entry.coverUri))
    if (coverFile.exists) coverUri = coverFile.uri
  }

  // Heal the resume point the same way. If the half-written file is gone the
  // resume token is meaningless, so drop it and let that track start over -
  // the already-completed tracks are still worth keeping.
  let partial: PartialTrack | undefined
  if (entry.partial) {
    const pf = new File(dir, baseName(entry.partial.uri))
    if (pf.exists) partial = { ...entry.partial, uri: pf.uri, bytes: pf.size ?? 0 }
  }

  return { ...entry, tracks, coverUri, partial }
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
  if (state.maxBytes === 0) return
  const existing = state.byId.get(itemId)
  if (existing && (existing.status === 'done' || existing.status === 'downloading')) return

  // Resume point from an interrupted run, if any: the tracks that finished and
  // the one that was in flight. Retrying a failed download continues from here.
  const priorTracks = existing?.tracks ?? []
  const priorPartial = existing?.partial

  upsert({
    itemId,
    title,
    author,
    status: 'queued',
    progress: existing?.progress ?? 0,
    bytes: existing?.bytes ?? 0,
    coverUri: existing?.coverUri ?? null,
    duration: existing?.duration ?? 0,
    chapters: existing?.chapters ?? [],
    tracks: priorTracks,
    partial: priorPartial,
  })

  let sessionId: string | null = null
  let sessionResumeTime = 0
  let sessionDuration = 0
  try {
    // 'download' gives this session its own deviceId. Without it ABS treats it
    // as the same device as the player and force-closes the live listening
    // session (PlaybackSessionManager.startSession), silently stopping playback
    // mid-listen - the auto-download-while-listening bug.
    const session = await startPlay(itemId, 'download')
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
    // Carry over tracks a previous run already finished, so we neither re-fetch
    // them nor lose them. Keyed by index - track order comes from the session.
    const doneIndexes = new Set(priorTracks.map((t) => t.index))
    const downloaded: DownloadedTrack[] = [...priorTracks]
    let cumulativeBytes = priorTracks.reduce((s, t) => {
      const f = new File(dir, baseName(t.uri))
      return s + (f.exists ? (f.size ?? 0) : 0)
    }, 0)

    for (const track of audioTracks) {
      if (doneIndexes.has(track.index)) continue

      const ext = extFor(track.mimeType, track.contentUrl)
      const dest = new File(dir, `track-${track.index}.${ext}`)
      // Resume this track only if the interrupted run stopped inside THIS one
      // and its half-written file is still on disk.
      const resumeData =
        priorPartial && priorPartial.index === track.index && dest.exists
          ? priorPartial.resumeData
          : undefined
      // A stale partial for a different track (or a vanished file) is dead
      // weight - clear it so we don't try to resume against the wrong file.
      if (!resumeData && dest.exists && priorPartial?.index === track.index) {
        try {
          dest.delete()
        } catch {
          // fall through; the download overwrites it
        }
      }

      // expo-file-system fires this for every chunk written - many times a
      // second on a fast connection. Each call used to patch() -> emit(), which
      // re-renders every subscriber of the downloads store, and on a slow device
      // React gave up: "Maximum update depth exceeded", thrown from the emit
      // inside the progress callback (HS-MOBILEAPP-E, a 2-core Android 11 phone
      // downloading in the background).
      //
      // A download bar does not need more than a few updates a second, so the
      // store write is throttled to PROGRESS_EMIT_MS. The LATEST value is always
      // kept and flushed by the next call past the interval, so the bar cannot
      // freeze mid-download; completion is written by the code after the
      // transfer (which sets progress 1 / done) rather than by a trailing tick,
      // so a dropped final callback costs nothing.
      let lastEmit = 0
      const onProgress = (p: {
        totalBytesWritten: number
        totalBytesExpectedToWrite: number
      }): void => {
        const now = Date.now()
        if (now - lastEmit < PROGRESS_EMIT_MS) return
        lastEmit = now
        const trackFrac =
          p.totalBytesExpectedToWrite > 0 ? p.totalBytesWritten / p.totalBytesExpectedToWrite : 0
        // Weight each track by its share of the book's duration.
        const doneDuration = downloaded.reduce((s, t) => s + t.duration, 0)
        const overall = (doneDuration + trackFrac * track.duration) / totalDuration
        patch(itemId, {
          progress: Math.min(0.999, overall),
          bytes: cumulativeBytes + p.totalBytesWritten,
        })
      }

      const resumable = createDownloadResumable(
        mediaUrl(track.contentUrl),
        dest.uri,
        {},
        onProgress,
        resumeData,
      )
      active.set(itemId, resumable)
      // Record where we are BEFORE the transfer, so a hard kill mid-download
      // still leaves a resume point on disk. There's no token yet on a fresh
      // track, so this alone resumes at the partial file's size; the catch block
      // upgrades it with a real pauseAsync() token when the failure is graceful.
      patch(itemId, {
        partial: {
          index: track.index,
          uri: dest.uri,
          startOffset: track.startOffset,
          duration: track.duration,
          contentUrl: track.contentUrl,
          resumeData,
          bytes: dest.exists ? (dest.size ?? 0) : 0,
        },
      })
      persist()

      const result = resumeData ? await resumable.resumeAsync() : await resumable.downloadAsync()
      active.delete(itemId)
      if (!result) throw new Error('download_cancelled')
      const info = dest.exists ? (dest.size ?? 0) : 0
      cumulativeBytes += info
      downloaded.push({
        index: track.index,
        uri: dest.uri,
        startOffset: track.startOffset,
        duration: track.duration,
      })
      // This track is whole now: fold it into tracks and drop the resume point,
      // then checkpoint. A kill after this resumes at the NEXT track.
      patch(itemId, { tracks: [...downloaded], bytes: cumulativeBytes, partial: undefined })
      persist()
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
      partial: undefined,
      error: undefined,
    })
    persist()

    // Snapshot the book's library metadata (genres, series, narrator, year) so
    // Home / Library / Series can browse it offline. Best-effort: the download
    // itself is already done and plays fine without this.
    try {
      const detail = await getItemDetail(itemId)
      await saveCatalogItem(detail, sessionDuration)
      // If it's part of a series, also capture the WHOLE series' metadata (not
      // audio) so the series page shows the full reading order offline - the
      // undownloaded siblings appear as greyed "not downloaded" skeletons.
      const seriesRef = detail.media.metadata.series?.[0]
      if (seriesRef) {
        const allSeries = await getLibrarySeries(detail.libraryId)
        const match = allSeries.find((s) => s.id === seriesRef.id)
        if (match) await saveSeriesSkeleton(match.id, match.name, match.books ?? [])
      }
    } catch {
      // Rich offline browse for this item is degraded, but playback is intact.
    }
  } catch (e) {
    const resumable = active.get(itemId)
    active.delete(itemId)
    const msg = (e as Error).message
    if (msg === 'download_cancelled') {
      // cancel() already removed the entry + files
    } else {
      // Capture a fresh resume token where we can. On a network drop the
      // resumable is still live, and pauseAsync() yields the exact byte offset
      // to continue from - better than the pre-transfer checkpoint. Best-effort:
      // if it fails we keep the coarser checkpoint already on disk.
      let resumeData: string | undefined
      try {
        resumeData = (await resumable?.pauseAsync())?.resumeData
      } catch {
        // keep the existing checkpoint
      }
      const cur = state.byId.get(itemId)
      patch(itemId, {
        status: 'failed',
        error: msg,
        partial: cur?.partial && resumeData ? { ...cur.partial, resumeData } : cur?.partial,
      })
      persist()
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
  // Drop its offline browse metadata too.
  void removeCatalogItem(itemId)
}

/** True when two chapter lists differ in length, title, or bounds. */
function chaptersDiffer(a: ABSChapter[], b: ABSChapter[]): boolean {
  if (a.length !== b.length) return true
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].title !== b[i].title || a[i].start !== b[i].start || a[i].end !== b[i].end) return true
  }
  return false
}

/**
 * Re-read a downloaded book's metadata from the server and update the cached
 * copy in place. Metadata only - no audio is re-fetched, so this is cheap
 * enough to run on cellular.
 *
 * Chapters, title, and author are snapshotted once at download time, so an edit
 * made on the server afterwards was invisible to this device forever: the
 * download is a no-op once `done`, and playback prefers the local copy
 * unconditionally. This is what closes that gap.
 *
 * Compares CONTENT rather than a timestamp on purpose. ABS's chapter endpoint
 * (POST /api/items/:id/chapters) saves `libraryItem.media` and the metadata
 * file but never marks the libraryItem row itself changed, so `updatedAt` does
 * NOT move on a chapters-only edit - the exact case this exists to catch.
 *
 * Safe to call opportunistically: it no-ops when the book isn't a finished
 * download, and any network failure leaves the cached copy untouched.
 *
 * @returns true when something actually changed on this device.
 */
export async function refreshDownloadMetadata(itemId: string): Promise<boolean> {
  const cur = state.byId.get(itemId)
  if (!cur || cur.status !== 'done') return false

  let detail
  try {
    detail = await getItemDetail(itemId)
  } catch {
    // Offline or the server is unhappy: keep what we have.
    return false
  }

  const meta = detail.media?.metadata
  if (!meta) return false

  const chapters = detail.media?.chapters ?? []
  const title = meta.title || cur.title
  const author = meta.authorName || cur.author

  // Never let a book that legitimately has chapters get blanked by a response
  // that arrived without them.
  const chaptersChanged = chapters.length > 0 && chaptersDiffer(cur.chapters, chapters)
  const changed = chaptersChanged || title !== cur.title || author !== cur.author

  if (changed) {
    patch(itemId, {
      title,
      author,
      ...(chaptersChanged ? { chapters } : {}),
    })
  }

  // Refresh the browse metadata (genres, series, narrator, published year) too,
  // which is frozen at download time for the same reason. Keep the duration we
  // already measured - the detail response has no top-level duration field.
  try {
    await saveCatalogItem(detail, cur.duration)
  } catch {
    // Catalog is a browse convenience; a failure here doesn't undo the above.
  }

  return changed
}

/**
 * Delete download folders with no entry in the index.
 *
 * Interrupted downloads used to vanish from the index while their half-written
 * files stayed on disk, so those bytes were unreclaimable and invisible to the
 * storage meter. Entries now survive a kill, but a folder can still be orphaned
 * (index dropped as unrecoverable at hydrate, a failed delete). Runs after
 * hydrate, once, best-effort.
 *
 * Takes the hydrated index as an argument rather than reading `state`: this
 * deletes files, so what counts as "kept" must be passed in explicitly instead
 * of depending on the caller having already emitted its map.
 */
async function sweepOrphanedDownloads(keep: ReadonlyMap<string, DownloadEntry>): Promise<void> {
  try {
    const root = new Directory(Paths.document, 'downloads')
    if (!root.exists) return
    for (const child of root.list()) {
      if (!(child instanceof Directory)) continue
      // Folder name is the itemId (see itemDir). Directory uris carry a trailing
      // slash, which baseName() strips; before it did, every folder here resolved
      // to '', matched no entry, and so every downloaded book on the device was
      // deleted on the first launch after it was saved. The empty-name guard is
      // the second line of defence: a name we can't read is not evidence the
      // folder is garbage.
      const itemId = baseName(child.uri)
      if (!itemId || keep.has(itemId)) continue
      try {
        child.delete()
      } catch {
        // leave it; next sweep retries
      }
    }
  } catch {
    // listing unavailable - nothing to reclaim this launch
  }
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
  const wasContinueListening = state.auto.continueListening
  emit({ auto: { ...state.auto, ...patch } })
  persist()
  if (!wasContinueListening && state.auto.continueListening) {
    applyAutoDownloads({ continueListening: latestContinueListening })
  }
}

/** Kick off a download only if the item isn't already downloaded/in flight and
 *  the size cap (if any) isn't already exceeded. Silent - for auto-download. */
export function autoDownload(itemId: string, title: string, author: string): void {
  const cur = state.byId.get(itemId)
  if (cur && (cur.status === 'done' || cur.status === 'downloading' || cur.status === 'queued'))
    return
  if (state.maxBytes === 0) return
  if (state.maxBytes > 0 && totalBytes() >= state.maxBytes) return
  void downloadItem(itemId, title, author)
}

/** Whether downloads are allowed at all (storage cap isn't set to Off). */
export function downloadsAllowed(): boolean {
  return state.maxBytes !== 0
}

/**
 * Apply the auto-download preferences given the current playing item and the
 * up-next queue. Called from the play path and on queue changes. Continue-
 * Listening items are passed in by the caller (Home has that list).
 */
export function applyAutoDownloads(input: {
  nowPlaying?: { itemId: string; title: string; author: string } | null
  queue?: AutoDownloadQueueEntry[]
  continueListening?: AutoDownloadCandidate[]
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

/** Update the latest Continue Listening shelf snapshot and apply it immediately
 * when that auto-download preference is enabled. */
export function setAutoDownloadContinueListening(items: AutoDownloadCandidate[]): void {
  latestContinueListening = items
  applyAutoDownloads({ continueListening: latestContinueListening })
}

/**
 * Re-apply the auto-download prefs now that a server is reachable again.
 *
 * downloadItem() needs an ABS play session to enumerate tracks, so prefetch is
 * inherently online-only - which means the trip that most needs it (drive out of
 * signal and come back) is exactly the one that never got it. Every other trigger
 * is a user action (starting a book, toggling a pref) or a queue change, so a
 * reconnect could leave "keep the next N downloaded" unhonored indefinitely.
 *
 * The queue is the wrinkle: the connect flow starts its queue sync in the same
 * breath, and that pull is asynchronous, so `items` is still empty the instant
 * connect finishes. Rather than poll for it, apply twice - once immediately (so
 * onStart/continueListening prefetch doesn't wait on a network round-trip that
 * may never land) and once more on the first queue change, which is the queue
 * sync's pull arriving. The second pass is a ONE-SHOT subscription that also
 * self-cancels on a timer, so a connect against a server whose queue never
 * changes leaves nothing subscribed and nothing running.
 *
 * Safe to call on every connect: autoDownload() no-ops for done/downloading/
 * queued items and honors the size cap, so repeats can't double-download.
 */
export function applyAutoDownloadsOnReconnect(queueItems: () => AutoDownloadQueueEntry[]): void {
  // Nothing to do at all when the user has storage set to Off, or hasn't enabled
  // any prefetch pref - don't arm a subscription for it.
  const { auto } = state
  if (!downloadsAllowed()) return
  if (!auto.queueAhead && !auto.continueListening) return

  applyAutoDownloads({ queue: queueItems(), continueListening: latestContinueListening })
  if (!auto.queueAhead) return

  // Only ever one pending wait: reconnects can fire in bursts (a NetInfo edge, a
  // foreground probe, and a Clerk flip can all land together), and arming a fresh
  // subscription + timer per call would stack them.
  cancelQueueSettleWait()
  const settle = () => {
    cancelQueueSettleWait()
  }
  // The pull may legitimately produce no change (queue unchanged since last run),
  // so the wait has to end on its own rather than linger for the session.
  queueSettleTimer = setTimeout(settle, QUEUE_SETTLE_MS)
  queueSettleUnsub = subscribeQueue(() => {
    settle()
    applyAutoDownloads({ queue: queueItems() })
  })
}

/** Tear down any pending post-connect queue wait (see above). */
function cancelQueueSettleWait(): void {
  if (queueSettleTimer) {
    clearTimeout(queueSettleTimer)
    queueSettleTimer = null
  }
  queueSettleUnsub?.()
  queueSettleUnsub = null
}

/**
 * Build a NowPlaying-shaped source from a completed download, or null if the
 * item isn't downloaded. Used by playback to prefer local files when offline.
 *
 * The first track is checked against the disk rather than trusted from the
 * index, because an entry can outlive its files (an OS storage reclaim, a
 * partial delete). Handing the player a uri with nothing behind it fails the
 * load with no fallback - the book just won't play - so a missing file drops
 * the entry instead: the UI stops claiming the book is saved, auto-download can
 * fetch it again, and this listen streams. One stat per play.
 */
export function localSourceFor(itemId: string): DownloadEntry | null {
  const e = state.byId.get(itemId)
  if (!e || e.status !== 'done' || e.tracks.length === 0) return null
  try {
    if (!new File(e.tracks[0].uri).exists) {
      void deleteDownload(itemId)
      return null
    }
  } catch {
    // Can't stat: trust the index. Refusing to play here would break offline
    // playback on any device that won't answer the question.
    return e
  }
  return e
}

/** Local file uri of a downloaded book's cover, or null. Covers show offline
 *  (and save a network round-trip online) by reading the saved cover.jpg. */
export function localCoverFor(itemId: string): string | null {
  return state.byId.get(itemId)?.coverUri ?? null
}
