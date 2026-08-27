/**
 * Shared media-progress state. Every screen that shows or mutates finished
 * state reads this one store instead of keeping its own copy, so marking a
 * book finished updates everywhere at once.
 *
 * Mutations are optimistic and protected: a local write records an override
 * that a refresh cannot clobber until the server reflects it (or the override
 * ages out). That kills the mark-all "blink" where a refetch racing the
 * server's writes briefly reverted the UI to stale state.
 *
 * Plain subscribe/snapshot store (same pattern as settings.ts) so it works
 * with useSyncExternalStore and from non-React code.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { ABSMediaProgress, ABSMeResponse } from '@hearthshelf/core'
import { getMe, setItemFinished, resetItemProgress as resetItemProgressApi } from '@/api/abs'
import { breadcrumb } from '@/lib/crashLog'
import { reportProgressDrop } from '@/store/progressResetReport'
import { getSettingsState } from '@/store/settings'
import { isDownloaded, deleteDownload } from '@/player/downloads'
// Leaf imports: player/store holds no reference back to this store, and
// player/completion only reads settings - so neither closes an import cycle.
import { getState as getPlayerState } from '@/player/store'
import { sweepVerdict } from '@/player/completion'
import { finishDatePrompt } from '@/ui/FinishDatePrompt'

export interface ProgressState {
  byId: ReadonlyMap<string, ABSMediaProgress>
}

// Persisted so a book's finished/in-progress state survives a cold start with no
// network. The store used to be in-memory only, populated solely by
// refreshProgress() -> getMe() (a server call); launched offline it stayed empty,
// so every downloaded book showed 0 progress and no finished marks. Now the last
// known progress is written to disk on every change and hydrated at mount, like
// the downloads / pending-session / catalog stores.
const STORE_KEY = 'hs.progress.v1'

let state: ProgressState = { byId: new Map() }
const listeners = new Set<() => void>()

// Recent local writes the server may not reflect yet. A refresh keeps these
// values until the server agrees or the write is old enough to distrust.
interface ProgressOverride {
  isFinished: boolean
  atMs: number
  /** A reset removes the row. A live session or racing /api/me refresh may
   *  still return the old playhead briefly, so absence needs protection too. */
  removeProgress?: boolean
}

const overrides = new Map<string, ProgressOverride>()
const OVERRIDE_TTL_MS = 20_000

/** Progress changes feed several Auto Queue rules. Rebuild only after ABS has
 * accepted the mutation so the server computes from the new progress row. The
 * dynamic import keeps this leaf store out of the player/sync import graph. */
function requestAutoQueueRecompute(): void {
  void import('@/player/queueSync')
    .then(({ requestQueueRecompute }) => requestQueueRecompute())
    .catch(() => {})
}

// The server's own lastUpdate per item, as of the last refresh. Kept apart from
// the row because recordLocalProgress restamps `lastUpdate` on every tick - so
// the row alone can't say when the SERVER last moved. Resume needs both stamps to
// tell "we died before syncing" (local newer) from "another device listened on"
// (server newer). Not persisted: a value is only meaningful next to the row it
// came from, and a fresh launch refreshes before any resume decision matters.
const serverUpdatedAt = new Map<string, number>()

/** How stale (ms) a local position may be and still survive a refresh. Matches
 *  playback's LOCAL_RESUME_MAX_AGE_MS: past this the server is the better
 *  authority, so there is nothing to protect and holding the local value would
 *  only keep a dead row alive. */
const LOCAL_POSITION_MAX_AGE_MS = 12 * 60 * 60 * 1000

/**
 * How much newer the server's stamp must be before it can overrule a local
 * position that is AHEAD of it.
 *
 * `lastUpdate` is stamped when each side writes its row, and those writes race:
 * a sync in flight when we take our local snapshot lands a moment later, so the
 * server row is stamped newer while describing an OLDER playhead. Trusting the
 * stamp then throws away a good position.
 *
 * Measured, not guessed: HS-MOBILEAPP-15 caught it with a server row stamped
 * 670ms newer whose position was 409 SECONDS behind. A position cannot legitimately
 * move 409s backwards in 670ms unless the listener seeked - and a seek writes
 * locally too, so it would not arrive this way.
 *
 * Anything inside this window is treated as concurrent rather than newer, and the
 * position itself decides. Comfortably wider than a request round trip, and far
 * narrower than a real listening gap on another device.
 */
const CONCURRENT_STAMP_MS = 15_000

/**
 * How far the server must be BEHIND for the guard above to apply.
 *
 * Small differences are ordinary rounding between a tick and its sync, where the
 * server's value is fine and preferring the local one would fight normal
 * convergence. Only a gap big enough to be felt as a lost position is worth
 * overriding a newer stamp for.
 */
