/**
 * HearthShelf control-plane client (ported from HearthShelf-WebApp/src/api/controlPlane.ts).
 *
 * Every call carries the Clerk session token as a bearer. In RN we can't read a
 * global auth token the way the web app does, so the caller passes a
 * `getToken()` (from Clerk's useAuth().getToken). Otherwise the shapes match the
 * web app exactly.
 */
import { CONTROL_PLANE_URL } from '@/lib/config'

export type GetToken = () => Promise<string | null>

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Session-expired seam (mirrors the web app's ClerkTokenBridge). When the
 * control plane rejects our Clerk token as expired/invalid (401), the auth
 * layer registers what to do - sign out and route to /sign-in with a reason -
 * so the user gets a clear message instead of a dead error screen.
 */
type SessionExpiredHandler = () => void
let onSessionExpired: SessionExpiredHandler | null = null
export function setSessionExpiredHandler(fn: SessionExpiredHandler | null): void {
  onSessionExpired = fn
}

async function request<T>(getToken: GetToken, path: string, init?: RequestInit): Promise<T> {
  const token = await getToken()
  const headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)

  const res = await fetch(`${CONTROL_PLANE_URL}${path}`, { ...init, headers })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error?: string; detail?: string }
      detail = body.detail || body.error || detail
    } catch {
      // non-JSON error body; keep statusText
    }
    // A 401 means the Clerk session is no longer accepted - hand off to the
    // registered handler (sign out + redirect) rather than surfacing a raw error.
    if (res.status === 401) onSessionExpired?.()
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

export interface LinkedServer {
  id: string
  name: string
  url: string
  role: 'admin' | 'user'
}

interface ServersResponse {
  servers: LinkedServer[]
}

/** List the servers the signed-in user has linked. */
export async function fetchLinkedServers(getToken: GetToken): Promise<LinkedServer[]> {
  const data = await request<ServersResponse>(getToken, '/servers')
  return data.servers
}

interface GrantResponse {
  grant: string
  server: { id: string; url: string }
  expires_in: number
}

/** Mint a short-lived grant for one server (redeemed against the HS server). */
export async function mintGrant(getToken: GetToken, serverId: string): Promise<GrantResponse> {
  return request<GrantResponse>(getToken, `/servers/${encodeURIComponent(serverId)}/grant`, {
    method: 'POST',
  })
}
