/**
 * Minimal ReadMeABook (RMAB) client for mobile - only what the "missing books"
 * surface needs: is the request backend connected, and submit a request. Like
 * abs.ts, hits /hs/rmab/* on the connected server's origin with the per-user ABS
 * bearer token. Every call degrades to a safe value on any failure so a slim
 * deploy (no /hs/rmab) or an unreachable server never breaks the series screen.
 */
import * as Sentry from '@sentry/react-native'
import { getSession } from './session'

export interface RmabRequestResult {
  success: boolean
  request?: { id: string; status: string }
  /** Upstream rejection code (`AlreadyAvailable`, `DuplicateRequest`, ...) when
   *  the upstream sent one. Pair with `rmabRejectionMessage` from core rather
   *  than showing it raw. */
  error?: string
  /** Free text from the upstream or the proxy, when there was any. */
  detail?: string
  /** The HTTP status the proxy forwarded. Absent when the call never reached
   *  the server at all. */
  status?: number
}

/** A request the server answered with a non-2xx, carrying what it said.
 *
 *  The old code threw `new Error(\`rmab ${status}\`)` and dropped the body, so
 *  the upstream's reason -- the one thing that says whether retrying is even
 *  worth it -- never left this file. */
export class RmabRequestError extends Error {
  readonly status: number
  readonly code?: string
  readonly detail?: string
  constructor(status: number, code?: string, detail?: string) {
    super(code ? `rmab ${status}: ${code}` : `rmab ${status}`)
    this.name = 'RmabRequestError'
    this.status = status
    this.code = code
    this.detail = detail
  }
}

async function rmabFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; data: T }> {
  const s = getSession()
  if (!s) throw new Error('not_connected')
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${s.token}`)
  headers.set('Accept', 'application/json')
  if (init?.body) headers.set('Content-Type', 'application/json')
  const res = await fetch(`${s.serverUrl}/hs/rmab${path}`, { ...init, headers })
  // Parse before checking `ok`: the reason for a refusal is in the body, and the
  // proxy forwards the upstream's body verbatim. `{}` is a real shape -- it is
  // what arrives when the upstream sent HTML or nothing.
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!res.ok) {
    const code = typeof body?.error === 'string' ? body.error : undefined
    const detail =
      typeof body?.detail === 'string'
        ? body.detail
        : typeof body?.message === 'string'
          ? body.message
          : undefined
    throw new RmabRequestError(res.status, code, detail)
  }
  return { status: res.status, data: (body ?? {}) as T }
}

/**
 * Is the RMAB request backend enabled on the connected server? False on any
 * failure (unreachable, slim deploy, disconnected) so the missing rows fall back
 * to a buy-on-Audible link instead of a dead "Request" action.
 */
export async function getRmabEnabled(): Promise<boolean> {
  try {
    const { data } = await rmabFetch<{ enabled?: boolean; configured?: boolean }>('/config')
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
    const { status, data } = await rmabFetch<RmabRequestResult>('/requests', {
      method: 'POST',
      body: JSON.stringify({ audiobook }),
    })
    // A 2xx can still be a rejection. The proxy treats `success: false` as one
    // and logs the reason, but forwards the upstream's 2xx status
    // (HearthShelf server/routes/rmab.js), so this is the COMMON refusal shape
    // -- and the one the old code dropped on the floor, because it only looked
    // at non-2xx responses. Carry the status through so the caller can word it.
    const result = { ...data, status }
    if (!result.success) reportRefusal(audiobook.asin, result)
    return result
  } catch (e) {
    if (e instanceof RmabRequestError) {
      const result = { success: false, error: e.code, detail: e.detail, status: e.status }
      reportRefusal(audiobook.asin, result)
      return result
    }
    // Never reached the server: offline, not connected, DNS. No status to give.
    return { success: false }
  }
}

/** Refusals that are an honest answer about the book, not a break. */
const ORDINARY_REFUSALS = new Set([
  'AlreadyAvailable',
  'BeingProcessed',
  'DuplicateRequest',
  'Ignored',
])

/**
 * A refused request only ever became on-screen text, so a request that "keeps
 * failing" (HS-MOBILEAPP-4H) left nothing to diagnose. Report the server's
 * reason, grouped by its code so one broken upstream is one issue.
 */
function reportRefusal(asin: string, result: RmabRequestResult): void {
  if (result.error && ORDINARY_REFUSALS.has(result.error)) return
  const code = result.error ?? `http-${result.status ?? 'none'}`
  const err = new Error(`book request refused: ${code}`)
  err.name = 'BookRequestRefused'
  Sentry.captureException(err, {
    level: 'warning',
    tags: { feature: 'rmab-request', code },
    extra: { asin, status: result.status ?? null, detail: result.detail ?? null },
    fingerprint: ['rmab-request', code],
  })
}
