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
        items.push({ id: n.id, timeSec: n.timeSec, kind: 'note', userId: n.userId, username: n.username })
      }
    }
    for (const s of locked) {
      items.push({ id: s.id, timeSec: s.timeSec, kind: 'stub' })
    }
    return clusterTimelineMarkers(items, durationSec)
  }, [notes, locked, durationSec, enabled])
}
