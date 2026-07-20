/**
 * Event-driven connectivity handling for offline mode. Two OS-supported paths,
 * neither of which polls, so nothing runs (and no battery is spent) while the
 * device stays offline:
 *
 * 1. Foreground: NetInfo fires a callback when connectivity actually changes.
 *    On a transition to online we notify the ConnectionProvider (retry connect)
 *    and flush any progress recorded offline.
 *
 * 2. Backgrounded/killed: an expo-background-task. The OS (WorkManager on
 *    Android, BGTaskScheduler on iOS) runs it opportunistically - batched with
 *    other system wakeups, when conditions are favorable - to push the last
 *    position even if the app is no longer foreground. The task self-guards on
 *    pendingCount() and getSession(), so a wake with nothing to do (or still
 *    offline) is cheap and leaves the work for a later wake.
 *
 * Native modules (NetInfo, expo-background-task); their runtime behavior can only
 * be verified in a dev build, not in this environment.
 */
import NetInfo, { type NetInfoState } from '@react-native-community/netinfo'
import * as BackgroundTask from 'expo-background-task'
import * as TaskManager from 'expo-task-manager'
import { CONTROL_PLANE_URL } from '@/lib/config'
import { flushPendingProgress, BACKGROUND_FLUSH_TASK } from './pendingProgress'

let unsub: (() => void) | null = null
let lastOnline: boolean | null = null
let lastType: string | null = null

function isOnline(s: NetInfoState): boolean {
  // isInternetReachable is null until the first probe resolves; treat null as
  // "assume reachable if connected" so we don't miss the initial online edge.
  return !!s.isConnected && s.isInternetReachable !== false
}

/**
 * One-shot: is the device currently on a network? Used to tell a slow connect
 * (network up, handshake just slow -> retry) from a truly offline one (network
 * down -> offline mode). Conservative: any error assumes online, so we never
 * strand a connected user in offline mode on a NetInfo hiccup.
 */
export async function isCurrentlyReachable(): Promise<boolean> {
  try {
    return isOnline(await NetInfo.fetch())
  } catch {
    return true
  }
}

/** How long to wait for the reachability probe before calling the internet down.
 *  Short: this only decides slow-retry vs. offline on a connect stall, and the
 *  user is already staring at the splash. */
const PROBE_TIMEOUT_MS = 3500

/**
 * Actively confirm the internet is reachable, not just that a network interface
 * is up. `isCurrentlyReachable` (NetInfo) returns true whenever Wi-Fi is
 * connected - so a phone on a Wi-Fi router whose WAN is down looks "online" and
 * a connect stall gets treated as mere slowness, burning the full retry window
 * before falling to offline mode. This hits the control plane with a hard
 * timeout: if the network is genuinely dead, it fails fast and we can drop to
 * offline immediately.
 *
 * Reaches the control plane (a host separate from the user's own server), so it
 * answers "is the internet up?" not "is my home server up?" - either being down
 * with downloads present is a valid reason to enter offline mode, and the
 * caller already handles the server-specific failure.
 *
 * Conservative on ambiguity: a NetInfo "definitely offline" reading short-
 * circuits to false, but a probe error other than a clean fetch-failure (e.g.
 * the endpoint 500s) still counts as reachable, so we never strand a connected
 * user offline over a server-side hiccup.
 */
export async function probeReachable(): Promise<boolean> {
  // Fast path: NetInfo is certain we're offline.
  try {
    const s = await NetInfo.fetch()
    if (!s.isConnected || s.isInternetReachable === false) return false
  } catch {
    // fall through to the active probe
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    // A HEAD to the control-plane origin; any HTTP response (even 404/405) proves
    // the internet is reachable. `no-store` so a cached 200 can't mask a dead WAN.
    await fetch(`${CONTROL_PLANE_URL}/`, {
      method: 'HEAD',
      cache: 'no-store',
      signal: controller.signal,
    })
    return true
  } catch {
    // An abort (timeout) or a network failure both mean unreachable.
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Start watching connectivity. `onOnline` fires when the device is online and
 * either it wasn't online on the previous event OR the network type changed
 * (Wi-Fi<->cellular). That second condition matters: a handoff can stay
 * "connected" the whole time and never emit a `false`, so a strict
 * offline->online edge misses it and leaves the app stuck in offline mode until a
 * manual relaunch. The caller decides whether a reconnect is actually needed
 * (no-op when already `ready`), so a redundant fire is cheap. Pending progress
 * flushes on the same edge.
 *
 * Idempotent - a second call while watching is a no-op. Also registers the
 * background flush task so progress can sync while the app isn't foreground.
 */
export function startConnectivityWatch(onOnline: () => void): void {
  void ensureBackgroundFlushRegistered()
  if (unsub) return
  unsub = NetInfo.addEventListener((s) => {
    const online = isOnline(s)
    // Fire when we're online AND either we weren't online last event, or the
    // network TYPE changed (a Wi-Fi<->cellular handoff can stay "connected" the
    // whole time and never emit a `false`, so a strict offline->online edge would
    // miss it and leave the app stuck offline). The caller no-ops when already
    // `ready`, so a redundant fire on a type change is cheap.
    if (online && (lastOnline !== true || (lastType !== null && s.type !== lastType))) {
      onOnline()
      void flushPendingProgress()
    }
    lastOnline = online
    lastType = s.type
  })
}

/** Force a reconnect probe from outside the NetInfo edge - e.g. the user tapping
 *  "Retry" in offline mode, or the app returning to the foreground. Runs the
 *  caller's handler if the device currently looks online. */
export async function pokeConnectivity(onOnline: () => void): Promise<void> {
  if (await isCurrentlyReachable()) {
    onOnline()
    void flushPendingProgress()
  }
}

export function stopConnectivityWatch(): void {
  unsub?.()
  unsub = null
  lastOnline = null
  lastType = null
}

/**
 * Register (once) an OS background task that flushes pending progress when the
 * network returns. The task itself is defined at module load in
 * backgroundFlushTask.ts so a headless invocation can find it.
 */
async function ensureBackgroundFlushRegistered(): Promise<void> {
  try {
    const already = await TaskManager.isTaskRegisteredAsync(BACKGROUND_FLUSH_TASK)
    if (already) return
    // minimumInterval is a floor (minutes); the OS picks the actual wake time.
    // The task itself bails cheaply when there's nothing pending or we're still
    // offline, so an early/idle wake costs almost nothing.
    await BackgroundTask.registerTaskAsync(BACKGROUND_FLUSH_TASK, {
      minimumInterval: 15,
    })
  } catch {
    // Background task unavailable (e.g. unsupported platform); the foreground
    // NetInfo path still covers reconnect-while-open.
  }
}

/** Unregister the background task (e.g. on sign-out). Best-effort. */
export async function unregisterBackgroundFlush(): Promise<void> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_FLUSH_TASK)) {
      await BackgroundTask.unregisterTaskAsync(BACKGROUND_FLUSH_TASK)
    }
  } catch {
    // ignore
  }
}
