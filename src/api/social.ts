/**
 * Social API client - cross-user reads served by the HearthShelf backend from
 * ABS's database (see HearthShelf docs/social.md, docs/social-stats.md). Same
 * convention as getHSStats in abs.ts: direct fetch to the connected server's
 * origin with the ABS bearer, degrading to an unavailable/empty shape on
 * network failure or a 404 (older server without this route) so the UI can
 * hide the feature instead of erroring.
 */
import type {
  HSLeaderboardResponse,
  HSFinishedByResponse,
  HSListeningNowResponse,
  HSListeningNowBulkResponse,
  HSCompareResponse,
  LeaderboardWindow,
} from '@hearthshelf/core'
import { getSession } from './session'

const UNAVAILABLE_LEADERBOARD: HSLeaderboardResponse = { available: false, me: null, entries: [] }
const UNAVAILABLE_FINISHED_BY: HSFinishedByResponse = { available: false, users: [] }
const UNAVAILABLE_LISTENING_NOW: HSListeningNowResponse = { available: false, users: [] }
const UNAVAILABLE_LISTENING_NOW_BULK: HSListeningNowBulkResponse = { available: false, byItem: {} }
const UNAVAILABLE_COMPARE: HSCompareResponse = {
  available: false,
  scope: 'server',
  me: { booksFinished: 0, secondsListened: 0, activeDays: null },
  target: { booksFinished: 0, secondsListened: 0, activeDays: null },
}

/** Instance-wide community defaults, plus whether the caller may edit them
 *  (admin). Used so the presence-sharing toggle can show the inherited default
 *  the user follows when they've made no explicit choice. */
export interface CommunityConfig {
  /** Default reading-list sharing (opt-out on by default). */
  defaultShare: boolean
  /** Default presence sharing (ships OFF - more sensitive than a reading list). */
  defaultShareListening: boolean
  notesEnabled: boolean
  clubsEnabled: boolean
  canEdit: boolean
}

const DEFAULT_COMMUNITY_CONFIG: CommunityConfig = {
  defaultShare: true,
  defaultShareListening: false,
  notesEnabled: true,
  clubsEnabled: true,
  canEdit: false,
}

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

/**
 * Compare the caller's listening totals against a target: the whole-server
 * per-user average (default, no identity leaked) or one opted-in user
 * (`opts.userId`, drawn only from the leaderboard's privacy-filtered roster).
 * `tz` (minutes) buckets the year window caller-local, matching /hs/stats.
 *
 * Degrades to a neutral unavailable response on ANY failure/older server, and
 * when the server reports available:false - so the Stats screen hides the
 * Compare card rather than erroring. The user variant 403s server-side when the
 * target isn't shareable, which also lands here as unavailable.
 */
export async function getCompare(opts: { userId?: string } = {}): Promise<HSCompareResponse> {
  const session = getSession()
  if (!session) return UNAVAILABLE_COMPARE
  const { serverUrl, token } = session
  const params = new URLSearchParams()
  params.set('tz', String(new Date().getTimezoneOffset()))
  if (opts.userId) params.set('userId', opts.userId)
  try {
    const res = await fetch(`${serverUrl}/hs/social/compare?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return UNAVAILABLE_COMPARE
    const data = (await res.json()) as HSCompareResponse
    if (!data || data.available !== true || !data.me || !data.target) return UNAVAILABLE_COMPARE
    return data
  } catch {
    return UNAVAILABLE_COMPARE
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

/**
 * Who's actively (recently) listening to one book. The server filters by the
 * shareCurrentlyListening presence resolution (default OFF). Label the UI
 * "listening recently", not "online". Degrades to unavailable/empty.
 */
export async function getListeningNow(libraryItemId: string): Promise<HSListeningNowResponse> {
  const session = getSession()
  if (!session) return UNAVAILABLE_LISTENING_NOW
  const { serverUrl, token } = session
  const q = `?libraryItemId=${encodeURIComponent(libraryItemId)}`
  try {
    const res = await fetch(`${serverUrl}/hs/social/listening-now${q}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return UNAVAILABLE_LISTENING_NOW
    return (await res.json()) as HSListeningNowResponse
  } catch {
    return UNAVAILABLE_LISTENING_NOW
  }
}

/**
 * Listening-now for many items at once (shelf badges). The id list is capped
 * server-side at 100. Degrades to unavailable/empty.
 */
export async function getListeningNowBulk(
  libraryItemIds: string[],
): Promise<HSListeningNowBulkResponse> {
  const session = getSession()
  if (!session || libraryItemIds.length === 0) return UNAVAILABLE_LISTENING_NOW_BULK
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/social/listening-now`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ libraryItemIds: libraryItemIds.slice(0, 100) }),
    })
    if (!res.ok) return UNAVAILABLE_LISTENING_NOW_BULK
    return (await res.json()) as HSListeningNowBulkResponse
  } catch {
    return UNAVAILABLE_LISTENING_NOW_BULK
  }
}

/**
 * The instance's community defaults, so the presence-sharing toggle can show the
 * inherited default. Degrades to a sensible default shape (presence OFF, notes/
 * clubs on) on any failure so the settings screen still renders.
 */
export async function getCommunityConfig(): Promise<CommunityConfig> {
  const session = getSession()
  if (!session) return DEFAULT_COMMUNITY_CONFIG
  const { serverUrl, token } = session
  try {
    const res = await fetch(`${serverUrl}/hs/social/community-config`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return DEFAULT_COMMUNITY_CONFIG
    return { ...DEFAULT_COMMUNITY_CONFIG, ...((await res.json()) as Partial<CommunityConfig>) }
  } catch {
    return DEFAULT_COMMUNITY_CONFIG
  }
}
