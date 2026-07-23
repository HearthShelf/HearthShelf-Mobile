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
} from '@/player/autoBridge'
import { startQueueSync } from '@/player/queueSync'
import { refreshSubscriptions } from '@/player/subscriptions'
import { ensurePushRegistered } from '@/player/pushRegister'
import { startClubSync } from '@/player/clubSync'
import { ensureDeviceId, getSettingsState, subscribeSettings } from '@/store/settings'
import { hydrateDownloads, getDownloadsState } from '@/player/downloads'
import { hydrateCatalog, backfillCatalog } from '@/player/offlineCatalog'
import { getItemDetail, getLibrarySeries } from './abs'
import {
  startConnectivityWatch,
  stopConnectivityWatch,
  probeReachable,
  pokeConnectivity,
} from '@/player/connectivity'
import { hydratePendingProgress, flushPendingProgress } from '@/player/pendingProgress'
import { subscribeServerReached } from '@/player/syncState'
import { hydrateProgress } from '@/store/progress'
import type { SplashServer } from '@/ui/SplashScreen'

export type ConnectionStatus =
  | { phase: 'connecting' }
  | { phase: 'select-server'; servers: LinkedServer[] }
  | { phase: 'no-servers' }
  | { phase: 'error'; message: string }
  // Couldn't reach the server on launch, but downloaded books are on disk, so
  // we let the user into the app to play them. `retry` re-runs the connect.
  | { phase: 'offline' }
  | { phase: 'ready'; serverName: string }

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
      // of their downloaded books and back to a loading screen.
      if (!opts?.quiet) setStatus({ phase: 'connecting' })
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
        if (hasOfflineContent()) setStatus({ phase: 'offline' })
        else setStatus({ phase: 'error', message: (e as Error).message })
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
    if (!quiet) setStatus({ phase: 'connecting' })
    try {
      // Try the handshake, retrying a stall as long as the network is actually up -
      // a slow first connect on cellular shouldn't strand a connected user in
      // offline mode. Only a genuinely unreachable network (or exhausted retries)
      // falls back to offline.
      for (let attempt = 0; ; attempt++) {
        try {
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
            if (!quiet) setStatus({ phase: 'connecting' })
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
            if (!quiet) setStatus({ phase: 'connecting' })
            continue
          }
          // Truly unreachable (or out of retries): play downloads offline rather
          // than stranding the user on an error.
          if (hasOfflineContent()) setStatus({ phase: 'offline' })
          else setStatus({ phase: 'error', message: (e as Error).message })
          return
        }
      }
    } finally {
      connectingRef.current = false
    }
  }, [runConnect])

  // Load downloaded books once at mount, before any connect attempt - offline
  // launch depends on the manifest being in memory to detect downloaded content
  // and to resolve local playback. Runs regardless of auth/connection state.
  useEffect(() => {
    void hydrateDownloads()
    void hydratePendingProgress()
    void hydrateCatalog()
    // Load last-known media progress from disk so downloaded books show their
    // real position/finished state on an offline cold start (the server refresh
    // that used to be the only source can't run with no network).
    void hydrateProgress()
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
          : { phase: 'error', message: 'connect_stalled' }
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
      if (s === 'active') void pokeConnectivity(reconnectIfNeeded)
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
