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
import type { ABSMediaProgress, ABSMeResponse } from '@hearthshelf/core'
import { getMe, setItemFinished, resetItemProgress as resetItemProgressApi } from '@/api/abs'
import { getSettingsState } from '@/store/settings'
import { isDownloaded, deleteDownload } from '@/player/downloads'
import { finishDatePrompt } from '@/ui/FinishDatePrompt'

export interface ProgressState {
  byId: ReadonlyMap<string, ABSMediaProgress>
}

let state: ProgressState = { byId: new Map() }
const listeners = new Set<() => void>()

// Recent local writes the server may not reflect yet. A refresh keeps these
// values until the server agrees or the write is old enough to distrust.
const overrides = new Map<string, { isFinished: boolean; atMs: number }>()
const OVERRIDE_TTL_MS = 20_000

function emit(next: Map<string, ABSMediaProgress>): void {
  state = { byId: next }
  listeners.forEach((l) => l())
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
  const now = Date.now()
  for (const [id, o] of [...overrides]) {
    if (now - o.atMs > OVERRIDE_TTL_MS) {
      overrides.delete(id)
      continue
    }
    const server = next.get(id)
    if (server?.isFinished === o.isFinished) {
      overrides.delete(id)
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
  return me
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
  void refreshProgress().catch(() => {})
}

/**
 * Reset a book's progress to the start: currentTime/progress 0, not finished.
 * Optimistic with rollback, same shape as markItemsFinished. Used by the
 * Continue-Listening "Reset progress" action (which also dismisses the book).
 */
export async function resetItemProgress(itemId: string): Promise<void> {
  const prev = state.byId.get(itemId)
  const next = new Map(state.byId)
  if (prev) next.set(itemId, { ...prev, progress: 0, currentTime: 0, isFinished: false })
  // Record an override so a racing refresh doesn't restore the old position.
  overrides.set(itemId, { isFinished: false, atMs: Date.now() })
  emit(next)
  try {
    await resetItemProgressApi(itemId)
  } catch (e) {
    if (prev) {
      const rollback = new Map(state.byId)
      rollback.set(itemId, prev)
      emit(rollback)
    }
    overrides.delete(itemId)
    throw e instanceof Error ? e : new Error('reset_progress_failed')
  }
  void refreshProgress().catch(() => {})
}

export async function markFinished(
  itemId: string,
  finished: boolean,
  duration?: number,
  finishedAt?: number,
): Promise<void> {
  await markItemsFinished([{ id: itemId, duration }], finished, finishedAt)
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
