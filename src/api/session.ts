/**
 * Active ABS session: the connected server's origin + the per-user ABS token.
 *
 * Kept as a plain module singleton (not React state) on purpose: the Android
 * Auto / CarPlay screens (autoplay.tsx) run OUTSIDE the React tree and need to
 * read these to build stream and cover URLs. We mirror them into
 * expo-secure-store so the headless car service can rehydrate if the OS spins it
 * up cold (e.g. the user opens Android Auto before the phone app).
 */
import * as SecureStore from 'expo-secure-store'

interface AbsSession {
  serverUrl: string
  token: string
  /** Which kind of address produced this session. 'local' means serverUrl is a
   *  PRIVATE LAN origin that is only valid on the network we were on - see
   *  networkScope. Anything else is a public origin, valid anywhere. */
  via?: 'local' | 'preferred' | 'fallback'
  /** For a LAN-scoped session, the network fingerprint it was established on.
   *  Rehydrating must not reuse a private origin on a DIFFERENT network: the
   *  address either won't answer or, worse, belongs to someone else's device. */
  networkScope?: string
  /** When the grant behind this token expires (ms epoch), when known. Lets us
   *  reconnect proactively instead of waiting for ABS to start 401ing. */
  expiresAt?: number
}

let current: AbsSession | null = null

const KEY = 'hs.abs.session'
const LAST_SERVER_KEY = 'hs.lastServerId'
const PENDING_INVITE_KEY = 'hs.pendingInviteToken'

/**
 * An invite token captured from an app.hearthshelf.com/invite?token= universal
 * link but not yet redeemed - typically because the link arrived while the user
 * was signed out, so we stash it across the sign-in redirect and redeem it once
 * a session exists. Persisted (not just in-memory) so it survives the app
 * restart that a cold universal-link launch can cause.
 */
export async function setPendingInviteToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(PENDING_INVITE_KEY, token)
  } catch {
    // non-fatal; the invite can be re-opened from the link
  }
}

/** Read and clear the pending invite token (redeem-once). */
export async function takePendingInviteToken(): Promise<string | null> {
  try {
    const t = await SecureStore.getItemAsync(PENDING_INVITE_KEY)
    if (t) await SecureStore.deleteItemAsync(PENDING_INVITE_KEY)
    return t
  } catch {
    return null
  }
}

/** Remember which linked server the user last connected to (multi-server). */
export async function setLastServerId(serverId: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(LAST_SERVER_KEY, serverId)
  } catch {
    // non-fatal; we just fall back to the first server next launch
  }
}

export async function getLastServerId(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(LAST_SERVER_KEY)
  } catch {
    return null
  }
}

/** Forget the remembered server so the next connect shows the picker. */
export async function clearLastServerId(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(LAST_SERVER_KEY)
  } catch {
    // non-fatal
  }
}

export function getSession(): AbsSession | null {
  return current
}

export async function setSession(session: AbsSession): Promise<void> {
  current = session
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(session))
  } catch {
    // non-fatal; in-memory copy still works for this run
  }
}

export async function clearSession(): Promise<void> {
  current = null
  try {
    await SecureStore.deleteItemAsync(KEY)
  } catch {
    // ignore
  }
}

/**
 * Is this a private (LAN) origin? A rehydrated private address is only usable on
 * the network it was established on.
 */
function isPrivateOrigin(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host === 'localhost' || host.endsWith('.local')) return true
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
    if (!m) return false
    const a = Number(m[1])
    const b = Number(m[2])
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a === 127 ||
      (a === 169 && b === 254)
    )
  } catch {
    return false
  }
}

/**
 * Validate a blob read back from SecureStore.
 *
 * SecureStore is Keychain/Keystore-backed so tampering is unlikely, but a
 * partially-written or version-skewed blob would otherwise produce a session
 * object with missing fields that fails much later and much more confusingly.
 * Fail closed instead.
 */
function parseSession(raw: string): AbsSession | null {
  try {
    const p = JSON.parse(raw) as Record<string, unknown>
    if (!p || typeof p !== 'object') return null
    if (typeof p.serverUrl !== 'string' || !p.serverUrl) return null
    if (typeof p.token !== 'string' || !p.token) return null
    const via =
      p.via === 'local' || p.via === 'preferred' || p.via === 'fallback' ? p.via : undefined
    return {
      serverUrl: p.serverUrl,
      token: p.token,
      ...(via ? { via } : {}),
      ...(typeof p.networkScope === 'string' ? { networkScope: p.networkScope } : {}),
      ...(typeof p.expiresAt === 'number' ? { expiresAt: p.expiresAt } : {}),
    }
  } catch {
    return null
  }
}

/**
 * Rehydrate from secure store (used by the headless playback service).
 *
 * `currentNetworkScope` lets the caller supply the network fingerprint it is on
 * now. A LAN-scoped session from a DIFFERENT network is refused: dialling a
 * remembered 192.168.x.y somewhere else can only fail, and could reach an
 * unrelated device. Callers that cannot determine the network (the headless car
 * service at cold start) pass nothing, and we then refuse LAN sessions outright -
 * the safe default, since a public origin works everywhere.
 */
export async function hydrateSession(currentNetworkScope?: string): Promise<AbsSession | null> {
  if (current) return current
  try {
    const raw = await SecureStore.getItemAsync(KEY)
    if (!raw) return null
    const parsed = parseSession(raw)
    if (!parsed) return null
    if (parsed.via === 'local' || isPrivateOrigin(parsed.serverUrl)) {
      if (!currentNetworkScope || parsed.networkScope !== currentNetworkScope) return null
    }
    current = parsed
  } catch {
    // ignore
  }
  return current
}
