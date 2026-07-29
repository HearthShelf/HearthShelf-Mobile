/**
 * Which addresses to try when connecting to a server, and in what order.
 *
 * A server can be reachable at up to three addresses, and which one works depends
 * on where the phone is and whether the SERVER still has internet:
 *
 *   local    private LAN origin - the only one that survives the server losing
 *            its WAN, and the fastest when we're on the same Wi-Fi. Requires an
 *            identity check before any credential is sent (see serverIdentity.ts)
 *            and is never dialled off Wi-Fi.
 *   url      the admin's own domain, or the hs.direct host. The normal path.
 *   fallback the hs.direct host, when `url` is a custom domain that's broken.
 *
 * ORDERING TRADEOFF: LAN-first is right when it works - it is the fastest hop and
 * the only one that survives a WAN outage. But a STALE LAN address (user moved
 * house, DHCP reassigned the lease) must not tax every launch with a timeout. Two
 * things keep that cheap: a short per-candidate timeout for the LAN attempt, and
 * an SSID-keyed memory of what actually worked, so we stop guessing on networks
 * where we already know the answer.
 */
import NetInfo from '@react-native-community/netinfo'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { LinkedServer } from './controlPlane'

export type CandidateKind = 'local' | 'preferred' | 'fallback'

export interface Candidate {
  kind: CandidateKind
  url: string
  /** Set for LAN candidates: identity MUST be proven before sending a grant. */
  identityKey?: string
  /** Per-candidate connect timeout. A LAN hop either answers fast or is wrong. */
  timeoutMs: number
}

/** A LAN hop is local or nothing - don't spend launch time waiting on it. */
const LOCAL_TIMEOUT_MS = 1500
/** Public candidates get the normal budget (DNS + TLS + a possible cold start). */
const PUBLIC_TIMEOUT_MS = 10000

const SSID_CACHE_KEY = 'hs.connectHint.v1'

/**
 * How long a "this worked here" hint stays good (7d).
 *
 * Deliberately short-lived. The hint's job is to skip a doomed LAN attempt on a
 * network we've already learned about; it is NOT a durable record. Networks get
 * renumbered, and a confidently-wrong hint is worse than none.
 */
const HINT_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface Hint {
  kind: CandidateKind
  url: string
  at: number
}

type HintMap = Record<string, Hint>

async function readHints(): Promise<HintMap> {
  try {
    const raw = await AsyncStorage.getItem(SSID_CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as HintMap
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Network fingerprint used to key hints.
 *
 * We do NOT ask for the real SSID: on both platforms that needs location
 * permission, and asking a user for location just to speed up a connect is a
 * terrible trade. NetInfo exposes a non-sensitive per-network identifier on Wi-Fi
 * (the gateway/subnet shape), which is exactly as much as we need - "am I on the
 * network where this worked before?" - and nothing we'd have to justify.
 */
async function networkKey(): Promise<string | null> {
  try {
    const s = await NetInfo.fetch()
    if (s.type !== 'wifi') return null
    const details = (s.details ?? {}) as { ipAddress?: string; subnet?: string }
    // The phone's own /24 is a good proxy for "same LAN" and needs no permission.
    const ip = details.ipAddress
    if (!ip) return null
    const parts = ip.split('.')
    if (parts.length !== 4) return null
    return `wifi:${parts[0]}.${parts[1]}.${parts[2]}`
  } catch {
    return null
  }
}

/**
 * The current network fingerprint, for tagging a LAN-scoped session. Null off
 * Wi-Fi (where a LAN session is meaningless anyway).
 */
export async function currentNetworkScope(): Promise<string | null> {
  return networkKey()
}

/** Are we on Wi-Fi right now? LAN candidates are gated on this. */
export async function onWifi(): Promise<boolean> {
  try {
    const s = await NetInfo.fetch()
    return s.type === 'wifi'
  } catch {
    return false
  }
}

/** Remember that `kind`/`url` connected on this network. */
export async function rememberSuccess(
  serverId: string,
  kind: CandidateKind,
  url: string,
): Promise<void> {
  const key = await networkKey()
  if (!key) return
  try {
    const hints = await readHints()
    hints[`${serverId}@${key}`] = { kind, url, at: Date.now() }
    await AsyncStorage.setItem(SSID_CACHE_KEY, JSON.stringify(hints))
  } catch {
    // Non-fatal: we just re-try candidates in the default order next time.
  }
}

/**
 * Forget a hint. Called when a remembered candidate FAILS IDENTITY - that address
 * is now answering as something else (DHCP moved it, or someone is squatting it),
 * and we must not keep preferring it.
 */
export async function forgetHint(serverId: string): Promise<void> {
  const key = await networkKey()
  if (!key) return
  try {
    const hints = await readHints()
    delete hints[`${serverId}@${key}`]
    await AsyncStorage.setItem(SSID_CACHE_KEY, JSON.stringify(hints))
  } catch {
    // ignore
  }
}

/**
 * Build the ordered candidate list for a server.
 *
 * Guarantees the callers rely on:
 *  - A `local` candidate appears ONLY when we are on Wi-Fi AND it carries an
 *    identity key. Off Wi-Fi it is omitted entirely, so a private IP is never
 *    dialled over cellular.
 *  - The list is never empty as long as `server.url` is set, so a failure to
 *    resolve hints can't strand the connect.
 */
export async function buildCandidates(server: LinkedServer): Promise<Candidate[]> {
  const list: Candidate[] = []

  // LAN first - but only on Wi-Fi, and only if we can authenticate it.
  if (server.localUrl && server.identityKey && (await onWifi())) {
    list.push({
      kind: 'local',
      url: server.localUrl,
      identityKey: server.identityKey,
      timeoutMs: LOCAL_TIMEOUT_MS,
    })
  }

  list.push({ kind: 'preferred', url: server.url, timeoutMs: PUBLIC_TIMEOUT_MS })

  if (server.fallbackUrl && server.fallbackUrl !== server.url) {
    list.push({ kind: 'fallback', url: server.fallbackUrl, timeoutMs: PUBLIC_TIMEOUT_MS })
  }

  // Promote whatever worked here last time, if the hint is still fresh and still
  // corresponds to an address the control plane currently offers. A hint can never
  // ADD a candidate - only reorder - so a stale hint cannot resurrect an address
  // the server has since withdrawn.
  const key = await networkKey()
  if (key) {
    const hints = await readHints()
    const hint = hints[`${server.id}@${key}`]
    if (hint && Date.now() - hint.at < HINT_TTL_MS) {
      const idx = list.findIndex((c) => c.kind === hint.kind && c.url === hint.url)
      if (idx > 0) {
        const [promoted] = list.splice(idx, 1)
        list.unshift(promoted)
      }
    }
  }

  return list
}
