/**
 * Owns "are we connected to an AudiobookShelf server yet?" for the whole app.
 *
 * Mounted for the app's whole lifetime; the connect flow starts once Clerk
 * reports a signed-in user and idles at `connecting` while signed out. It mints
 * a grant, exchanges it for an ABS token, and stashes the result in the session
 * singleton (src/api/session.ts) that every /api/* helper reads. Until it reaches
 * `ready`, the root gate keeps the hearth splash on screen; on failure the splash
 * turns into an error screen (retry / manage servers / log out).
 *
 * The connect logic here was hoisted out of the Home tab so the splash - not a
 * tab already inside the app - covers the connect + first-load moment.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useAuth } from '@clerk/expo'
import { fetchLinkedServers, acceptInvite, ApiError, type LinkedServer } from './controlPlane'
import { connectServer } from './connect'
import { ConnectionError } from './connectionError'
import { setSession, setLastServerId, getLastServerId, takePendingInviteToken } from './session'
import { CLERK_JWT_TEMPLATE } from '@/lib/config'
import { hasCachedClerkSession } from '@/lib/tokenCache'
import { tracePhase } from '@/lib/startupTrace'
import {
  clearAutoSession,
  setAutoSession,
  setAutoNotePops,
  setAutoSkipSeconds,
  setAutoChapterProgress,
  isAirplaneMode,
} from '@/player/autoBridge'
import { startQueueSync } from '@/player/queueSync'
import { refreshSubscriptions } from '@/player/subscriptions'
import { ensurePushRegistered } from '@/player/pushRegister'
import { startClubSync } from '@/player/clubSync'
import { ensureDeviceId, getSettingsState, subscribeSettings } from '@/store/settings'
import { hydrateDownloads, getDownloadsState, subscribeDownloads } from '@/player/downloads'
import { hydrateCatalog, backfillCatalog } from '@/player/offlineCatalog'
import { getItemDetail, getLibrarySeries } from './abs'
import {
  startConnectivityWatch,
  stopConnectivityWatch,
  probeReachable,
  pokeConnectivity,
  isCurrentlyReachable,
} from '@/player/connectivity'
import {
  startOfflineLibrarySync,
  drainCarOfflineWork,
  drainCarOfflineProgress,
  drainCarOfflineBookmarks,
} from '@/player/carOffline'
import {
  hydratePendingProgress,
  hydrateStreamingBuffer,
  migrateOrphanStreaming,
  flushPendingProgress,
} from '@/player/pendingProgress'
import { hydratePendingBookmarks } from '@/player/pendingBookmarks'
import { hydrateSessionCache, refreshSessionCache } from '@/player/sessionCache'
import { subscribeServerReached } from '@/player/syncState'
import { hydrateProgress } from '@/store/progress'
import type { SplashServer } from '@/ui/SplashScreen'

/**
 * Why the launch is taking a while, when we know. Drives the splash copy: sitting
 * under "Warming up your library..." for 40s while the phone is in airplane mode
 * tells the user nothing they can act on.
 */
export type ConnectIssue =
  /** Airplane mode is on - nothing to connect to, and no point retrying. */
  | 'airplane'
  /** No network interface at all (no Wi-Fi, no signal). */
  | 'no-network'
  /** On a network, but the internet/server isn't answering. */
  | 'unreachable'
  /** A handshake attempt failed; another is running. */
  | 'retrying'

export type ConnectionStatus =
  | { phase: 'connecting'; attempt?: number; maxAttempts?: number; issue?: ConnectIssue }
  | { phase: 'select-server'; servers: LinkedServer[] }
  | { phase: 'no-servers' }
  // `message` is the plain headline shown to the user; `details` is the raw
  // status/URL for the "Show details" disclosure and bug reports.
  | { phase: 'error'; message: string; details?: string }
  // Couldn't reach the server on launch, but downloaded books are on disk, so
  // we let the user into the app to play them. `retry` re-runs the connect.
  // `reason` is the plain headline for why, when we managed to classify it.
  | { phase: 'offline'; reason?: string }
  | { phase: 'ready'; serverName: string }

/**
 * Turn a thrown connect error into an error status. A ConnectionError already
 * carries a plain headline and the raw detail; anything else falls back to its
 * own message with no details row (there's nothing more to show).
 */
function errorStatus(e: unknown): ConnectionStatus {
  if (e instanceof ConnectionError) {
    return { phase: 'error', message: e.message, details: e.details || undefined }
  }
  return { phase: 'error', message: (e as Error)?.message ?? 'Something went wrong.' }
}

