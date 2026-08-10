/**
 * Keeps the Android Auto car surface working with no server.
 *
 * The car service is deliberately headless and network-backed: it reads the ABS
 * server URL + token out of SharedPreferences and fetches the browse tree and the
 * audio itself, so it works even when the RN app was never opened. The cost of
 * that design is that with no network it had NOTHING - no book list, no controls,
 * an empty app - even though the phone right next to it has books on disk.
 *
 * So this module mirrors the downloaded books (local file paths, chapters, cover,
 * saved position) into the same prefs the car already reads, and folds the work
 * the car did offline back into the app:
 *
 *  - publishOfflineLibrary(): snapshot -> prefs, re-published whenever downloads,
 *    catalog metadata, or progress change.
 *  - drainCarOfflineWork(): the position/listened-time the car banked while
 *    offline becomes a pending ABS session (replayed on reconnect like a phone
 *    offline listen), and any bookmark it couldn't POST is pushed.
 *
 * Android only - iOS CarPlay routes taps up to JS, which already resolves
 * downloads through playItemById().
 */
import { Platform } from 'react-native'
import {
  setAutoOfflineLibrary,
  getAutoOfflineProgress,
  clearAutoOfflineProgress,
  getAutoOfflineBookmarks,
  clearAutoOfflineBookmarks,
  type AutoOfflineBook,
} from './autoBridge'
import { getDownloadsState, subscribeDownloads } from './downloads'
import { getCatalogState, subscribeCatalog } from './offlineCatalog'
import {
  getProgressState,
  subscribeProgress,
  recordLocalProgress,
  markFinished,
} from '@/store/progress'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { getPendingSessionState, recordLocalSession, flushPendingProgress } from './pendingProgress'
import { addBookmarkPending } from './pendingBookmarks'

/** Coalesce the burst of store writes a hydrate or a finished download produces
 *  into one snapshot push. */
const PUBLISH_DEBOUNCE_MS = 500

let publishTimer: ReturnType<typeof setTimeout> | null = null
let watching = false
let lastPublished: string | null = null

/** Build the snapshot the car browses offline: every completed download, enriched
 *  with the catalog's browse metadata and the last known position. */
function buildOfflineLibrary(): AutoOfflineBook[] {
  const catalog = getCatalogState().byId
  const progress = getProgressState().byId
  const books: AutoOfflineBook[] = []
  for (const e of getDownloadsState().byId.values()) {
    if (e.status !== 'done' || e.tracks.length === 0) continue
    const meta = catalog.get(e.itemId)
    const series = meta?.series[0]
    const p = progress.get(e.itemId)
    books.push({
      id: e.itemId,
      title: e.title || meta?.title || 'Untitled',
      sortKey: meta?.titleIgnorePrefix || e.title || 'Untitled',
      author: e.author || meta?.author || '',
      cover: e.coverUri ?? '',
      duration: e.duration || meta?.duration || 0,
      position: p?.currentTime ?? 0,
      finished: p?.isFinished === true,
      addedAt: meta?.addedAt ?? 0,
      seriesId: series?.id ?? '',
      seriesName: series?.name ?? '',
      // ABS sequences are strings ("3", "3.5"); the car sorts numerically.
      sequence: Number(series?.sequence ?? 0) || 0,
      chapters: e.chapters.map((c) => ({ title: c.title, start: c.start, end: c.end })),
      tracks: e.tracks.map((t) => ({
        uri: t.uri,
        startOffset: t.startOffset,
        duration: t.duration,
      })),
    })
  }
  return books
}

/**
 * Push the current downloads to the car surface. Skipped when car mode is off -
 * that setting means "don't feed the car", and the native clearSession drops the
 * snapshot on the same edge. Also skipped when nothing changed, so a chatty
 * progress store doesn't rewrite prefs every tick.
 */
export function publishOfflineLibrary(): void {
  if (Platform.OS !== 'android') return
  if (getSettingsState().carMode === 'off') {
    lastPublished = null
    return
  }
  const books = buildOfflineLibrary()
  const json = JSON.stringify(books)
  if (json === lastPublished) return
  lastPublished = json
  setAutoOfflineLibrary(books)
}

