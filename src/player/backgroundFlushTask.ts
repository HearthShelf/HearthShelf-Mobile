/**
 * Defines the OS background task that flushes offline progress. Must be imported
 * for its side effect at app entry (index.js) so TaskManager.defineTask runs
 * before the JS engine settles - a headless OS wake looks the task up by name and
 * needs the definition already present.
 *
 * A headless wake has no React tree and no in-memory session, so the task
 * rehydrates the session singleton and the pending store from storage before
 * flushing. Failures leave items pending (flushPendingProgress swallows them), so
 * a stale token just retries on the next wake rather than losing the position.
 *
 * Native modules (expo-task-manager); runtime behavior is only verifiable in a
 * dev build.
 */
import * as TaskManager from 'expo-task-manager'
import * as BackgroundTask from 'expo-background-task'
import { hydrateSession } from '@/api/session'
import { currentNetworkScope } from '@/api/candidates'
import {
  hydratePendingProgress,
  hydrateStreamingBuffer,
  migrateOrphanStreaming,
  flushPendingProgress,
  pendingCount,
  BACKGROUND_FLUSH_TASK,
} from './pendingProgress'
import {
  hydratePendingBookmarks,
  flushPendingBookmarks,
  getPendingBookmarkState,
} from './pendingBookmarks'

TaskManager.defineTask(BACKGROUND_FLUSH_TASK, async () => {
  try {
    await hydratePendingProgress()
    // A headless wake right after the app was killed mid-stream is exactly when
    // an orphaned streaming buffer exists - fold it in before counting, so the
    // lost listening flushes on this wake rather than waiting for a launch.
    await hydrateStreamingBuffer()
    await migrateOrphanStreaming()
    await hydratePendingBookmarks()
    const bookmarks = getPendingBookmarkState()
    const haveBookmarks = bookmarks.creates.length > 0 || bookmarks.deletes.length > 0
    if (pendingCount() === 0 && !haveBookmarks) return BackgroundTask.BackgroundTaskResult.Success
    // Pass the CURRENT network so a LAN-scoped session is reusable when we really
    // are back on that Wi-Fi (the offline-listening case this task exists for),
    // while hydrateSession still refuses a private origin anywhere else - a
    // background task can wake on cellular or a different network, where a
    // remembered 192.168.x.y would fail or reach an unrelated device.
    const scope = (await currentNetworkScope().catch(() => null)) ?? undefined
    await hydrateSession(scope)
    await flushPendingProgress()
    await flushPendingBookmarks()
    return BackgroundTask.BackgroundTaskResult.Success
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed
  }
})
