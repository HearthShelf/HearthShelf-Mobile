/**
 * Prove a candidate origin really is the server we think it is, BEFORE we hand it
 * a control-plane grant.
 *
 * WHY THIS EXISTS (the whole reason the LAN path is safe)
 *
 * A grant is a bearer token. It carries the user's verified email, Clerk subject,
 * username and role, and ANY HearthShelf server that receives one can exchange it
 * for a long-lived per-user ABS API key. So we must never present one to an origin
 * we have not authenticated.
 *
 * On the public internet, TLS does that for us: the origin is a CA-valid HTTPS
 * name the control plane vouched for. On a LAN it does NOT. A LAN address is a
 * private IP over plain http - no usable certificate - learned from a registry
 * that goes stale the moment DHCP reassigns the lease. Any device on the network
 * can answer on that address. Without this check, a rogue listener (or just the
 * printer that inherited 192.168.1.50) would receive a live grant and could replay
 * it against the real server for permanent access to the user's library.
 *
 * Note the asymmetry that makes a client-side check mandatory: the `aud` claim
 * inside the grant is enforced by the SERVER, protecting the server from a grant
 * minted for someone else. It does nothing for us, because a malicious server
 * simply doesn't run that code - it answers 200 with whatever we want to hear.
 *
 * THE HANDSHAKE
 *
 *   us   -> origin:  POST /hs/hosted/identity { nonce }
 *   origin -> us:    { server_id, signature }   signature = Ed25519(nonce||server_id)
 *
 * We verify against the public key the control plane gave us over TLS. Only the
 * real box holds the private half. Both the nonce (fresh, ours) and the server_id
 * are inside the signed payload, so a response captured on the network cannot be
 * replayed at us later, nor can a signature from server A pass as proof of server
 * B.
 */
import { ed25519 } from '@noble/curves/ed25519'
import * as Crypto from 'expo-crypto'
import { fetchWithTimeout } from './fetchWithTimeout'

/**
 * How long we give an origin to answer the challenge. This is a LAN hop or a
 * quick public one - a slow answer is indistinguishable from a wrong address, and
 * we would rather fail fast and move to the next candidate than stall the launch.
 */
const IDENTITY_TIMEOUT_MS = 2500

/** Ed25519 SPKI DER is a fixed 12-byte prefix followed by the 32-byte raw key. */
const SPKI_PREFIX_LEN = 12
const RAW_KEY_LEN = 32

function b64ToBytes(b64: string): Uint8Array {
  // atob is available in Hermes/RN. Avoids pulling in a Buffer polyfill.
  const bin = globalThis.atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function utf8ToBytes(s: string): Uint8Array {
  // TextEncoder exists in RN; fall back to a manual encode if not.
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s)
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return new Uint8Array(out)
}

/**
 * Extract the 32-byte raw Ed25519 key from a base64 SPKI DER blob (what the
 * control plane stores and the server exports). Accepts a bare 32-byte key too,
 * so the format can be simplified later without breaking older clients.
 */
function rawKeyFromSpkiB64(b64: string): Uint8Array | null {
  try {
    const bytes = b64ToBytes(b64)
    if (bytes.length === RAW_KEY_LEN) return bytes
    if (bytes.length === SPKI_PREFIX_LEN + RAW_KEY_LEN) return bytes.subarray(SPKI_PREFIX_LEN)
    return null
  } catch {
    return null
  }
}

export type IdentityOutcome =
  /** Signature verified - this origin holds the server's private key. */
  | { ok: true }
  /** The origin answered but could not prove identity. NEVER send it a grant. */
  | { ok: false; reason: 'bad_signature' | 'wrong_server' | 'no_identity' | 'malformed' }
  /** We could not reach it / it timed out. Also a refusal, but retryable later. */
  | { ok: false; reason: 'unreachable' }

/**
 * Challenge `origin` and verify it controls the private key matching
 * `identityKeyB64`, and that it identifies as `expectedServerId`.
 *
 * FAILS CLOSED in every ambiguous case. A missing key, an unparseable response, a
 * 501 from a server too old to have an identity key, a network error - all return
 * ok:false. The caller must treat anything other than ok:true as "do not present a
 * credential to this origin".
 */
export async function verifyServerIdentity(
  origin: string,
  expectedServerId: string,
  identityKeyB64: string,
): Promise<IdentityOutcome> {
  const rawKey = rawKeyFromSpkiB64(identityKeyB64)
  if (!rawKey) return { ok: false, reason: 'malformed' }

  // 32 bytes of CSPRNG, hex-encoded. Fresh per attempt, so a captured response is
  // useless against us on any later attempt.
  const nonceBytes = await Crypto.getRandomBytesAsync(32)
  const nonce = Array.from(nonceBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

  let res: Response
  try {
    res = await fetchWithTimeout(
      `${origin.replace(/\/$/, '')}/hs/hosted/identity`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nonce }),
      },
      IDENTITY_TIMEOUT_MS,
    )
  } catch {
    return { ok: false, reason: 'unreachable' }
  }

  if (!res.ok) {
    // 501 = a server with no identity key yet. It may well be the real box, but we
    // cannot prove it, so the LAN path stays closed for it. The public URL still
    // works normally - TLS authenticates that one.
    return { ok: false, reason: res.status === 501 ? 'no_identity' : 'malformed' }
  }

  let body: { server_id?: string; signature?: string }
  try {
    body = (await res.json()) as { server_id?: string; signature?: string }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (!body.server_id || !body.signature) return { ok: false, reason: 'malformed' }

  // Check the claimed id BEFORE verifying, so a valid signature from a different
  // (legitimate) box on the same LAN can't be mistaken for ours.
  if (body.server_id !== expectedServerId) return { ok: false, reason: 'wrong_server' }

  // Payload format is shared with server/lib/serverIdentity.js - keep in step.
  const payload = utf8ToBytes(`hs-identity:v1:${body.server_id}:${nonce}`)
  let sig: Uint8Array
  try {
    sig = b64ToBytes(body.signature)
  } catch {
    return { ok: false, reason: 'malformed' }
  }

  try {
    const good = ed25519.verify(sig, payload, rawKey)
    return good ? { ok: true } : { ok: false, reason: 'bad_signature' }
  } catch {
    // A malformed signature makes noble throw rather than return false.
    return { ok: false, reason: 'bad_signature' }
  }
}
