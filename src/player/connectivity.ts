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
import { flushPendingProgress, BACKGROUND_FLUSH_TASK } from './pendingProgress'

let unsub: (() => void) | null = null
let lastOnline: boolean | null = null

function isOnline(s: NetInfoState): boolean {
  // isInternetReachable is null until the first probe resolves; treat null as
  // "assume reachable if connected" so we don't miss the initial online edge.
  return !!s.isConnected && s.isInternetReachable !== false
}

/**
 * Start watching connectivity. `onOnline` is called on each offline->online
 * transition (and pending progress is flushed). Idempotent - a second call while
 * already watching is a no-op. Also ensures the background flush task is
 * registered so progress can sync while the app isn't foreground.
 */
export function startConnectivityWatch(onOnline: () => void): void {
  void ensureBackgroundFlushRegistered()
  if (unsub) return
  unsub = NetInfo.addEventListener((s) => {
    const online = isOnline(s)
    // Only act on the transition into online, not every event.
    if (online && lastOnline === false) {
      onOnline()
      void flushPendingProgress()
    }
    lastOnline = online
  })
}

export function stopConnectivityWatch(): void {
  unsub?.()
  unsub = null
  lastOnline = null
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
