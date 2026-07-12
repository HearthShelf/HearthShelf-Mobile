/**
 * Auto-source dismissals sync client. A per-user "not right now" list of series
 * and books hidden from the Auto up-next queue and the Continue-* home shelves.
 * Lives server-side (keyed by ABS user id) so it follows the user across
 * devices; src/store/dismissals.ts is the in-memory cache. Same direct-origin
 * convention as api/queue.ts.
 */
import { getSession } from './session'
import type { Dismissals } from '@hearthshelf/core'

function requireSession() {
  const s = getSession()
  if (!s) throw new Error('not_connected')
  return s
}

/** The user's current dismissals { seriesIds, itemIds }. */
export async function getDismissals(): Promise<Dismissals> {
  const { serverUrl, token } = requireSession()
  const res = await fetch(`${serverUrl}/hs/dismissals`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`dismissals ${res.status}`)
  return (await res.json()) as Dismissals
}

/** Dismiss (hide) a series or book. Returns the fresh full list. */
export async function addDismissal(kind: 'series' | 'item', entityId: string): Promise<Dismissals> {
  return writeDismissal('POST', kind, entityId)
}

/** Restore (un-hide) a series or book. Returns the fresh full list. */
export async function removeDismissal(
  kind: 'series' | 'item',
  entityId: string,
): Promise<Dismissals> {
  return writeDismissal('DELETE', kind, entityId)
}

async function writeDismissal(
  method: 'POST' | 'DELETE',
  kind: 'series' | 'item',
  entityId: string,
): Promise<Dismissals> {
  const { serverUrl, token } = requireSession()
  const res = await fetch(`${serverUrl}/hs/dismissals`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, entityId }),
  })
  if (!res.ok) throw new Error(`dismissals ${res.status}`)
  return (await res.json()) as Dismissals
}
