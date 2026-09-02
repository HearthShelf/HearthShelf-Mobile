/**
 * Fetches the playing book's notes + locked stubs and clusters them into
 * scrubber timeline markers (core's clusterTimelineMarkers), shared by the
 * player's seek bar. Refreshes coarsely (on item change and every ~30s of
 * playback) so marker density tracks new notes without a per-tick refetch.
 *
 * Passed (unlocked) notes carry author identity (avatar dots); ahead stubs are
 * anonymous ticks - the server withholds their author, so the marker does too.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { HSNote, HSNoteStub, MarkerItem, TimelineMarker } from '@hearthshelf/core'
import { clusterTimelineMarkers } from '@hearthshelf/core'
import { getNotes } from '@/api/notes'

export function useTimelineMarkers(
  itemId: string | null,
  durationSec: number,
  position: number,
  enabled = true,
  /**
   * The span the markers are drawn ACROSS, when that is not the whole book.
   *
   * The player's seek bar can be scoped to the current chapter (the "Progress
   * bar" setting), and then its fill is chapter-relative. Markers clustered
   * against the whole duration were still laid out book-relative, so on a
   * chapter-scoped bar the ticks and the fill used different denominators and
   * visibly disagreed - the fill sat at the chapter fraction while the ticks
   * (and the % label) sat at the book fraction (HS-MOBILEAPP-2N).
   *
   * Notes are still FETCHED for the whole book; this only decides where they
   * land. Markers outside the window are dropped, since there is nowhere on a
   * chapter-scoped bar to honestly put them.
   *
   * Passed as two numbers rather than an object so the memo below can depend on
   * them directly - a fresh `{start, end}` literal each render would change
   * identity every time and defeat it.
   */
  windowStart?: number,
  windowEnd?: number,
): TimelineMarker[] {
  const [notes, setNotes] = useState<HSNote[]>([])
  const [locked, setLocked] = useState<HSNoteStub[]>([])
  const bucket = Math.floor(position / 30)
  const lastFetchKey = useRef('')

  useEffect(() => {
    if (!enabled || !itemId) {
      setNotes([])
      setLocked([])
      return
    }
    const key = `${itemId}:${bucket}`
    if (lastFetchKey.current === key) return
    lastFetchKey.current = key
    let cancelled = false
    getNotes({ libraryItemId: itemId, position })
      .then((res) => {
        if (cancelled) return
        setNotes(res.enabled ? res.notes : [])
        setLocked(res.enabled ? res.locked : [])
      })
      .catch(() => {
        if (cancelled) return
        setNotes([])
        setLocked([])
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId, bucket, enabled])

  return useMemo(() => {
    if (!enabled || durationSec <= 0) return []
    const items: MarkerItem[] = []
    for (const n of notes) {
      // Only timestamped notes place a marker (general notes have no position).
      if (n.timeSec != null) {
        items.push({
          id: n.id,
          timeSec: n.timeSec,
          kind: 'note',
          userId: n.userId,
          username: n.username,
        })
      }
    }
    for (const s of locked) {
      // A locked reply reports its parent's timeSec, so it would stack a second
      // tick on the same spot. The parent's tick already marks the thread.
      if (s.parentId) continue
      items.push({ id: s.id, timeSec: s.timeSec, kind: 'stub' })
    }
    // Whole-book bar: cluster as-is. Chapter-scoped bar: keep only the notes
    // inside the window and re-base them onto it, so a marker's fraction means
    // the same thing as the fill's - both measured across what is drawn.
    if (!windowStart && !windowEnd) return clusterTimelineMarkers(items, durationSec)
    const start = windowStart ?? 0
    const span = Math.max(1, (windowEnd ?? durationSec) - start)
    const inWindow: MarkerItem[] = []
    for (const it of items) {
      if (it.timeSec < start || it.timeSec > start + span) continue
      inWindow.push({ ...it, timeSec: it.timeSec - start })
    }
    return clusterTimelineMarkers(inWindow, span)
  }, [notes, locked, durationSec, enabled, windowStart, windowEnd])
}
