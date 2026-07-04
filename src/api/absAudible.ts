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

/**
 * Fetch a series' full Audible roster by name. Returns an unresolved result
 * (`seriesAsin: null, books: []`) on any failure - disconnected, slim deploy
 * without /hs/audible, or no confident series match.
 */
export async function fetchAudibleSeries(name: string): Promise<HSAudibleSeriesResponse> {
  const empty: HSAudibleSeriesResponse = { name, seriesAsin: null, books: [] }
  const s = getSession()
  if (!s || name.trim().length < 2) return empty
  try {
    const res = await fetch(`${s.serverUrl}/hs/audible/series?q=${encodeURIComponent(name)}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${s.token}` },
    })
    if (!res.ok) return empty
    return (await res.json()) as HSAudibleSeriesResponse
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
