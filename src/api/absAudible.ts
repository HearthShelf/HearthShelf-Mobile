/**
 * HearthShelf Audible series lookup for mobile. Like the rest of the mobile ABS
 * client (abs.ts), this talks DIRECTLY to the connected server's origin with the
 * per-user ABS bearer token - the /hs/audible/* surface lives on the same origin
 * as ABS. ABS exposes no series ASIN, so the backend resolves it and returns the
 * series' child books ordered by sequence. Degrades to an unresolved result on
 * any failure so the series screen quietly omits the "missing books" surface.
 */
import { getSession } from './session'
import type { HSAudibleSeriesResponse } from '@hearthshelf/core'

// Module-level cache of resolved series rosters, keyed by lowercased name. The
// backend already caches these ~10min, but the mobile screen re-fetches on every
// open - without this, the "you're missing books" state pops in a second late
// each time. A cache hit lets the screen paint the missing rows immediately.
// Survives navigation for the app's lifetime; cleared on sign-out (clearAudibleCache).
const TTL_MS = 30 * 60 * 1000
const cache = new Map<string, { at: number; value: HSAudibleSeriesResponse }>()

/** Synchronous cache peek so a screen can seed its missing state on first paint
 *  (no round-trip flash). Null when absent or stale. */
export function peekAudibleSeries(name: string): HSAudibleSeriesResponse | null {
  const hit = cache.get(name.trim().toLowerCase())
  if (!hit || Date.now() - hit.at > TTL_MS) return null
  return hit.value
}

export function clearAudibleCache(): void {
  cache.clear()
}

/**
 * Fetch a series' full Audible roster by name. Returns an unresolved result
 * (`seriesAsin: null, books: []`) on any failure - disconnected, slim deploy
 * without /hs/audible, or no confident series match. Successful (resolved)
 * responses are cached in-process; unresolved results are not, so a transient
 * failure doesn't stick.
 */
export async function fetchAudibleSeries(name: string): Promise<HSAudibleSeriesResponse> {
  const empty: HSAudibleSeriesResponse = { name, seriesAsin: null, books: [] }
  const s = getSession()
  if (!s || name.trim().length < 2) return empty
  const key = name.trim().toLowerCase()
  const cached = peekAudibleSeries(name)
  if (cached) return cached
  try {
    const res = await fetch(`${s.serverUrl}/hs/audible/series?q=${encodeURIComponent(name)}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${s.token}` },
    })
    if (!res.ok) return empty
    const value = (await res.json()) as HSAudibleSeriesResponse
    if (value.seriesAsin) cache.set(key, { at: Date.now(), value })
    return value
  } catch {
    return empty
  }
}

// A plain Audible store link for a missing book, opened in the browser when the
// request backend isn't connected.
export function audibleStoreUrl(book: { asin?: string; title: string; author: string }): string {
  if (book.asin) return `https://www.audible.com/pd/${book.asin}`
  return (
    'https://www.audible.com/search?keywords=' + encodeURIComponent(`${book.title} ${book.author}`)
  )
}
