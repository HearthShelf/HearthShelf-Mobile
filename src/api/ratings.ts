/**
 * The user's own 1-5 star book ratings. Same direct-origin convention as
 * discover.ts: the connected server's /hs surface with the per-user ABS bearer.
 *
 * Ratings used to ride along inside Discover feedback. They are their own thing
 * now (server: /hs/ratings, shared contract: HSRatingMap in @hearthshelf/core),
 * because a rating is a statement about a BOOK that belongs on the book page and
 * in exports, whereas a Discover vote is a statement about a RECOMMENDATION.
 * Tying them together meant you could not rate a book you had not been
 * recommended.
 *
 * UNLIKE discover.ts, failures here are NOT swallowed into a neutral value. A
 * rating write that quietly failed would leave the optimistic UI showing a score
 * the server never stored - so writes throw and the caller rolls back. Reads
 * still degrade to an empty map, since a missing rating renders as "unrated"
 * and that is honest.
 */
import { getSession } from './session'
import type { HSRatingMap } from '@hearthshelf/core'

export type RatingMap = HSRatingMap

async function rFetch<T>(options: RequestInit = {}, path = '/hs/ratings'): Promise<T> {
  const s = getSession()
  if (!s) throw new Error('not_connected')
  const res = await fetch(`${s.serverUrl}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.token}`,
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`Ratings ${res.status}`)
  return (await res.json()) as T
}

/** Every rating this user has set, keyed by item. Empty map on failure. */
export async function getRatings(): Promise<RatingMap> {
  try {
    const r = await rFetch<{ ratings: RatingMap }>()
    return r.ratings ?? {}
  } catch {
    return {}
  }
}

/** Set or clear (rating: null) one rating. Throws so the caller can roll back. */
export async function setRating(itemKey: string, rating: number | null): Promise<RatingMap> {
  const r = await rFetch<{ ratings: RatingMap }>({
    method: 'PUT',
    body: JSON.stringify({ itemKey, rating }),
  })
  return r.ratings ?? {}
}

/**
 * Record "Skip rating" for a book so nothing asks about it again.
 *
 * Separate from dismissing the notification: the notification row is what the
 * prompt job dedupes against, so deleting it alone would let the next hourly
 * pass recreate the prompt. Best-effort - a failed skip costs at most one
 * repeat prompt, which is not worth blocking the dismissal over.
 */
export async function skipRatingPrompt(itemKey: string): Promise<void> {
  try {
    await rFetch<{ ok: boolean }>(
      { method: 'POST', body: JSON.stringify({ itemKey }) },
      '/hs/rating-prompts/skip',
    )
  } catch {
    // Swallowed on purpose; see above.
  }
}
