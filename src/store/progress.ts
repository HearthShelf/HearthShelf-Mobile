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
import { getMe, setItemFinished } from '@/api/abs'

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
      next.set(id, { ...server, isFinished: o.isFinished, progress: o.isFinished ? 1 : server.progress })
    } else {
      next.set(id, stub(id, o.isFinished))
    }
  }
  emit(next)
  return me
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
): Promise<void> {
  if (!items.length) return
  const prev = items.map((it) => [it.id, state.byId.get(it.id)] as const)
  const next = new Map(state.byId)
  for (const it of items) {
    const p = next.get(it.id)
    next.set(it.id, p ? { ...p, isFinished: finished, progress: finished ? 1 : p.progress } : stub(it.id, finished, it.duration))
    overrides.set(it.id, { isFinished: finished, atMs: Date.now() })
  }
  emit(next)

  let okCount = 0
  let lastErr: unknown = null
  for (const it of items) {
    try {
      await setItemFinished(it.id, finished)
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

export async function markFinished(itemId: string, finished: boolean, duration?: number): Promise<void> {
  await markItemsFinished([{ id: itemId, duration }], finished)
}
