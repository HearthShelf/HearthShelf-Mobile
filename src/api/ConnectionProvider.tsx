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
import { fetchLinkedServers, type LinkedServer } from './controlPlane'
import { connectServer } from './connect'
import { setSession, setLastServerId, getLastServerId } from './session'
import { CLERK_JWT_TEMPLATE } from '@/lib/config'
import { hasCachedClerkSession } from '@/lib/tokenCache'
import { clearAutoSession, setAutoSession, setAutoNotePops } from '@/player/autoBridge'
import { startQueueSync } from '@/player/queueSync'
import { startClubSync } from '@/player/clubSync'
import { ensureDeviceId, getSettingsState, subscribeSettings } from '@/store/settings'
import { hydrateDownloads, getDownloadsState } from '@/player/downloads'
import { hydrateCatalog, backfillCatalog } from '@/player/offlineCatalog'
import { getItemDetail, getLibrarySeries } from './abs'
import {
  startConnectivityWatch,
  stopConnectivityWatch,
  isCurrentlyReachable,
  pokeConnectivity,
} from '@/player/connectivity'
import { hydratePendingProgress, flushPendingProgress } from '@/player/pendingProgress'
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
}

const Ctx = createContext<ConnectionValue | null>(null)

// Subscribe once to notePops changes so the car service's mirrored flag stays
// current after the user toggles the setting (the initial value is pushed at
// connect). Guarded so re-connects don't stack subscriptions.
let notePopsMirrorArmed = false
let lastMirroredNotePops: boolean | null = null
let carModeMirrorArmed = false
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
  // Offline, Clerk never loads (isSignedIn stays undefined). If a session is
  // cached, treat the user as signed in so the connect flow runs and falls back
  // to the offline phase via its own timeout - otherwise we'd park on the splash.
  const [cachedSession, setCachedSession] = useState(false)
  useEffect(() => {
    if (isLoaded) return
    void hasCachedClerkSession().then(setCachedSession)
  }, [isLoaded])
  const effectiveSignedIn = isSignedIn || (!isLoaded && cachedSession)

  // getToken identity changes across renders; keep a stable wrapper.
  const getTokenRef = useRef(getToken)
  getTokenRef.current = getToken
  const tokenFn = useCallback(async () => {
    try {
      return await getTokenRef.current({ template: CLERK_JWT_TEMPLATE })
    } catch {
      return null
    }
  }, [])

  const connectTo = useCallback(
    async (server: LinkedServer | SplashServer) => {
      setStatus({ phase: 'connecting' })
      try {
        const { serverUrl, token } = await connectServer(tokenFn, server.id, server.url)
        await setSession({ serverUrl, token })
        await setLastServerId(server.id)
        // Ensure the per-install deviceId is loaded before sync starts, so
        // device-scoped settings round-trip on the first pull.
        await ensureDeviceId()
        pushAutoSession(serverUrl, token)
        ensureCarModeMirror()
        // Mirror notePops into the car service (it can't read the settings store)
        // and keep it in sync as the user toggles it.
        setAutoNotePops(getSettingsState().notePops)
        ensureNotePopsMirror()
        startQueueSync()
        startClubSync()
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
        setStatus({ phase: 'error', message: (e as Error).message })
      }
    },
    [tokenFn],
  )

  const runConnect = useCallback(async () => {
    const servers = await fetchLinkedServers(tokenFn)
    if (servers.length === 0) throw new NoLinkedServersError()
    if (servers.length === 1) {
      await connectTo(servers[0])
      return
    }
    // Precedence: this device's last-used server, then the account default
    // (set on another device), then show the picker.
    const lastId = await getLastServerId()
    const remembered = lastId ? servers.find((s) => s.id === lastId) : undefined
    const preferred = remembered ?? servers.find((s) => s.isDefault)
    if (preferred) await connectTo(preferred)
    else setStatus({ phase: 'select-server', servers })
  }, [connectTo, tokenFn])

  const connectingRef = useRef(false)
  const connect = useCallback(async () => {
    // One attempt at a time: Retry, the NetInfo watcher, and the foreground probe
    // can all fire together after signal returns. A second concurrent connect
    // would race the first and could overwrite `ready` with `offline`.
    if (connectingRef.current) return
    connectingRef.current = true
    setStatus({ phase: 'connecting' })
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
            await Promise.race([runConnect(), timeout])
          } finally {
            if (timer) clearTimeout(timer)
          }
          return
        } catch (e) {
          if (e instanceof NoLinkedServersError) {
            setStatus({ phase: 'no-servers' })
            return
          }
          // If the network is up, this was slowness, not offline - retry (up to
          // the cap) before giving up. isCurrentlyReachable is conservative
          // (assumes online on any error), so we never loop forever on a NetInfo
          // hiccup: the retry cap still bounds it.
          const reachable = await isCurrentlyReachable()
          if (reachable && attempt < CONNECT_RETRIES) {
            setStatus({ phase: 'connecting' })
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

  // Watch connectivity for the whole signed-in lifetime: when the network
  // returns (incl. a Wi-Fi<->cellular handoff) while we're not `ready`, retry the
  // connect and flush pending progress. Event-driven (no polling).
  useEffect(() => {
    if (!effectiveSignedIn) return
    startConnectivityWatch(reconnectIfNeeded)
    return () => stopConnectivityWatch()
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

  return (
    <Ctx.Provider
      value={{ status, serverName, activeRole, retry: () => void connect(), connectTo }}
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