/**
 * One-line "why we're offline" for the banner. Only worth showing when the cause
 * is actionable (a typo, a down server, a rejected sign-in) - a plain "no
 * internet" adds nothing over the cloud-off icon, so that falls back to the
 * default copy. Kept short: the banner is a single narrow line.
 */
function offlineReason(e: unknown): string | undefined {
  if (!(e instanceof ConnectionError)) return undefined
  switch (e.kind) {
    case 'dns':
      return "Offline - can't find that server"
    case 'refused':
      return "Offline - server isn't answering"
    case 'timeout':
      return 'Offline - server timed out'
    case 'tls':
      return 'Offline - secure connection failed'
    case 'auth':
      return 'Offline - sign-in was rejected'
    case 'server':
      return 'Offline - the server had an error'
    default:
      return undefined
  }
}

/** How long to wait for the launch connect before treating it as stalled. The
 *  connect is a multi-hop handshake (two Clerk token mints + a control-plane
 *  grant + the server exchange), which on real cellular is comfortably slower
 *  than on the emulator's localhost - 7s tripped constantly on-device. A stall
 *  only becomes offline mode when the network is actually unreachable; when it's
 *  up (just slow), we retry instead (see connect()). */
const CONNECT_TIMEOUT_MS = 20000
/** Once, on a stall with the network still up, give the handshake a second try
 *  before giving up. */
const CONNECT_RETRIES = 1

/** How long a single Clerk getToken() may take before we give up on it and treat
 *  the mint as "no token yet".
 *
 *  Clerk's getToken has no internal timeout and can hang (not reject) when its
 *  client sync is wedged on an unresolvable host. Sized to match
 *  DEFAULT_FETCH_TIMEOUT_MS (10s) - the same budget every other single hop in
 *  the handshake gets - so it stays well inside the 20s connect race and leaves
 *  room for the retry. */
const TOKEN_MINT_TIMEOUT_MS = 10000

/** Hard ceiling on how long the covered "connecting" splash may stay up before
 *  we force a resolution (offline mode, or an actionable error screen).
 *
 *  Sized to sit ABOVE a legitimate worst-case connect - CONNECT_TIMEOUT_MS (20s)
 *  x (1 + CONNECT_RETRIES) = ~40s, plus handshake overhead - so it never cuts a
 *  connect that was still genuinely progressing. It is a deadlock breaker, not a
 *  connect timeout.
 *
 *  Must stay comfortably BELOW WATCHDOG_MS in lib/startupTrace.ts (60s): this
 *  floor is what disarms that watchdog (it resolves `connecting`, which settles
 *  the trace). When the two were 44s/45s apart they raced, and the watchdog
 *  reported stalls this floor had already fixed. Raising this above ~55s
 *  reintroduces that false-alarm class. */
const CONNECTING_FLOOR_MS = 44000

/** Headline for the offline banner when the user chose offline mode themselves,
 *  or when we grounded the launch before a handshake was even worth trying. */
const OFFLINE_REASON: Record<ConnectIssue, string | undefined> = {
  airplane: 'Offline - airplane mode is on',
  'no-network': 'Offline - no connection',
  unreachable: "Offline - can't reach your server",
  retrying: undefined,
}

class ConnectTimeoutError extends Error {
  constructor() {
    super('connect_timeout')
    this.name = 'ConnectTimeoutError'
  }
}

/** True if there's downloaded content worth entering offline mode for. */
function hasOfflineContent(): boolean {
  for (const e of getDownloadsState().byId.values()) {
    if (e.status === 'done') return true
  }
  return false
}

interface ConnectionValue {
  status: ConnectionStatus
  /** Server the active session is connected to, once ready. */
  serverName: string | null
  /** The signed-in user's role on the connected server. Drives admin-only UI
   *  (e.g. the Server Admin entry on the settings menu). Defaults to 'user'
   *  until we've connected to a server that reports a role. */
  activeRole: 'admin' | 'user'
  /** Re-run the whole connect flow from the top. */
  retry: () => void
  /** Stop waiting on the launch connect and go straight to downloaded books.
   *  No-op unless we're still `connecting`. */
  enterOffline: () => void
  /** Is there anything downloaded to go offline WITH? Gates the splash's
   *  "Enter offline mode" - it's not an escape hatch if it leads nowhere. */
  canGoOffline: boolean
  /** Connect to a specific linked server (from the picker). */
  connectTo: (server: SplashServer) => void
  /** Redeem a typed invite code, then connect. Resolves to a user-facing error
   *  message, or null on success (the connect flow takes over from there). */
  redeemInvite: (code: string) => Promise<string | null>
}

const Ctx = createContext<ConnectionValue | null>(null)