const CONCURRENT_MIN_DROP_SEC = 60

/** When the server last moved this book's progress, per the most recent refresh.
 *  undefined when the server has never reported a stamp for it. */
export function serverProgressUpdatedAt(itemId: string): number | undefined {
  return serverUpdatedAt.get(itemId)
}

function persist(): void {
  const items = [...state.byId.values()]
  void AsyncStorage.setItem(STORE_KEY, JSON.stringify({ items })).catch(() => {})
}

function emit(next: Map<string, ABSMediaProgress>): void {
  state = { byId: next }
  listeners.forEach((l) => l())
  persist()
}

/**
 * Load persisted progress on app start, before any server contact. Offline this
 * is the ONLY source of finished/in-progress state, so downloaded books show
 * their real progress with no network. Online, refreshProgress() overwrites it
 * from the server shortly after. MERGE-hydrates (like the other stores) so it
 * never clobbers a write that landed between mount and this resolving.
 */
export async function hydrateProgress(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY)
    if (!raw) return
    const parsed = JSON.parse(raw) as { items?: ABSMediaProgress[] }
    const merged = new Map(state.byId)
    for (const p of parsed.items ?? []) {
      if (p && typeof p.libraryItemId === 'string' && !merged.has(p.libraryItemId)) {
        merged.set(p.libraryItemId, p)
      }
    }
    emit(merged)
  } catch {
    // start empty on a bad payload
  }
}

/**
 * Write a single item's live position into the store (and to disk) without a
 * server round-trip. Used by offline playback so a downloaded book's progress
 * bar advances and persists across a cold start while there's no network.
 *
 * A finished book keeps its finished flag but still records position. This used
 * to early-return on isFinished, which threw away every tick of a re-listen -
 * and since offline resume reads this store and skips finished books, a
 * re-listened book restarted from 0 on each cold start (online, the real ABS
 * session's currentTime masked it). Un-finishing here would be the wrong fix:
 * a local tick is not the user saying "I'm not done", it would fight the
 * server's own finished state on the next refresh, and it would let a stray tick
 * undo the removeDownloadOnFinish cleanup. So position advances, finished stays
 * - only an explicit markItemsFinished(false) clears the flag.
 */
export function recordLocalProgress(itemId: string, currentTime: number, duration: number): void {
  if (!itemId) return
  // A reset owns this row until ABS confirms it is gone. Native may emit one
  // last progress tick while its seek-to-zero settles; accepting that tick
  // would immediately recreate the row we just deleted.
  if (overrides.get(itemId)?.removeProgress) return
  const prev = state.byId.get(itemId)
  // Loading an untouched book at its initial position is not listening and must
  // not manufacture a 0% progress row.
  if (!prev && currentTime <= 0) return
  const next = new Map(state.byId)
  const total = duration || prev?.duration || 0
  next.set(itemId, {
    libraryItemId: itemId,
    duration: total,
    currentTime,
    // Stamp the write so resume can order this against the server's own
    // lastUpdate. A process kill can leave this row ahead of the server (the
    // position moved but the sync window hadn't elapsed); a listen on another
    // device leaves the server ahead. Whichever was written last wins - see
    // resumePositionFor's caller in playback.ts.
    lastUpdate: Date.now(),
    // A finished book reads as 100% regardless of where the re-listen sits, so
    // shelves and tiles don't show it sliding backwards from complete.
    progress: prev?.isFinished
      ? 1
      : duration > 0
        ? Math.min(currentTime / duration, 1)
        : (prev?.progress ?? 0),
    isFinished: prev?.isFinished === true,
  })
  emit(next)
}

export function getProgressState(): ProgressState {
  return state
}

