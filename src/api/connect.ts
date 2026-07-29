/**
 * Connect to a HearthShelf server and get a per-user ABS token.
 * Ported from HearthShelf-WebApp/src/lib/connectServer.ts.
 *
 *   1. mint a server-scoped grant from the control plane (Clerk-authed)
 *   2. POST it to the server's own /hs/hosted/connect
 *   3. server verifies the grant offline and returns an ABS token
 *
 * The app then talks straight to the server's ABS /api/* with that token.
 *
 * A server may be reachable at several addresses (LAN, own domain, hs.direct), so
 * we try them in order - see candidates.ts. One grant covers all attempts: grants
 * are valid for 300s, comfortably longer than a full candidate sweep, so there is
 * no need to re-mint per address.
 *
 * SECURITY INVARIANT: a grant is a bearer credential carrying the user's verified
 * email, Clerk subject and role, and any server that receives one can exchange it
 * for a long-lived per-user ABS key. It is therefore ONLY ever sent to an origin
 * we trust:
 *   - public candidates are authenticated by TLS (CA-valid host the control plane
 *     vouched for), and
 *   - LAN candidates are authenticated by an explicit Ed25519 challenge FIRST
 *     (verifyServerIdentity), because plain http on a private IP proves nothing
 *     and any device on the network can answer at that address.
 * If identity cannot be proven, we skip the candidate WITHOUT sending the grant.
 */
import { mintGrant, type GetToken, type LinkedServer } from './controlPlane'
import { fetchWithTimeout } from './fetchWithTimeout'
import { ConnectionError, classifyHttpStatus } from './connectionError'
import { buildCandidates, rememberSuccess, forgetHint, type Candidate } from './candidates'
import { verifyServerIdentity } from './serverIdentity'

export interface ConnectResult {
  serverUrl: string
  token: string
  /** Which address answered. Callers use this to avoid persisting a LAN origin as
   *  the canonical server URL (it is only valid on that one network). */
  via: Candidate['kind']
  /** When the grant that produced this token expires (ms epoch), so a caller can
   *  refresh before ABS starts rejecting it. */
  expiresAt?: number
}

/** Redeem an already-minted grant at one specific origin. */
async function redeemAt(origin: string, grant: string, timeoutMs: number): Promise<string> {
  const res = await fetchWithTimeout(
    `${origin}/hs/hosted/connect`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ grant }),
    },
    timeoutMs,
  )
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error?: string; reason?: string }
      detail = body.reason || body.error || detail
    } catch {
      // keep statusText
    }
    // Classified so the UI can say WHY - a rejected sign-in, a server error, and
    // a wrong address all land here and need different fixes from the user.
    throw classifyHttpStatus(res.status, { detail, url: `${origin}/hs/hosted/connect` })
  }
  const data = (await res.json()) as { token?: string }
  if (!data.token) {
    throw new ConnectionError('notFound', {
      detail: 'server did not return a token',
      url: `${origin}/hs/hosted/connect`,
    })
  }
  return data.token
}

/**
 * Connect to `server`, trying each of its addresses in turn.
 *
 * `serverUrlOverride` keeps the old two-arg call shape working for callers that
 * only have an id + url (e.g. a rehydrated session) and no full LinkedServer.
 */
export async function connectServer(
  getToken: GetToken,
  serverId: string,
  serverUrlOrServer: string | LinkedServer,
): Promise<ConnectResult> {
  const server: LinkedServer =
    typeof serverUrlOrServer === 'string'
      ? { id: serverId, name: '', url: serverUrlOrServer.replace(/\/$/, ''), role: 'user' }
      : serverUrlOrServer

  const candidates = await buildCandidates(server)

  // One grant for the whole sweep (300s TTL >> a candidate sweep).
  const { grant, expires_in } = await mintGrant(getToken, serverId)
  const expiresAt = expires_in ? Date.now() + expires_in * 1000 : undefined

  let lastError: unknown = null

  for (const cand of candidates) {
    const origin = cand.url.replace(/\/$/, '')

    // MANDATORY for LAN: prove this origin is really our server before it sees a
    // credential. Anything other than a verified signature - wrong id, bad
    // signature, no identity support, unreachable - means we move on and the grant
    // is never transmitted here.
    if (cand.kind === 'local') {
      const idc = await verifyServerIdentity(origin, serverId, cand.identityKey ?? '')
      if (!idc.ok) {
        // A remembered address that now fails identity is answering as something
        // else (DHCP reassignment, or a squatter). Drop the hint so we stop
        // preferring it, and never retry it this sweep.
        if (idc.reason !== 'unreachable') await forgetHint(serverId)
        lastError =
          lastError ??
          new ConnectionError('notFound', {
            detail: `local address failed identity check (${idc.reason})`,
            url: origin,
          })
        continue
      }
    }

    try {
      const token = await redeemAt(origin, grant, cand.timeoutMs)
      await rememberSuccess(serverId, cand.kind, origin)
      return { serverUrl: origin, token, via: cand.kind, expiresAt }
    } catch (e) {
      lastError = e
      // 'auth' (401/403) is a verdict about the GRANT, not the address - every
      // other candidate would reject it identically, so stop rather than replay a
      // rejected credential at more origins.
      if (e instanceof ConnectionError && e.kind === 'auth') throw e
      // Anything else is address-specific, so try the next one. Note the server
      // now answers 503 ('server') for "I can't verify grants right now", which is
      // deliberately NOT 'auth' - that case is transient and worth another address
      // or a later retry, not a sign-out.
    }
  }

  throw (
    lastError ??
    new ConnectionError('notFound', {
      detail: 'no reachable address for this server',
      url: server.url,
    })
  )
}
