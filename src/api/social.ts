/**
 * Social API client - cross-user reads served by the HearthShelf backend from
 * ABS's database (see HearthShelf docs/social.md, docs/social-stats.md). Same
 * convention as getHSStats in abs.ts: direct fetch to the connected server's
 * origin with the ABS bearer, degrading to an unavailable/empty shape on
 * network failure or a 404 (older server without this route) so the UI can
 * hide the feature instead of erroring.
 */
import type { HSLeaderboardResponse, HSFinishedByResponse, LeaderboardWindow } from '@hearthshelf/core'
import { getSession } from './session'

const UNAVAILABLE_LEADERBOARD: HSLeaderboardResponse = { available: false, me: null, entries: [] }
const UNAVAILABLE_FINISHED_BY: HSFinishedByResponse = { available: false, users: [] }

export async function getLeaderboard(window?: LeaderboardWindow): Promise<HSLeaderboardResponse> {
  const session = getSession()
  if (!session) return UNAVAILABLE_LEADERBOARD
  const { serverUrl, token } = session
  const q = window ? `?window=${encodeURIComponent(window)}` : ''
  try {
    const res = await fetch(`${serverUrl}/hs/social/leaderboard${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return UNAVAILABLE_LEADERBOARD
    return (await res.json()) as HSLeaderboardResponse
  } catch {
    return UNAVAILABLE_LEADERBOARD
  }
}

export async function getFinishedBy(libraryItemId: string): Promise<HSFinishedByResponse> {
  const session = getSession()
  if (!session) return UNAVAILABLE_FINISHED_BY
  const { serverUrl, token } = session
  const q = `?libraryItemId=${encodeURIComponent(libraryItemId)}`
  try {
    const res = await fetch(`${serverUrl}/hs/social/finished-by${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return UNAVAILABLE_FINISHED_BY
    return (await res.json()) as HSFinishedByResponse
  } catch {
    return UNAVAILABLE_FINISHED_BY
  }
}
