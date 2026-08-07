/**
 * Confirmation copy for list maintenance, in one place so both kinds and all
 * three destructive actions read consistently.
 *
 * The danger these guard against is a listener reading "remove" as "delete the
 * book". Every message therefore names the LIST, and says plainly that the
 * underlying books stay in the library.
 *
 * The two kinds differ in who is affected, and the copy has to carry that:
 * a collection is library-wide (deleting one takes it away from everyone on the
 * server), a playlist is private to its owner. A collection's confirmation must
 * not describe it as personal.
 */
import { confirm } from '@/ui/confirm'
import type { ListKind } from '@/ui/lists/kind'

export function confirmDeleteList({
  kind,
  name,
  count,
}: {
  kind: ListKind
  name: string
  /** Items the list holds - named so it is clear they are not being deleted. */
  count: number
}): Promise<boolean> {
  const things =
    count === 1
      ? kind === 'collection'
        ? 'book'
        : 'item'
      : kind === 'collection'
        ? 'books'
        : 'items'
  return confirm({
    title: kind === 'collection' ? 'Delete this collection?' : 'Delete this playlist?',
    message:
      kind === 'collection'
        ? `"${name}" holds ${count} ${things}. Deleting it removes the collection for everyone on this server. The ${things} stay in the library.`
        : `"${name}" holds ${count} ${things}. Deleting it only affects your own playlists. The ${things} stay in the library.`,
    confirmLabel: 'Delete',
  })
}

export function confirmRemoveFromList({
  kind,
  listName,
  itemTitle,
}: {
  kind: ListKind
  listName: string
  itemTitle: string
}): Promise<boolean> {
  return confirm({
    title: 'Remove from list?',
    message: `Take "${itemTitle}" out of ${kind === 'collection' ? 'the collection' : 'the playlist'} "${listName}". It stays in your library.`,
    confirmLabel: 'Remove',
  })
}

/**
 * ABS deletes a playlist outright when its last item is removed
 * (PlaylistController.removeItem). Removing the final item is therefore a
 * different, bigger action than removing any other, and has to say so.
 */
export function confirmRemoveLastPlaylistItem({
  listName,
  itemTitle,
}: {
  listName: string
  itemTitle: string
}): Promise<boolean> {
  return confirm({
    title: 'Remove the last item?',
    message: `"${itemTitle}" is the only item left in "${listName}". Removing it deletes the playlist. The item stays in your library.`,
    confirmLabel: 'Remove and delete',
  })
}