function schedulePublish(): void {
  if (publishTimer) clearTimeout(publishTimer)
  publishTimer = setTimeout(() => {
    publishTimer = null
    publishOfflineLibrary()
  }, PUBLISH_DEBOUNCE_MS)
}

/**
 * Keep the car's offline snapshot in step with the app for the rest of this
 * launch. Idempotent - a second call is a no-op.
 *
 * Deliberately NOT gated on being connected: the whole point is that the car
 * still works on a launch that never reached the server, and the download +
 * progress stores hydrate from disk regardless.
 */
export function startOfflineLibrarySync(): void {
  if (Platform.OS !== 'android' || watching) return
  watching = true
  publishOfflineLibrary()
  subscribeDownloads(schedulePublish)
  subscribeCatalog(schedulePublish)
  subscribeProgress(schedulePublish)
  // Car mode flipping back on has to re-publish what the native clear dropped.
  subscribeSettings(schedulePublish)
}

/**
 * Fold everything the car did offline back into the app.
 *
 * Progress becomes a pending ABS session, exactly like an offline listen on the
 * phone, so an hour driven with no signal lands in listening stats with its real
 * listened-time instead of just moving a progress bar. Merged with any session
 * already pending for the same book (phone and car bank separately, so their
 * listened-time adds up, and the later position wins).
 *
 * Safe to call repeatedly - only the entries read here are cleared, so a listen
 * still in progress in the car keeps accruing.
 */
export async function drainCarOfflineWork(): Promise<void> {
  if (Platform.OS !== 'android') return
  await drainCarOfflineProgress()
  await drainCarOfflineBookmarks()
}

/** Call once the pending-session store has hydrated - this merges into it. */
export async function drainCarOfflineProgress(): Promise<void> {
  if (Platform.OS !== 'android') return
  const banked = await getAutoOfflineProgress()
  // Keyed per listen ("<itemId>@<startedAt>"), so keep the keys for the clear.
  const entries = Object.entries(banked).filter(([, e]) => e && e.itemId)
  if (!entries.length) return

  for (const [, e] of entries) {
    // Move the local progress bar first: this is the last-known position for a
    // book the user may not have opened on the phone in days.
    recordLocalProgress(e.itemId, e.currentTime, e.duration)

    // Its OWN session, keyed on when the car started banking it. The phone's
    // ledger is separate and neither has counted the other's seconds, so a car
    // listen must never merge into (and overwrite) a phone one - it lands beside
    // it, and both replay to ABS as the real listens they were. Re-draining a
    // listen still in progress updates the same id rather than duplicating it.
    recordLocalSession({
      id: `car-offline-${e.itemId}-${e.startedAt}`,
      libraryItemId: e.itemId,
      mediaType: 'book',
      displayTitle: e.title || '',
      duration: e.duration || 0,
      currentTime: e.currentTime,
      timeListening: Math.max(0, e.timeListening),
      startedAt: e.startedAt,
      updatedAt: e.updatedAt,
    })

    // The user finished the book in the car while offline. markFinished is
    // optimistic with its own rollback and queues the server write, so this is
    // safe to fire here whether or not we're back online yet.
    if (e.finished) void markFinished(e.itemId, true, e.duration).catch(() => {})
  }

  clearAutoOfflineProgress(entries.map(([key]) => key))
  // If we're online now, ship it immediately; otherwise the usual reconnect /
  // background-task paths pick it up.
  void flushPendingProgress()
}

/** Call once the pending-bookmark store has hydrated - its hydrate REPLACES
 *  state, so a bookmark pushed before it lands would be dropped. */
export async function drainCarOfflineBookmarks(): Promise<void> {
  if (Platform.OS !== 'android') return
  const queued = await getAutoOfflineBookmarks()
  if (!queued.length) return
  const taken: string[] = []
  for (const b of queued) {
    if (!b?.itemId) continue
    // Write-ahead inside addBookmarkPending, so this is durable before we clear.
    await addBookmarkPending(b.itemId, b.time, b.title || 'Bookmark')
    taken.push(`${b.itemId}@${Math.round(b.time)}`)
  }
  clearAutoOfflineBookmarks(taken)
}
