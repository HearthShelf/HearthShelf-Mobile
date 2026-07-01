/**
 * Real ABS bookmarks for a single item, ported from the WebApp's useBookmarks
 * hook. The full list comes from /api/me (bookmarks[]) filtered by
 * libraryItemId; create/delete mutate ABS directly and refetch.
 */
import { useCallback, useEffect, useState } from 'react'
import type { ABSBookmark } from '@hearthshelf/core'
import { createBookmark, deleteBookmark, getBookmarks } from '@/api/abs'
import { haptics } from '@/ui/haptics'

export function useBookmarks(libraryItemId: string | null) {
  const [all, setAll] = useState<ABSBookmark[]>([])

  const refresh = useCallback(() => {
    getBookmarks()
      .then(setAll)
      .catch(() => {})
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const bookmarks = all
    .filter((b) => b.libraryItemId === libraryItemId)
    .sort((a, b) => a.time - b.time)

  const addBookmark = useCallback(
    async (time: number, title: string) => {
      if (!libraryItemId) return
      await createBookmark(libraryItemId, time, title)
      haptics.success()
      refresh()
    },
    [libraryItemId, refresh],
  )

  const removeBookmark = useCallback(
    async (time: number) => {
      if (!libraryItemId) return
      await deleteBookmark(libraryItemId, time)
      refresh()
    },
    [libraryItemId, refresh],
  )

  return { bookmarks, addBookmark, removeBookmark }
}
