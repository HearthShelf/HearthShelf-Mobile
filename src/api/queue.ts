/**
 * Listening-queue sync client. The up-next item list lives server-side (keyed
 * by ABS user id) so it follows the user across devices; src/player/queue.ts
 * is the fast in-memory cache. Queue MODE and auto-rules are NOT here - they
 * ride in app settings (see src/api/settings.ts). Same direct-origin
 * convention as getHSStats.
 */
import { getSession } from './session'
import type { QueueEntry } from '@hearthshelf/core'

export interface ServerQueue {
  items: QueueEntry[]
  playlistId: string | null
  updatedAt: number
  // Present on PUT responses: false when the write was rejected as stale - the
  // caller should adopt the returned state instead of assuming its write landed.
  applied?: boolean
}

function requireSession() {
  const s = getSession()
  if (!s) throw new Error('not_connected')
  return s
}

export async function getServerQueue(): Promise<ServerQueue> {
  const { serverUrl, token } = requireSession()
  const res = await fetch(`${serverUrl}/hs/queue`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`queue ${res.status}`)
  return (await res.json()) as ServerQueue
}

export async function putServerQueue(
  items: QueueEntry[],
  playlistId: string | null,
  updatedAt: number
): Promise<ServerQueue> {
  const { serverUrl, token } = requireSession()
  const res = await fetch(`${serverUrl}/hs/queue`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ items, playlistId, updatedAt }),
  })
  if (!res.ok) throw new Error(`queue ${res.status}`)
  return (await res.json()) as ServerQueue
}
