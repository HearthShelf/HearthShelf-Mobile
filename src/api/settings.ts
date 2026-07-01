/**
 * App-settings sync client (queue mode + auto-rules today). Settings live
 * server-side keyed by ABS user id so they follow the user across devices -
 * this app's in-memory store (src/store/settings.ts) is just the fast cache.
 * Unlike the WebApp (which proxies through its own origin), mobile talks
 * directly to the connected server's origin - same convention as getHSStats.
 */
import { getSession } from './session'

export interface ServerSettings {
  values: Record<string, unknown> | null
  updatedAt: number
}

function requireSession() {
  const s = getSession()
  if (!s) throw new Error('not_connected')
  return s
}

export async function getServerSettings(): Promise<ServerSettings> {
  const { serverUrl, token } = requireSession()
  const res = await fetch(`${serverUrl}/hs/settings`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`settings ${res.status}`)
  return (await res.json()) as ServerSettings
}

export async function putServerSettings(
  values: Record<string, unknown>
): Promise<ServerSettings> {
  const { serverUrl, token } = requireSession()
  const res = await fetch(`${serverUrl}/hs/settings`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  })
  if (!res.ok) throw new Error(`settings ${res.status}`)
  return (await res.json()) as ServerSettings
}
