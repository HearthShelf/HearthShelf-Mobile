/**
 * HearthShelf Audible series lookup for mobile. Like the rest of the mobile ABS
 * client (abs.ts), this talks DIRECTLY to the connected server's origin with the
 * per-user ABS bearer token - the /hs/audible/* surface lives on the same origin
 * as ABS. ABS exposes no series ASIN, so the backend resolves it and returns the
 * series' child books ordered by sequence. Degrades to an unresolved result on
 * any failure so the series screen quietly omits the "missing books" surface.
 */
import { getSession } from './session'
import type {
  HSAudibleSearchResponse,
  HSAudibleSearchResult,
  HSAudibleSeriesResponse,
} from '@hearthshelf/core'

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

/**
 * Fetch a series' roster by its Audible series ASIN. What a series follow holds
 * is the ASIN, not a name, so this is how the Following list learns which book
 * is next in a series being tracked.
 *
 * Served from the precomputed roster only (no live Audible resolve), so an older
 * server - or a series the nightly sweep hasn't reached - returns an unresolved
 * result and the caller quietly shows the follow without a next-book line.
 */
export async function fetchAudibleSeriesByAsin(
  seriesAsin: string,
): Promise<HSAudibleSeriesResponse> {
  const empty: HSAudibleSeriesResponse = { name: '', seriesAsin: null, books: [] }
  const s = getSession()
  if (!s || !seriesAsin) return empty
  const key = `asin:${seriesAsin.toLowerCase()}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  try {
    const res = await fetch(
      `${s.serverUrl}/hs/audible/series?seriesAsin=${encodeURIComponent(seriesAsin)}`,
      { headers: { Accept: 'application/json', Authorization: `Bearer ${s.token}` } },
    )
    if (!res.ok) return empty
    const value = (await res.json()) as HSAudibleSeriesResponse
    if (value.seriesAsin) cache.set(key, { at: Date.now(), value })
    return value
  } catch {
    return empty
  }
}

/**
 * Search the Audible catalog by keyword through the connected server's
 * HearthShelf backend. Works whether or not the request backend is connected -
 * discovery is HearthShelf's own. Returns an empty result on any failure
 * (disconnected, slim deploy without /hs/audible) so the search screen's "Not in
 * your library" section quietly hides.
 */
export async function searchAudible(query: string, page = 1): Promise<HSAudibleSearchResponse> {
  const empty: HSAudibleSearchResponse = {
    query,
    results: [],
    totalResults: 0,
    page,
    hasMore: false,
  }
  const s = getSession()
  if (!s || query.trim().length < 2) return empty
  try {
    const res = await fetch(
      `${s.serverUrl}/hs/audible/search?q=${encodeURIComponent(query)}&page=${page}`,
      { headers: { Accept: 'application/json', Authorization: `Bearer ${s.token}` } },
    )
    if (!res.ok) return empty
    return (await res.json()) as HSAudibleSearchResponse
  } catch {
    return empty
  }
}

/** Fetch a single Audible product by ASIN (for the upcoming-book page reached
 *  fresh, e.g. from a push deep-link). null on any failure. */
export async function fetchAudibleProduct(asin: string): Promise<HSAudibleSearchResult | null> {
  const s = getSession()
  if (!s || !asin) return null
  try {
    const res = await fetch(`${s.serverUrl}/hs/audible/product?asin=${encodeURIComponent(asin)}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${s.token}` },
    })
    if (!res.ok) return null
    return (await res.json()) as HSAudibleSearchResult
  } catch {
    return null
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

/** Owned/total counts for one series, as the library list reads them. */
export interface SeriesGapSummary {
  seriesId: string
  /** Books in the series after phantom/duplicate filtering, released or not. */
  total: number
  /** Released books the library doesn't hold. Excludes unreleased ones - nobody
   *  could own those, and counting them would leave a caught-up series
   *  permanently incomplete. */
  missing: number
  /** Books announced but not out yet. */
  upcoming: number
  resolvedAt: number
}

/**
 * Gap counts for every series the nightly sweep has resolved, in ONE request.
 *
 * The series list needs one fact per row for hundreds of rows, so this returns
 * counts only - fetching the rosters themselves would be megabytes to render a
 * badge, and one request per row would be worse. Series the sweep hasn't reached
 * are simply absent, and those rows render as they did before.
 *
 * Degrades to an empty list on any failure (offline, slim deploy, Audible turned
 * off): the counts are decoration, and the library must still render without
 * them.
 */
export async function fetchSeriesGapSummaries(): Promise<SeriesGapSummary[]> {
  const s = getSession()
  if (!s) return []
  try {
    const res = await fetch(`${s.serverUrl}/hs/audible/series-summary`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${s.token}` },
    })
    if (!res.ok) return []
    const body = (await res.json()) as { series?: SeriesGapSummary[] }
    return body.series ?? []
  } catch {
    return []
  }
}