// Subscribe once to notePops changes so the car service's mirrored flag stays
// current after the user toggles the setting (the initial value is pushed at
// connect). Guarded so re-connects don't stack subscriptions.
let notePopsMirrorArmed = false
let lastMirroredNotePops: boolean | null = null
let carModeMirrorArmed = false
let skipMirrorArmed = false
let lastMirroredSkip: { back: number; forward: number } | null = null
let lastAutoSession: { serverUrl: string; token: string } | null = null
function ensureNotePopsMirror(): void {
  if (notePopsMirrorArmed) return
  notePopsMirrorArmed = true
  lastMirroredNotePops = getSettingsState().notePops
  subscribeSettings(() => {
    const next = getSettingsState().notePops
    if (next !== lastMirroredNotePops) {
      lastMirroredNotePops = next
      setAutoNotePops(next)
    }
  })
}

// Mirror the scrubber-scope setting (chapter vs whole book) into the CarPlay
// player so the car progress bar matches the phone. iOS-only inside the bridge;
// pushed at connect and kept in sync on change.
let chapterProgressMirrorArmed = false
let lastMirroredChapterProgress: boolean | null = null
function ensureChapterProgressMirror(): void {
  const push = () => {
    const next = getSettingsState().scrubber === 'chapter'
    if (next === lastMirroredChapterProgress) return
    lastMirroredChapterProgress = next
    setAutoChapterProgress(next)
  }
  push()
  if (chapterProgressMirrorArmed) return
  chapterProgressMirrorArmed = true
  subscribeSettings(push)
}

// Keep the native skip-second prefs in sync so the phone notification's
// rewind/forward buttons honor skipBack/skipForward. Independent of car mode -
// the notification is live during playback whether or not a car is connected.
function ensureSkipMirror(): void {
  const push = () => {
    const { skipBack, skipForward } = getSettingsState()
    if (lastMirroredSkip?.back === skipBack && lastMirroredSkip?.forward === skipForward) return
    lastMirroredSkip = { back: skipBack, forward: skipForward }
    setAutoSkipSeconds(skipBack, skipForward)
  }
  push()
  if (skipMirrorArmed) return
  skipMirrorArmed = true
  subscribeSettings(push)
}

function pushAutoSession(serverUrl: string, token: string): void {
  const { carMode, skipBack, skipForward } = getSettingsState()
  lastAutoSession = { serverUrl, token }
  if (carMode === 'off') clearAutoSession()
  else setAutoSession(serverUrl, token, skipBack, skipForward)
}

function ensureCarModeMirror(): void {
  if (carModeMirrorArmed) return
  carModeMirrorArmed = true
  subscribeSettings(() => {
    if (!lastAutoSession) return
    pushAutoSession(lastAutoSession.serverUrl, lastAutoSession.token)
  })
}

class NoLinkedServersError extends Error {
  constructor() {
    super('No linked servers on this account')
    this.name = 'NoLinkedServersError'
  }
}

/** Clerk can't mint a template token yet (still loading, e.g. right after network
 *  returns from an offline launch). We must NOT call the control plane with a null
 *  bearer - it 401s, which fires the session-expired handler and signs the user
 *  out. Instead we abort the connect and let the caller retry once Clerk loads. */
class NoTokenError extends Error {
  constructor() {
    super('clerk_not_loaded')
    this.name = 'NoTokenError'
  }
}

/** Snapshot library metadata for any completed downloads missing a catalog row,
 *  so they browse offline. Bridges the downloads store to the offline catalog. */
