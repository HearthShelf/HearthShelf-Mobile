/**
 * Real ABS bookmarks for a single item, ported from the WebApp's useBookmarks
 * hook. The full list comes from /api/me (bookmarks[]) filtered by
 * libraryItemId.
 *
 * Writes go through the pending-bookmark store rather than straight to ABS: it
 * records each create/delete locally BEFORE the network call and clears it on
 * confirmation, so a bookmark made offline (or one interrupted by the app being
 * killed mid-push) survives instead of vanishing on the next refresh. The list
 * we return is the server payload merged with that pending state, so an offline
 * bookmark shows up immediately.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { ABSBookmark } from '@hearthshelf/core'
import { getBookmarks } from '@/api/abs'
import { haptics } from '@/ui/haptics'
import {
  addBookmarkPending,
  removeBookmarkPending,
  moveBookmarkPending,
  mergeBookmarks,
  getPendingBookmarkState,
  subscribePendingBookmarks,
} from './pendingBookmarks'

export function useBookmarks(libraryItemId: string | null) {
  const [all, setAll] = useState<ABSBookmark[]>([])
  // Re-render when a pending write lands, so an offline bookmark appears (and a
  // confirmed one stops being drawn from the pending list) without a refetch.
  useSyncExternalStore(subscribePendingBookmarks, getPendingBookmarkState)

  const refresh = useCallback(() => {
    getBookmarks()
      .then(setAll)
      .catch(() => {
        // Offline: keep whatever we have; pending writes still merge in below.
      })
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const bookmarks = libraryItemId ? mergeBookmarks(all, libraryItemId) : []

  const addBookmark = useCallback(
    async (time: number, title: string) => {
      if (!libraryItemId) return
      // Never throws - a failed write is banked for the next reconnect.
      const confirmed = await addBookmarkPending(libraryItemId, time, title)
      haptics.success()
      if (confirmed) refresh()
    },
    [libraryItemId, refresh],
  )

  const removeBookmark = useCallback(
    async (time: number) => {
      if (!libraryItemId) return
      const confirmed = await removeBookmarkPending(libraryItemId, time)
      if (confirmed) refresh()
    },
    [libraryItemId, refresh],
  )

  /** Move a bookmark to a new spot and/or retitle it. Atomic: see
   *  moveBookmarkPending - a move is a delete + create, and splitting it would
   *  open a window where a kill loses the bookmark entirely. */
  const moveBookmark = useCallback(
    async (fromTime: number, toTime: number, title: string) => {
      if (!libraryItemId) return
      const confirmed = await moveBookmarkPending(libraryItemId, fromTime, toTime, title)
      haptics.success()
      if (confirmed) refresh()
    },
    [libraryItemId, refresh],
  )

  return { bookmarks, addBookmark, removeBookmark, moveBookmark }
}
