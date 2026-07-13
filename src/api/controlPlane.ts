/**
 * HearthShelf control-plane client (ported from HearthShelf-WebApp/src/api/controlPlane.ts).
 *
 * Every call carries the Clerk session token as a bearer. In RN we can't read a
 * global auth token the way the web app does, so the caller passes a
 * `getToken()` (from Clerk's useAuth().getToken). Otherwise the shapes match the
 * web app exactly.
 */
import { CONTROL_PLANE_URL } from '@/lib/config'
import { fetchWithTimeout } from './fetchWithTimeout'

// `forceRefresh` asks the caller to bypass Clerk's token cache and mint a fresh
// JWT (getToken({ skipCache: true })). Used to retry a 401 exactly once: on a
// warm resume Clerk may hand out a stale cached token before it re-hydrates, and
// the control plane 401s it. A forced refresh distinguishes a transient stale
// token (retry succeeds) from a genuinely expired session (retry also 401s).
export type GetToken = (opts?: { forceRefresh?: boolean }) => Promise<string | null>

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

async function requestOnce(
  getToken: GetToken,
  path: string,
  init: RequestInit | undefined,
  forceRefresh: boolean,
): Promise<Response> {
  const token = await getToken(forceRefresh ? { forceRefresh: true } : undefined)
  const headers = new Headers(init?.headers)
  headers.set('Content-Type', 'application/json')
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetchWithTimeout(`${CONTROL_PLANE_URL}${path}`, { ...init, headers })
}

async function request<T>(getToken: GetToken, path: string, init?: RequestInit): Promise<T> {
  let res = await requestOnce(getToken, path, init, false)

  // A 401 can mean either a genuinely expired session OR a stale cached Clerk
  // token handed out during a warm resume (iOS re-inits Clerk when the phone is
  // unlocked; the first post-resume call can carry a not-yet-refreshed token).
  // Retry ONCE with a force-refreshed token before concluding the session is
  // dead - otherwise a transient resume 401 wrongly signs the user out (and
  // stops their playback) via onSessionExpired. Only if the fresh token is ALSO
  // rejected do we hand off to the session-expired handler.
  if (res.status === 401) {
    res = await requestOnce(getToken, path, init, true)
    if (res.status === 401) onSessionExpired?.()
  }

  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error?: string; detail?: string }
      detail = body.detail || body.error || detail
    } catch {
      // non-JSON error body; keep statusText
    }
    throw new ApiError(res.status, detail)
  }
  return res.json() as Promise<T>
}

export interface LinkedServer {
  id: string
  name: string
  url: string
  role: 'admin' | 'user'
  /** The user's chosen default server - a fresh device auto-connects here. */
  isDefault?: boolean
}

interface ServersResponse {
  servers: Array<{
    id: string
    name: string
    url: string
    role: 'admin' | 'user'
    is_default?: boolean
  }>
}

/** List the servers the signed-in user has linked. */
export async function fetchLinkedServers(getToken: GetToken): Promise<LinkedServer[]> {
  const data = await request<ServersResponse>(getToken, '/servers')
  return data.servers.map((s) => ({
    id: s.id,
    name: s.name,
    url: s.url,
    role: s.role,
    ...(s.is_default ? { isDefault: true } : {}),
  }))
}

/** Set this server as the account default (a fresh device auto-connects here). */
export async function setDefaultServer(getToken: GetToken, serverId: string): Promise<void> {
  await request(getToken, `/servers/${encodeURIComponent(serverId)}/default`, { method: 'POST' })
}

/** Clear the account default server (fresh devices return to the picker). */
export async function clearDefaultServer(getToken: GetToken, serverId: string): Promise<void> {
  await request(getToken, `/servers/${encodeURIComponent(serverId)}/default`, { method: 'DELETE' })
}

/**
 * Accept an invite by its token (from an app.hearthshelf.com/invite?token= link
 * that opened the app via a universal/app link). Relay-proof: links the invited
 * server to the signed-in account regardless of its email, so Sign in with Apple
 * "Hide My Email" users get connected. Returns the linked server id.
 */
export async function acceptInvite(
  getToken: GetToken,
  token: string,
): Promise<{ ok: boolean; serverId: string }> {
  return request<{ ok: boolean; serverId: string }>(getToken, '/invite/accept', {
    method: 'POST',
    body: JSON.stringify({ token }),
  })
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

/** A crash/breadcrumb report POSTed to the control plane's /logs/mobile. The
 *  server tags source='mobile', stamps the verified Clerk user id, and relays it
 *  to the log collector. `detail` carries device/OS/app fields + breadcrumbs. */
export interface MobileCrashReport {
  event: string
  message?: string
  detail?: Record<string, unknown>
}

/**
 * Fire a crash report to the control plane. DELIBERATELY does not go through
 * request(): crash reporting is fully best-effort and must never throw, retry
 * the session-expired handler, or surface an error to the user. If the token is
 * missing or the POST fails, we silently give up - the report is already safe on
 * disk and will be retried on a later launch.
 */
export async function reportMobileCrash(
  getToken: GetToken,
  report: MobileCrashReport,
): Promise<boolean> {
  try {
    const token = await getToken()
    if (!token) return false
    const res = await fetchWithTimeout(`${CONTROL_PLANE_URL}/logs/mobile`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(report),
    })
    return res.ok
  } catch {
    return false
  }
}