async function backfillDownloadedCatalog(): Promise<void> {
  const done = [...getDownloadsState().byId.values()].filter((e) => e.status === 'done')
  if (!done.length) return
  const durations = new Map(done.map((e) => [e.itemId, e.duration]))
  await backfillCatalog(
    done.map((e) => e.itemId),
    (id) => getItemDetail(id),
    (id) => durations.get(id) ?? 0,
    async (libraryId, seriesId) => {
      const all = await getLibrarySeries(libraryId)
      const match = all.find((s) => s.id === seriesId)
      return match ? { id: match.id, name: match.name, books: match.books ?? [] } : null
    },
  )
}

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const { getToken, isLoaded, isSignedIn } = useAuth()
  const [status, setStatus] = useState<ConnectionStatus>({ phase: 'connecting' })
  const [activeRole, setActiveRole] = useState<'admin' | 'user'>('user')
  // Does this device have a cached Clerk session (was signed in on a prior run)?
  //
  // Checked UNCONDITIONALLY - not only while `!isLoaded`. The old version bailed
  // out when Clerk had already loaded, which deadlocked the launch: Clerk can
  // report isLoaded=true with isSignedIn=false for a moment while a returning
  // user's session re-hydrates. In that window `effectiveSignedIn` was false, so
  // this provider held at `connecting` and NEVER ran connect - while AuthGate's
  // own `rehydrating` path (which does check the cache) still rendered the gate,
  // so the splash stayed up forever. Every recovery route was also disabled: the
  // isLoaded&&isSignedIn retry never fired, and the NetInfo watcher + foreground
  // probe are gated on effectiveSignedIn so they were never even armed. Only a
  // force-close escaped. Observed on an ONLINE Pixel 7 (Sentry HS-MOBILEAPP-3,
  // trace 8dd3e166: clerk-load 856ms and cached-session-check 42ms both COMPLETED,
  // and no connect:* span ever started).
  const [cachedSession, setCachedSession] = useState(false)
  useEffect(() => {
    void hasCachedClerkSession().then(setCachedSession)
  }, [])
  // A returning user mid-rehydration: Clerk hasn't confirmed the session yet, but
  // a cached JWT proves there is one. Mirrors AuthGate's `rehydrating` so the two
  // gates agree - when AuthGate decides to render the ConnectionGate, this
  // provider must be willing to actually connect behind it.
  const rehydrating = !isSignedIn && cachedSession
  const effectiveSignedIn = isSignedIn || rehydrating

  // getToken identity changes across renders; keep a stable wrapper.
  const getTokenRef = useRef(getToken)
  getTokenRef.current = getToken
  const tokenFn = useCallback(async (opts?: { forceRefresh?: boolean }) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // skipCache forces Clerk to mint a fresh JWT - used to retry a 401 that was
      // really just a stale cached token handed out during a warm resume.
      //
      // Bounded, because getToken() can HANG rather than reject: Clerk's client
      // sync has no timeout of its own, so a dead DNS lookup (backgrounded on a
      // dead network, resumed before the network returned - Sentry
      // HS-MOBILEAPP-8) leaves the promise pending indefinitely. Unbounded, that
      // burns the entire 20s connect race on a token mint that was never going
      // to resolve, so the retry never gets to run and the launch resolves to
      // offline via the 44s floor instead of reconnecting. Timing out to null
      // yields NoTokenError, which holds at `connecting` for the re-arm paths
      // (isSignedIn effect / NetInfo edge / foreground probe) to pick up.
      return await Promise.race([
        getTokenRef.current({
          template: CLERK_JWT_TEMPLATE,
          skipCache: opts?.forceRefresh,
        }),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), TOKEN_MINT_TIMEOUT_MS)
        }),
      ])
    } catch {
      return null
    } finally {
      if (timer) clearTimeout(timer)
    }
  }, [])

  const connectTo = useCallback(
    async (server: LinkedServer | SplashServer, opts?: { quiet?: boolean }) => {
      // A retry from offline mode stays on the banner (quiet) rather than flipping
      // to the covered connecting-splash: a failed retry must not yank the user out
      // of their downloaded books and back to a loading screen. Guarded on the
      // CURRENT phase too, so a connect still running after the user tapped "Enter
      // offline mode" (or after we dropped them there) can't re-cover the app.
      if (!opts?.quiet) {
        setStatus((cur) => (cur.phase === 'offline' ? cur : { phase: 'connecting' }))
      }
      try {
        const { serverUrl, token } = await tracePhase('connect:server-exchange', () =>
          connectServer(tokenFn, server.id, server.url),
        )
        await tracePhase('connect:set-session', () => setSession({ serverUrl, token }))
        await setLastServerId(server.id)
        // Ensure the per-install deviceId is loaded before sync starts, so
        // device-scoped settings round-trip on the first pull.
        await tracePhase('connect:ensure-device-id', () => ensureDeviceId())
        pushAutoSession(serverUrl, token)
        ensureCarModeMirror()
        // Push skip-second settings to native (phone notification honors these),
        // independent of car mode, and keep them in sync as the user changes them.
        ensureSkipMirror()
        // Mirror notePops into the car service (it can't read the settings store)
        // and keep it in sync as the user toggles it.
        setAutoNotePops(getSettingsState().notePops)
        ensureNotePopsMirror()
        ensureChapterProgressMirror()
        startQueueSync()
        startClubSync()
        // Release subscriptions + push: pull the follow list and register this
        // device for release notifications (both best-effort / self-guarding).
        void refreshSubscriptions()
        void ensurePushRegistered()
        // Now that a session exists, push any progress banked while offline.
        void flushPendingProgress()
        // Backfill offline browse metadata for any downloads missing it (books
        // downloaded before the catalog existed). Online-only; best-effort.
        void backfillDownloadedCatalog()
        // Cache the server's recent listening sessions for downloaded books so
        // Recent Listens still has history once the server goes away. It has to
        // happen on connect - waiting for the user to open the sheet while online
        // misses the common case (open the app, lose the network, look for your
        // listens). One request, best-effort.
        void refreshSessionCache()
        // The picker path (SplashServer) has no role; only linked-server objects
        // carry it. Fall back to 'user' so admin UI stays hidden when unknown.
        setActiveRole('role' in server && server.role === 'admin' ? 'admin' : 'user')
        setStatus({ phase: 'ready', serverName: server.name })
      } catch (e) {
        // A failed connect to a specific server drops to offline mode whenever
        // there's downloaded content - whether it was a quiet (offline-origin)
        // retry or the user picking a server that turns out unreachable (e.g.
        // their home server is down but the phone is still on Wi-Fi). A dead-end
        // error screen would needlessly hide the downloaded books they can still
        // play. Only with nothing downloaded is a hard error the right outcome.
        if (hasOfflineContent()) setStatus({ phase: 'offline', reason: offlineReason(e) })
        else setStatus(errorStatus(e))
      }
    },
    [tokenFn],
  )

  const runConnect = useCallback(
    async (opts?: { quiet?: boolean }) => {
      // Guard the control plane against a null bearer: offline, or in the window
      // right after network returns while Clerk is still re-hydrating, getToken
      // yields null. Calling /servers with no token 401s -> session-expired ->
      // sign-out. Bail here so the retry loop waits for Clerk instead.
      if (!(await tracePhase('connect:token-mint', () => tokenFn()))) throw new NoTokenError()

      // Redeem a pending invite (from an /invite?token= universal link that
      // arrived while signed out) before listing, so the newly linked server is
      // present and we can jump straight into it. Best-effort: a bad/expired
      // token just falls through to the normal precedence below.
      let invitedServerId: string | null = null
      const pendingToken = await takePendingInviteToken()
      if (pendingToken) {
        try {
          const { serverId } = await acceptInvite(tokenFn, pendingToken)
          invitedServerId = serverId
        } catch {
          invitedServerId = null
        }
      }

      const servers = await tracePhase('connect:fetch-servers', () => fetchLinkedServers(tokenFn))
      if (servers.length === 0) throw new NoLinkedServersError()

      // An accepted invite wins precedence: connect straight to that server.
      if (invitedServerId) {
        const invited = servers.find((s) => s.id === invitedServerId)
        if (invited) {
          await setLastServerId(invited.id)
          await connectTo(invited, opts)
          return
        }
      }

      if (servers.length === 1) {
        await connectTo(servers[0], opts)
        return
      }
      // Precedence: this device's last-used server, then the account default
      // (set on another device), then show the picker.
      const lastId = await getLastServerId()
      const remembered = lastId ? servers.find((s) => s.id === lastId) : undefined
      const preferred = remembered ?? servers.find((s) => s.isDefault)
      if (preferred) await connectTo(preferred, opts)
      else setStatus({ phase: 'select-server', servers })
    },
    [connectTo, tokenFn],
  )

  // Latest status phase, readable inside the connect closure (which can't see
  // React state directly). Lets a retry that starts from `offline` stay quiet -
  // it keeps the offline banner up instead of flipping to the covered splash.
  const statusRef = useRef(status)
  statusRef.current = status

  /**
   * Leave the covered splash for offline mode, without stopping whatever connect
   * is still running - it may yet succeed and flip us to `ready`.
   *
   * Only acts while we're still `connecting`, so it can never clobber a phase that
   * already landed. With nothing downloaded there's nowhere to drop TO, so the
   * splash stays up and only the explanation changes.
   */
  const dropToOffline = useCallback((issue: ConnectIssue) => {
    setStatus((cur) => {
      if (cur.phase !== 'connecting') return cur
      if (!hasOfflineContent()) return { ...cur, issue }
      return { phase: 'offline', reason: OFFLINE_REASON[issue] }
    })
  }, [])

  /**
   * Is the device grounded - airplane mode, or no network interface at all?
   *
   * Checked BEFORE the handshake, because there is nothing to retry against: the
   * launch used to spend its full 20s connect timeout (and a retry, and the 44s
   * floor) discovering what the OS could have told us instantly. Both checks are
   * local, so this costs nothing.
   */
  const groundedReason = useCallback(async (): Promise<ConnectIssue | null> => {
    if (await isAirplaneMode()) return 'airplane'
    if (!(await isCurrentlyReachable())) return 'no-network'
    return null
  }, [])

  const connectingRef = useRef(false)
  const connect = useCallback(async () => {
    // One attempt at a time: Retry, the NetInfo watcher, and the foreground probe
    // can all fire together after signal returns. A second concurrent connect
    // would race the first and could overwrite `ready` with `offline`.
    if (connectingRef.current) return
    connectingRef.current = true
    // Retrying from offline mode: don't uncover the splash. Stay on the offline
    // banner and only leave it if the reconnect actually succeeds.
    const quiet = statusRef.current.phase === 'offline'
    // Never re-cover the app once we've left `connecting` (the user tapped "Enter
    // offline mode", or a probe dropped us there while the handshake ran on).
    const showConnecting = (
      patch: Omit<Extract<ConnectionStatus, { phase: 'connecting' }>, 'phase'>,
    ) => {
      if (quiet) return
      setStatus((cur) => (cur.phase === 'connecting' ? { phase: 'connecting', ...patch } : cur))
    }
    if (!quiet) setStatus({ phase: 'connecting' })
    try {
      // Grounded (airplane mode / no network): resolve the SCREEN now rather than
      // making the user watch a retry window that can't succeed. A failed
      // pre-check is not a failed connect, so it falls through to a normal try.
      const grounded = await groundedReason().catch(() => null)
      if (grounded && !quiet) {
        if (hasOfflineContent()) {
          setStatus({ phase: 'offline', reason: OFFLINE_REASON[grounded] })
        } else {
          setStatus({
            phase: 'error',
            message:
              grounded === 'airplane'
                ? 'Airplane mode is on, so there’s no way to reach your library.'
                : 'No internet connection.',
          })
        }
      }
      // Airplane mode is the one case worth NOT attempting: the user asked the OS
      // for no radios, so a handshake is guaranteed noise. The NetInfo watcher
      // fires the moment they turn it off, and Retry is on screen meanwhile.
      if (grounded === 'airplane') return
      // "No network" we still try behind the resolved screen - NetInfo can be
      // wrong (or stale on a cold start), and a connect that lands quietly
      // upgrades the user to `ready` instead of stranding them offline until the
      // next network edge. Every status write below is guarded on still being
      // `connecting`, so this attempt can't re-cover the app.

      // Try the handshake, retrying a stall as long as the network is actually up -
      // a slow first connect on cellular shouldn't strand a connected user in
      // offline mode. Only a genuinely unreachable network (or exhausted retries)
      // falls back to offline.
      for (let attempt = 0; ; attempt++) {
        try {
          showConnecting({ attempt: attempt + 1, maxAttempts: CONNECT_RETRIES + 1 })
          // Actively confirm the internet is reachable WHILE the handshake runs.
          // This is what makes a dead WAN resolve in ~3.5s instead of ~44s: the
          // handshake keeps going (and still wins if it lands), but the user stops
          // staring at a covered splash for a connect that isn't coming.
          void probeReachable().then((ok) => {
            if (!ok) dropToOffline('unreachable')
          })
          // Race the connect against a timeout: a dead network can leave the ABS
          // fetch hanging well past when we should stop waiting.
          let timer: ReturnType<typeof setTimeout> | undefined
          const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new ConnectTimeoutError()), CONNECT_TIMEOUT_MS)
          })
          try {
            await Promise.race([runConnect({ quiet }), timeout])
          } finally {
            if (timer) clearTimeout(timer)
          }
          return
        } catch (e) {
          if (e instanceof NoLinkedServersError) {
            setStatus({ phase: 'no-servers' })
            return
          }
          // Clerk can't mint a token yet (still re-hydrating a returning user's
          // session). This is NOT a network problem, so don't burn a retry or
          // fall through to offline/error - just hold at `connecting`. The
          // isLoaded&&isSignedIn effect re-runs connect the moment Clerk settles,
          // and the foreground probe covers the case where it never does.
          if (e instanceof NoTokenError) {
            showConnecting({})
            return
          }
          // If the internet is actually reachable, this was slowness, not
          // offline - retry (up to the cap) before giving up. probeReachable
          // hits the control plane with a short timeout, so a phone on a Wi-Fi
          // router with a dead WAN (looks "connected" to NetInfo) fails the
          // probe and drops to offline immediately instead of grinding through
          // the full retry window. It's conservative on a server-side hiccup
          // (still counts as reachable), and the retry cap bounds any looping.
          const reachable = await probeReachable()
          if (reachable && attempt < CONNECT_RETRIES) {
            // Say so on the splash: "still working" reads very differently from
            // "we hit a problem and are trying again", and the second one is what
            // tells a user with a dead router that offline mode is their move.
            showConnecting({
              attempt: attempt + 2,
              maxAttempts: CONNECT_RETRIES + 1,
              issue: 'retrying',
            })
            continue
          }
          // Truly unreachable (or out of retries): play downloads offline rather
          // than stranding the user on an error.
          if (hasOfflineContent()) setStatus({ phase: 'offline', reason: offlineReason(e) })
          else setStatus(errorStatus(e))
          return
        }
      }
    } finally {
      connectingRef.current = false
    }
  }, [runConnect, groundedReason, dropToOffline])

  // Load downloaded books once at mount, before any connect attempt - offline
  // launch depends on the manifest being in memory to detect downloaded content
  // and to resolve local playback. Runs regardless of auth/connection state.
  useEffect(() => {
    void hydrateDownloads()
    void hydrateCatalog()
    // Last-known server listening history for downloaded books, so Recent Listens
    // has something to show on an offline start.
    void hydrateSessionCache()
    // Load last-known media progress from disk so downloaded books show their
    // real position/finished state on an offline cold start (the server refresh
    // that used to be the only source can't run with no network).
    void hydrateProgress()
    // Ordered, unlike the rest: the pending ledger must be loaded before the
    // streaming buffer migrates into it, and the migration must finish before
    // playback can open a session whose writes would race it.
    void (async () => {
      await hydratePendingProgress()
      await hydrateStreamingBuffer()
      // A surviving streaming buffer means the app died mid-stream last run;
      // fold that listening into the ledger so the normal flush ships it.
      await migrateOrphanStreaming()
      // Same reason, for the car: a listen the Android Auto service banked with no
      // network becomes a pending session here, so it replays to ABS like any
      // other offline listen instead of being lost. Must follow the hydrate - it
      // merges with whatever the phone already had pending for that book.
      await drainCarOfflineProgress()
    })()
    // Bookmarks written offline (or interrupted mid-push) live here until they
    // reach ABS; load them before any list renders so they're visible. The car's
    // queued ones fold in after, because this hydrate REPLACES the store.
    void (async () => {
      await hydratePendingBookmarks()
      await drainCarOfflineBookmarks()
    })()
    // Mirror the downloaded books into the car surface, and keep them mirrored:
    // the Android Auto service is headless and network-backed, so without this
    // snapshot an offline car has no book list and no controls at all. Not gated
    // on connecting - the whole point is the launch that never reaches a server.
    startOfflineLibrarySync()
  }, [])

  // Does this device have downloads to fall back on? Read reactively (the
  // downloads store hydrates from disk after mount) because it decides whether the
  // splash offers "Enter offline mode" at all - offering it with nothing
  // downloaded would just dump the user into an empty library.
  const [canGoOffline, setCanGoOffline] = useState(false)
  useEffect(() => {
    const sync = () => setCanGoOffline(hasOfflineContent())
    sync()
    return subscribeDownloads(sync)
  }, [])

  /**
   * The user telling us what we can't detect: "I know I'm offline, let me in."
   *
   * Doesn't cancel the connect in flight - if it lands, `ready` takes over and
   * they're online after all. This is about not making someone who already knows
   * their server is down watch a spinner run out its retries.
   */
  const enterOffline = useCallback(() => {
    setStatus((cur) => (cur.phase === 'connecting' ? { phase: 'offline' } : cur))
  }, [])

  // The provider is mounted for the whole app lifetime, signed in or not (screens
  // render once before the auth redirect lands, and stay mounted briefly during
  // sign-out). While signed out, hold at `connecting` instead of running a connect
  // that would fail on a null token; consumers treat anything short of `ready` as
  // loading, and the redirect to /sign-in takes over.
  useEffect(() => {
    if (!effectiveSignedIn) {
      setStatus({ phase: 'connecting' })
      return
    }
    void connect()
  }, [connect, effectiveSignedIn])

  // Keep the latest connect in a ref so the connectivity watcher (subscribed
  // once) and the AppState listener always call the current closure, not a stale
  // one - startConnectivityWatch is idempotent and won't re-bind a new callback.
  const connectRef = useRef(connect)
  connectRef.current = connect

  // Reconnect whenever we're not `ready` and the network looks available. The
  // shared trigger is used by both the NetInfo watcher and the foreground probe.
  const reconnectIfNeeded = useCallback(() => {
    setStatus((cur) => {
      if (cur.phase !== 'ready') void connectRef.current()
      return cur
    })
  }, [])

  // Re-attempt the connect the moment Clerk finishes loading a real session while
  // we're not ready. Critical after an offline launch: the NetInfo online-edge can
  // fire (and bail with NoTokenError) before Clerk has re-hydrated, so getToken was
  // still null. When Clerk's own retry finally loads it, `isSignedIn` flips true -
  // that's our cue to run the handshake again, now that a token can be minted.
  // Without this, the app stays in offline mode until the next network edge (which
  // may never come if the connection is stable), and only a force-close recovers.
  useEffect(() => {
    if (isLoaded && isSignedIn) reconnectIfNeeded()
  }, [isLoaded, isSignedIn, reconnectIfNeeded])

  // Backstop: `connecting` must never be terminal. If we're still on the covered
  // splash after this long, stop waiting and resolve to SOMETHING the user can
  // act on - offline mode when downloads exist, otherwise an error screen with
  // Retry / Manage servers / Log out.
  //
  // This exists because the launch could previously deadlock with no timer at
  // all: a returning user whose Clerk session was mid-rehydration left the
  // provider parked at `connecting` with every retry path disarmed, so the
  // splash stayed up until a force-close (Sentry HS-MOBILEAPP-3). The specific
  // deadlock is fixed above, but a hung launch is bad enough - and the failure
  // modes varied enough - to deserve an unconditional floor rather than trusting
  // that no future path can ever stall.
  useEffect(() => {
    if (status.phase !== 'connecting') return
    const t = setTimeout(() => {
      // Re-read through the setter so we never clobber a phase that landed while
      // the timer was pending.
      setStatus((cur) => {
        if (cur.phase !== 'connecting') return cur
        return hasOfflineContent()
          ? { phase: 'offline' }
          : {
              phase: 'error',
              message: 'Server took too long to respond.',
              details: `no answer within ${Math.round(CONNECTING_FLOOR_MS / 1000)}s`,
            }
      })
    }, CONNECTING_FLOOR_MS)
    return () => clearTimeout(t)
  }, [status.phase])

  // Watch connectivity for the whole signed-in lifetime: when the network
  // returns (incl. a Wi-Fi<->cellular handoff) while we're not `ready`, retry the
  // connect and flush pending progress. Event-driven (no polling).
  useEffect(() => {
    if (!effectiveSignedIn) return
    startConnectivityWatch(reconnectIfNeeded)
    return () => stopConnectivityWatch()
  }, [reconnectIfNeeded, effectiveSignedIn])

  // A sync that reached the server is direct proof the server is up, so recover
  // from a stale offline/error phase immediately. The other recovery paths are all
  // edge-triggered (network edge, foreground, Clerk flip) and a merely SLOW
  // connection produces no edge: a connect that lost the startup race to
  // CONNECTING_FLOOR_MS would otherwise leave the app showing a red sync icon and
  // an offline banner while playback was syncing to that same server just fine.
  useEffect(() => {
    if (!effectiveSignedIn) return
    return subscribeServerReached(reconnectIfNeeded)
  }, [reconnectIfNeeded, effectiveSignedIn])

  // Also re-probe on foreground: NetInfo can miss a network change that happened
  // while backgrounded (or a handoff that never dipped offline), which otherwise
  // strands the app in offline mode until a manual relaunch. Returning to the app
  // always re-attempts the connect if we're not already `ready`.
  useEffect(() => {
    if (!effectiveSignedIn) return
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return
      void pokeConnectivity(reconnectIfNeeded)
      // The car may have played downloads offline while we were backgrounded;
      // collect that listening now so the reconnect above can ship it.
      void drainCarOfflineWork()
    })
    return () => sub.remove()
  }, [reconnectIfNeeded, effectiveSignedIn])

  const serverName = status.phase === 'ready' ? status.serverName : null

  /**
   * Redeem a code the user typed on the no-servers screen. Unlike the deep-link
   * path in runConnect (which swallows failures and falls through), this is a
   * deliberate user action, so every failure needs its own plain-language
   * message - "expired", "already used", and "typo" are different problems with
   * different fixes, and one generic toast for all three leaves them stuck.
   */
  const redeemInvite = useCallback(
    async (code: string): Promise<string | null> => {
      try {
        await acceptInvite(tokenFn, code)
      } catch (err) {
        if (err instanceof ApiError) {
          if (err.status === 404) return "That code didn't work. Check it and try again."
          if (err.status === 429) return 'Too many tries. Wait a bit and try again.'
          if (err.status === 401) return 'Please sign in again to use this code.'
        }
        return 'Something went wrong. Check your connection and try again.'
      }
      void connect()
      return null
    },
    [connect, tokenFn],
  )

  return (
    <Ctx.Provider
      value={{
        status,
        serverName,
        activeRole,
        retry: () => void connect(),
        enterOffline,
        canGoOffline,
        connectTo,
        redeemInvite,
      }}
    >
      {children}
    </Ctx.Provider>
  )
}

export function useConnection(): ConnectionValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useConnection must be used within a ConnectionProvider')
  return v
}
