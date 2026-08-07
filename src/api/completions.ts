/**
 * Finished-books history against the connected HearthShelf server.
 *
 * Lives under /hs/completions on the same origin as ABS, with the same bearer
 * token as the rest of mobile (see absRmab.ts for the same shape).
 *
 * The `available` flag is load-bearing and must not be collapsed into an empty
 * list: false means this server cannot provide completion data at all (the ABS
 * database is not mounted), which is a different thing to tell a listener than
 * "you have not finished anything yet". Any transport failure degrades the same
 * way rather than throwing, so the Books view can always render one of those two
 * honest states.
 */
import type { HSCompletion, HSCompletionsResponse } from '@hearthshelf/core'
import { getSession } from './session'

export type { HSCompletion }

const UNAVAILABLE: HSCompletionsResponse = { available: false, total: 0, rows: [] }

export async function getCompletionsPage(offset = 0, limit = 25): Promise<HSCompletionsResponse> {
  const s = getSession()
  if (!s) return UNAVAILABLE
  try {
    const res = await fetch(`${s.serverUrl}/hs/completions?limit=${limit}&offset=${offset}`, {
      headers: {
        Authorization: `Bearer ${s.token}`,
        Accept: 'application/json',
      },
    })
    if (!res.ok) return UNAVAILABLE
    const data = (await res.json()) as Partial<HSCompletionsResponse>
    return {
      available: data.available === true,
      total: Number(data.total) || 0,
      rows: Array.isArray(data.rows) ? data.rows : [],
    }
  } catch {
    return UNAVAILABLE
  }
}