export function subscribeProgress(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function progressFor(itemId: string): ABSMediaProgress | undefined {
  return state.byId.get(itemId)
}

export function isFinished(itemId: string): boolean {
  return state.byId.get(itemId)?.isFinished === true
}

function stub(itemId: string, finished: boolean, duration = 0): ABSMediaProgress {
  return {
    libraryItemId: itemId,
    duration,
    progress: finished ? 1 : 0,
    currentTime: 0,
    isFinished: finished,
  }
}

/** Pull the full progress list from the server into the shared state. Returns
 *  the /api/me response so callers can reuse it (e.g. bookmarks) without a
 *  second request. */
export async function refreshProgress(): Promise<ABSMeResponse> {
  const prev = state.byId
  const me = await getMe()
  const next = new Map(me.mediaProgress.map((p) => [p.libraryItemId, p] as const))
  // Snapshot the server's stamps before any local write can restamp these rows.
  for (const p of me.mediaProgress) {
    if (typeof p.lastUpdate === 'number') serverUpdatedAt.set(p.libraryItemId, p.lastUpdate)
  }
  keepFresherLocalPositions(prev, next)
  const now = Date.now()
  for (const [id, o] of [...overrides]) {
    if (now - o.atMs > OVERRIDE_TTL_MS) {
      overrides.delete(id)
      continue
    }
    const server = next.get(id)
    const serverReflectsOverride = o.removeProgress ? !server : server?.isFinished === o.isFinished
    if (serverReflectsOverride) {
      overrides.delete(id)
    } else if (o.removeProgress) {
      // Reset means never-started, represented by no progress row. Do not turn
      // a racing stale server row into a synthetic 0% row.
      next.delete(id)
    } else if (server) {
      next.set(id, {
        ...server,
        isFinished: o.isFinished,
        progress: o.isFinished ? 1 : server.progress,
      })
    } else {
      next.set(id, stub(id, o.isFinished))
    }
  }
  cleanupFinishedDownloads(prev, next)
  emit(next)
  void sweepAbandonedNearEnd(next)
  return me
}

/**
 * Finish books the listener walked away from inside the end buffer.
 *
 * A pause is not a decision, so the close path can't catch everyone: pause 40
 * seconds from the end, come back tomorrow and open a DIFFERENT book, and the
 * first one never passes through a close with its chapters loaded. It would sit
 * at 99% forever - the "never finishes anything" profile this feature exists to
 * fix. This is the catch-up pass, run on the refresh that already reconciles
 * server state.
 *
 * Deliberately conservative, because it acts with nobody watching:
 *  - the row must be past halfway and inside the buffer (see sweepVerdict),
 *  - the currently-loaded book is skipped entirely: it isn't abandoned, it's
 *    open, and the listener may be about to resume it,
 *  - it only ever promotes to finished, never the reverse.
 *
 * Progress rows carry no chapter data, so only the flat time buffer applies -
 * the chapter-aware rules stay with the close path, which has the live marks.
 * Fire-and-forget: the writes are optimistic in markItemsFinished, and anything
 * that fails is simply re-evaluated on the next refresh.
 */
function sweepAbandonedNearEnd(rows: ReadonlyMap<string, ABSMediaProgress>): void {
  const openItemId = getPlayerState().nowPlaying?.itemId
  const due: { id: string; duration: number }[] = []
  for (const [id, p] of rows) {
    if (id === openItemId) continue
    if (overrides.has(id)) continue
    if (sweepVerdict(p)) due.push({ id, duration: p.duration })
  }
  if (due.length === 0) return
  breadcrumb('finish', `sweep auto-finishing ${due.length} abandoned book(s)`)
  void markItemsFinished(due, true, undefined, { recomputeQueue: false }).catch(() => {})
}

/**
 * Carry a still-unsynced local position across a refresh.
 *
 * refreshProgress() replaces the whole map with the server's rows, which is right
 * for finished-state and for books another device moved on. It is WRONG for the
 * one row we may know better than the server: the book playing right now.
 * recordLocalProgress writes that row on every tick, but the server only learns
 * the position when a sync lands (throttled to SYNC_LISTENED_THRESHOLD of real
 * listened-time, and a seek accrues none at all). So between syncs the local row
 * is legitimately ahead, and a wholesale replace threw that away.
 *
 * That is the progress-reset bug (HS-MOBILEAPP-P/Q/R). The Now Playing tab
 * refreshes immediately before resolving a resume position, so the refresh was
 * destroying the very row resolveResumePosition() exists to prefer: by the time
 * resume ran, the local row WAS the server row, `savedAt > serverAt` could never
 * be true, and the kill-before-sync branch was unreachable. The listener came
 * back to the last position the server happened to have - for a screen-off listen
 * with no syncs, the spot they started at.
 *
 * Only the position is carried. isFinished stays the server's (protected
 * separately by `overrides`), and a local row older than LOCAL_POSITION_MAX_AGE_MS
 * is left behind - by then the server is the better authority. Rows the server
 * doesn't return are still dropped, so a server-side progress reset/delete
 * propagates as before.
 *
 * Note `serverUpdatedAt` is snapshotted from the response BEFORE this runs, so
 * resume can still tell a carried-over local write from the server's own value.
 */
function keepFresherLocalPositions(
  prev: ReadonlyMap<string, ABSMediaProgress>,
  next: Map<string, ABSMediaProgress>,
): void {
  const now = Date.now()
  for (const [id, server] of next) {
    const local = prev.get(id)
    if (!local || !(local.currentTime > 0)) continue
    const localAt = typeof local.lastUpdate === 'number' ? local.lastUpdate : 0
    const serverAt = typeof server.lastUpdate === 'number' ? server.lastUpdate : 0
    // A server stamp that is only MARGINALLY newer while its position is
    // materially BEHIND is a race, not a newer observation: our local write and
    // an in-flight sync landed within the same moment, and the sync's response
    // carries the position from before that write. Treat the two as concurrent
    // and let the position decide, which keeps the playhead we already have.
    //
    // Bounded on both sides so this cannot swallow a genuine remote listen: the
    // stamps must be within CONCURRENT_STAMP_MS (a round trip, not a listening
    // gap), and the drop must exceed CONCURRENT_MIN_DROP_SEC (a felt loss, not
    // tick/sync rounding). A real listen on another device moves the stamp far
    // more than a few seconds, so it still wins.
    const concurrentRace =
      localAt > 0 &&
      serverAt - localAt <= CONCURRENT_STAMP_MS &&
      local.currentTime - server.currentTime > CONCURRENT_MIN_DROP_SEC
    if (concurrentRace) {
      breadcrumb(
        'progress',
        `server row ${Math.round(local.currentTime - server.currentTime)}s behind local for ${id.slice(0, 8)} but only ${serverAt - localAt}ms newer - keeping local position (concurrent write)`,
      )
    }
    // Strictly newer only: equal stamps mean this row already came from the
    // server, and there is nothing local to protect.
    if (localAt <= serverAt && !concurrentRace) {
      // Progress-reset trace. This is the branch that DECLINES to protect a
      // local position. If the server row is behind the playhead here, the
      // refresh is about to move the book backwards - the reported
      // "reset on unlock". Only logged when the move is backwards and
      // material (>60s), so a normal refresh stays quiet.
      const drop = local.currentTime - server.currentTime
      if (drop > 60) {
        breadcrumb(
          'progress',
          `server row ${Math.round(drop)}s BEHIND local for ${id.slice(0, 8)} but newer (srv+${serverAt - localAt}ms) - local position dropped`,
        )
      }
      // Self-report a felt loss. Silent otherwise - see progressResetReport.ts.
      // Only when the local row carries a real stamp: localAt === serverAt === 0
      // means neither side is dated (a stub, or a row that never synced), so
      // "the server is newer" is an artifact of the 0 fallback rather than a
      // decision worth an event.
      if (localAt > 0) {
        reportProgressDrop({
          itemId: id,
          localSec: local.currentTime,
          serverSec: server.currentTime,
          localUpdatedAt: localAt,
          serverUpdatedAt: serverAt,
          branch: 'server_newer',
        })
      }
      continue
    }
    if (now - localAt > LOCAL_POSITION_MAX_AGE_MS) {
      breadcrumb(
        'progress',
        `local position for ${id.slice(0, 8)} too old (${Math.round((now - localAt) / 1000)}s) - server row kept`,
      )
      reportProgressDrop({
        itemId: id,
        localSec: local.currentTime,
        serverSec: server.currentTime,
        localUpdatedAt: localAt,
        serverUpdatedAt: serverAt,
        branch: 'local_too_old',
      })
      continue
    }
    const duration = server.duration || local.duration || 0
    next.set(id, {
      ...server,
      currentTime: local.currentTime,
      lastUpdate: localAt,
      // Finished books read as 100% regardless of where a re-listen sits, exactly
      // as recordLocalProgress keeps them.
      progress: server.isFinished
        ? 1
        : duration > 0
          ? Math.min(local.currentTime / duration, 1)
          : server.progress,
    })
  }
}

/** Free the device for books that just became finished server-side (the common
 *  case: listened to the end - ABS marks them finished and we learn about it on
 *  the next refresh). Deletes the local download of any book whose finished flag
 *  flipped false->true since the last snapshot, when the account opts in. Best-
 *  effort and fire-and-forget so it never blocks the refresh. */
function cleanupFinishedDownloads(
  prev: ReadonlyMap<string, ABSMediaProgress>,
  next: ReadonlyMap<string, ABSMediaProgress>,
): void {
  if (!getSettingsState().removeDownloadOnFinish) return
  for (const [id, p] of next) {
    if (p.isFinished === true && prev.get(id)?.isFinished !== true && isDownloaded(id)) {
      void deleteDownload(id)
    }
  }
}

/**
 * Mark items finished/unfinished: optimistic local flip, then serial PATCHes
 * (parallel writes raced ABS's own persistence), then a quiet refresh.
 * Throws (after rolling back) only if every write failed; partial success
 * keeps the successful items and refreshes to true state.
 */
export async function markItemsFinished(
  items: { id: string; duration?: number }[],
  finished: boolean,
  finishedAt?: number,
  options: { recomputeQueue?: boolean } = {},
): Promise<void> {
  if (!items.length) return
  const prev = items.map((it) => [it.id, state.byId.get(it.id)] as const)
  const next = new Map(state.byId)
  for (const it of items) {
    const p = next.get(it.id)
    next.set(
      it.id,
      p
        ? { ...p, isFinished: finished, progress: finished ? 1 : p.progress }
        : stub(it.id, finished, it.duration),
    )
    overrides.set(it.id, { isFinished: finished, atMs: Date.now() })
  }
  emit(next)

  // Free the device: when the account opts in, a book you just finished loses its
  // local download (any download - manual or auto). Best-effort and fire-and-
  // forget so it never blocks the finished flip; a failed delete just leaves the
  // file until a manual sweep. Only on the finish direction, never on un-finish.
  if (finished && getSettingsState().removeDownloadOnFinish) {
    for (const it of items) {
      if (isDownloaded(it.id)) void deleteDownload(it.id)
    }
  }

  let okCount = 0
  let lastErr: unknown = null
  for (const it of items) {
    try {
      await setItemFinished(it.id, finished, finishedAt)
      okCount++
    } catch (e) {
      lastErr = e
      overrides.delete(it.id)
    }
  }
  if (okCount === 0) {
    const rollback = new Map(state.byId)
    for (const [id, p] of prev) {
      if (p) rollback.set(id, p)
      else rollback.delete(id)
      overrides.delete(id)
    }
    emit(rollback)
    throw lastErr instanceof Error ? lastErr : new Error('mark_finished_failed')
  }
  if (options.recomputeQueue !== false) requestAutoQueueRecompute()
  void refreshProgress().catch(() => {})
}

/**
 * Reset a book to never-started by deleting its ABS media-progress row.
 * Optimistic with rollback, same shape as markItemsFinished. Used by the
 * Continue-Listening "Reset progress" action (which also dismisses the book).
 */
export async function resetItemProgress(itemId: string): Promise<void> {
  // If this is the loaded book, close its session at the old position first.
  // Otherwise that still-live session can sync after the reset and resurrect
  // the accidental partial playhead. Keep the track loaded, paused at 0, so a
  // later Play simply opens a fresh session from the reset position.
  const playerStore = await import('@/player/store')
  const loaded = playerStore.getState().nowPlaying?.itemId === itemId
  if (loaded) {
    playerStore.setPlaying(false)
    const { stopPlayback } = await import('@/player/playback')
    await stopPlayback()
  }

  const prev = state.byId.get(itemId)
  const resetAt = Date.now()
  const next = new Map(state.byId)
  next.delete(itemId)
  // Protect absence until ABS reflects the DELETE. A zero-valued stub is still
  // a progress record and makes detail surfaces render the abnormal "0%" state.
  overrides.set(itemId, { isFinished: false, atMs: resetAt, removeProgress: true })
  emit(next)
  try {
    await resetItemProgressApi(itemId)
  } catch (e) {
    const rollback = new Map(state.byId)
    if (prev) rollback.set(itemId, prev)
    else rollback.delete(itemId)
    emit(rollback)
    overrides.delete(itemId)
    throw e instanceof Error ? e : new Error('reset_progress_failed')
  }
  serverUpdatedAt.delete(itemId)
  if (loaded) playerStore.requestSeek(0)
  requestAutoQueueRecompute()
  void refreshProgress().catch(() => {})
}

export async function markFinished(
  itemId: string,
  finished: boolean,
  duration?: number,
  finishedAt?: number,
  options?: { recomputeQueue?: boolean },
): Promise<void> {
  await markItemsFinished([{ id: itemId, duration }], finished, finishedAt, options)
}

/**
 * Mark items finished, first asking "when did you finish this?" so completion
 * can be backdated for accurate stats. Unfinishing is instant (no prompt).
 * Resolves false when the user dismisses the prompt so callers can skip their
 * success toast / selection-clear. Marking through this keeps the optimistic
 * flip + protected-override behavior of markItemsFinished.
 */
export async function promptAndMarkItemsFinished(
  items: { id: string; duration?: number }[],
  finished: boolean,
): Promise<boolean> {
  if (!items.length) return false
  let finishedAt: number | undefined
  if (finished) {
    const choice = await finishDatePrompt({ count: items.length })
    if (!choice) return false
    finishedAt = choice.finishedAt ?? undefined
  }
  await markItemsFinished(items, finished, finishedAt)
  return true
}
