/**
 * Minimal ReadMeABook (RMAB) client for mobile - only what the "missing books"
 * surface needs: is the request backend connected, and submit a request. Like
 * abs.ts, hits /hs/rmab/* on the connected server's origin with the per-user ABS
 * bearer token. Every call degrades to a safe value on any failure so a slim
 * deploy (no /hs/rmab) or an unreachable server never breaks the series screen.
 */
import { getSession } from './session'

export interface RmabRequestResult {
  success: boolean
  request?: { id: string; status: string }
  error?: string
}

async function rmabFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const s = getSession()
  if (!s) throw new Error('not_connected')
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${s.token}`)
  headers.set('Accept', 'application/json')
  if (init?.body) headers.set('Content-Type', 'application/json')
  const res = await fetch(`${s.serverUrl}/hs/rmab${path}`, { ...init, headers })
  if (!res.ok) throw new Error(`rmab ${res.status}`)
  return (await res.json()) as T
}

/**
 * Is the RMAB request backend enabled on the connected server? False on any
 * failure (unreachable, slim deploy, disconnected) so the missing rows fall back
 * to a buy-on-Audible link instead of a dead "Request" action.
 */
export async function getRmabEnabled(): Promise<boolean> {
  try {
    const data = await rmabFetch<{ enabled?: boolean; configured?: boolean }>('/config')
    return data.enabled === true || data.configured === true
  } catch {
    return false
  }
}

export async function submitRequest(audiobook: {
  asin: string
  title: string
  author: string
  narrator?: string
  description?: string
  coverArtUrl?: string
}): Promise<RmabRequestResult> {
  try {
    return await rmabFetch<RmabRequestResult>('/requests', {
      method: 'POST',
      body: JSON.stringify({ audiobook }),
    })
  } catch {
    return { success: false, error: 'Request failed' }
  }
}
