/**
 * Connect to a HearthShelf server and get a per-user ABS token.
 * Ported from HearthShelf-WebApp/src/lib/connectServer.ts.
 *
 *   1. mint a server-scoped grant from the control plane (Clerk-authed)
 *   2. POST it to the server's own /hs/hosted/connect
 *   3. server verifies the grant offline and returns an ABS token
 *
 * The app then talks straight to the server's ABS /api/* with that token.
 */
import { mintGrant, type GetToken } from './controlPlane'

export interface ConnectResult {
  serverUrl: string
  token: string
}

export async function connectServer(
  getToken: GetToken,
  serverId: string,
  serverUrl: string
): Promise<ConnectResult> {
  const origin = serverUrl.replace(/\/$/, '')

  // 1. Mint a grant for THIS server.
  const { grant } = await mintGrant(getToken, serverId)

  // 2. Exchange it at the server's backend for an ABS token.
  const res = await fetch(`${origin}/hs/hosted/connect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant }),
  })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const body = (await res.json()) as { error?: string }
      detail = body.error || detail
    } catch {
      // keep statusText
    }
    throw new Error(`connect_failed: ${detail}`)
  }
  const data = (await res.json()) as { token?: string }
  if (!data.token) throw new Error('connect_failed: no_token')

  return { serverUrl: origin, token: data.token }
}
