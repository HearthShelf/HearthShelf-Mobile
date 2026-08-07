/**
 * Discover backend client. Same direct-origin convention as subscriptions.ts /
 * absAudible.ts: the connected server's own /hs surface with the per-user ABS
 * bearer token.
 *
 * The monthly AI shelf, per-item feedback, and the server-wide popular signals.
 * Every call swallows errors into a neutral value so Discover never breaks - it
 * degrades to the deterministic, offline-capable base shelves that
 * buildDiscoverShelves() produces from the library alone.
 */
import { getSession } from './session'
import type {
  DiscoverSummary,
  DiscoverCandidate,
  HSDiscoverVote,
  HSDiscoverFeedback,
  HSDiscoverFeedbackMap,
  HSDiscoverPick,
  HSDiscoverShelf,
  HSDiscoverPopularItem,
} from '@hearthshelf/core'

export type DiscoverVote = HSDiscoverVote
export type DiscoverFeedbackEntry = HSDiscoverFeedback
export type DiscoverFeedbackMap = HSDiscoverFeedbackMap
export type MonthlyPick = HSDiscoverPick
export type MonthlyShelf = HSDiscoverShelf
export type PopularItem = HSDiscoverPopularItem

const EMPTY_SHELF: MonthlyShelf = { month: '', engine: 'none', intro: '', picks: [] }

async function dFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const s = getSession()
  if (!s) throw new Error('not_connected')
  const res = await fetch(`${s.serverUrl}/hs/discover${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.token}`,
      ...options.headers,
    },
  })
  if (!res.ok) throw new Error(`Discover ${res.status}`)
  return (await res.json()) as T
}

/**
 * Fetch-or-generate the month's AI shelf. The backend returns the cached shelf
 * if one exists for this user+month, otherwise generates it from the posted
 * summary + candidates (once per month). Empty shelf on any failure.
 */
export async function getMonthlyShelf(
  summary: DiscoverSummary,
  candidates: DiscoverCandidate[],
): Promise<MonthlyShelf> {
  if (!candidates.length) return EMPTY_SHELF
  try {
    return await dFetch<MonthlyShelf>('', {
      method: 'POST',
      body: JSON.stringify({ summary, candidates }),
    })
  } catch {
    return EMPTY_SHELF
  }
}

export async function getDiscoverFeedback(): Promise<DiscoverFeedbackMap> {
  try {
    const r = await dFetch<{ feedback: DiscoverFeedbackMap }>('/feedback')
    return r.feedback ?? {}
  } catch {
    return {}
  }
}

export async function setDiscoverFeedback(
  itemKey: string,
  fb: { vote?: DiscoverVote | null; rating?: number | null },
): Promise<DiscoverFeedbackMap> {
  try {
    const r = await dFetch<{ feedback: DiscoverFeedbackMap }>('/feedback', {
      method: 'POST',
      body: JSON.stringify({ itemKey, ...fb }),
    })
    return r.feedback ?? {}
  } catch {
    return {}
  }
}

export async function getPopular(): Promise<PopularItem[]> {
  try {
    const r = await dFetch<{ items: PopularItem[] }>('/popular')
    return r.items ?? []
  } catch {
    return []
  }
}
