/**
 * Server parts for books too big for the Android player to open.
 *
 * Media3 reads an MP4's whole sample table into memory before it plays a
 * second of it. For a 70-hour single-file .m4b that table outgrew the heap -
 * OutOfMemoryError, even with largeHeap, on a Pixel 10 Pro XL (HS-MOBILEAPP-44).
 * The HearthShelf server can serve such a book as a run of ordinary small .m4a
 * parts (GET /hs/parts/:itemId), and the player plays those back to back on one
 * book timeline.
 *
 * This module is the one place that asks, and it remembers the answer per book
 * so a play, a download and a migration of the same book cost one request.
 *
 * Android only: the iOS player does not have the problem, and it plays a single
 * url per book.
 */
import { Platform } from 'react-native'
import { getParts, mediaUrl, type HSPart } from '@/api/abs'
import { getSession } from '@/api/session'
import { breadcrumb } from '@/lib/crashLog'
import type { PlayTrack } from './store'

/** How long a book's answer is trusted. Parts only change when the file does. */
const PARTS_CACHE_MS = 6 * 60 * 60 * 1000

/** How long an older server (no parts route) is left alone before asking again,
 *  so it costs one request an hour rather than one per play. */
const UNSUPPORTED_RETRY_MS = 60 * 60 * 1000

interface Cached {
  parts: HSPart[] | null
  at: number
}

const cache = new Map<string, Cached>()
const inFlight = new Map<string, Promise<HSPart[] | null>>()
let unsupported: { server: string; at: number } | null = null

/**
 * The parts the server offers for this book, or null for "play the files as
 * usual" - no parts for this book, an older server, iOS, no connection, or the
 * request failed. Never throws.
 *
 * A failed request is not remembered, so the next play asks again.
 */
export async function partsFor(itemId: string): Promise<HSPart[] | null> {
  if (Platform.OS !== 'android') return null
  const session = getSession()
  if (!session) return null
  const server = session.serverUrl
  const key = `${server}|${itemId}`
  const now = Date.now()

  const hit = cache.get(key)
  if (hit && now - hit.at < PARTS_CACHE_MS) return hit.parts
  if (unsupported && unsupported.server === server && now - unsupported.at < UNSUPPORTED_RETRY_MS) {
    return null
  }

  const pending = inFlight.get(key)
  if (pending) return pending

  const ask = (async (): Promise<HSPart[] | null> => {
    try {
      const answer = await getParts(itemId)
      if (answer.kind === 'unsupported') {
        unsupported = { server, at: Date.now() }
        return null
      }
      const parts = answer.kind === 'parts' ? answer.parts : null
      cache.set(key, { parts, at: Date.now() })
      if (parts) breadcrumb('play', `server offers ${parts.length} parts for ${itemId.slice(0, 8)}`)
      return parts
    } catch {
      return null
    } finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, ask)
  return ask
}

/**
 * The server could not provide this book's parts when the player asked (it
 * could not cut one, or says the book no longer needs them). Forget them for a
 * while, so the next load plays the book's own file.
 */
export function markPartsFailed(itemId: string): void {
  const session = getSession()
  if (!session) return
  cache.set(`${session.serverUrl}|${itemId}`, { parts: null, at: Date.now() })
}

/** Parts already asked to be prepared, with when, so each is asked for once. */
const prepared = new Map<string, number>()
/** How long one prepare request is trusted to have done its job. */
const PREPARE_AGAIN_MS = 10 * 60 * 1000
/** Ask for the next part this long before the current one ends. The server
 *  needs a few minutes to cut a four-hour part it has not cached. */
const PREPARE_AHEAD_SEC = 15 * 60

/**
 * Ask the server to start cutting a part now (GET /hs/parts/:id?prepare=<i>),
 * so the player's first request for it does not sit behind a cold cut. Fire
 * and forget; a failure only loses the head start.
 */
export function preparePart(itemId: string, index: number): void {
  if (Platform.OS !== 'android' || index < 0) return
  const key = `${itemId}|${index}`
  const at = prepared.get(key)
  if (at && Date.now() - at < PREPARE_AGAIN_MS) return
  prepared.set(key, Date.now())
  void getParts(itemId, index).catch(() => {})
}

/** The index of the part holding a book position, or -1. */
export function partIndexAt(parts: HSPart[], position: number): number {
  let idx = -1
  for (let i = 0; i < parts.length; i += 1) if (position >= parts[i].start) idx = i
  return idx
}

/**
 * Called with each position tick of a book playing from server parts: once the
 * listener is within PREPARE_AHEAD_SEC of the end of the current part, ask for
 * the next one.
 */
export function prepareAheadOf(itemId: string, tracks: PlayTrack[], position: number): void {
  if (!isPartsSource(tracks)) return
  let idx = -1
  for (let i = 0; i < tracks.length; i += 1) if (position >= tracks[i].startOffset) idx = i
  const cur = tracks[idx]
  if (!cur || idx + 1 >= tracks.length) return
  if (cur.startOffset + cur.duration - position > PREPARE_AHEAD_SEC) return
  // Tracks and parts are the same list in the same order, so the track index is
  // the part's position; the server's own index is on the cached list.
  const parts = cachedParts(itemId)
  preparePart(itemId, parts?.[idx + 1]?.index ?? idx + 1)
}

/** The cached parts for a book, without asking the server. */
function cachedParts(itemId: string): HSPart[] | null {
  const session = getSession()
  if (!session) return null
  return cache.get(`${session.serverUrl}|${itemId}`)?.parts ?? null
}

/** Parts as player tracks, with the token-bearing url the player can fetch. */
export function partTracks(parts: HSPart[]): PlayTrack[] {
  return parts.map((p) => ({ url: mediaUrl(p.url), startOffset: p.start, duration: p.duration }))
}

/** Whether a loaded track list is server parts rather than the book's files. */
export function isPartsSource(tracks: PlayTrack[] | undefined): boolean {
  return !!tracks?.some((t) => t.url.includes('/hs/parts/'))
}
