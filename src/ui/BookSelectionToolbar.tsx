/**
 * The selection action bar shown while book multi-select is active, shared by
 * the Library Books view and the Series detail page. Icon-only actions (select
 * all, mark finished/unfinished, add to a list, add to the queue, download) so
 * they fit one row without horizontal scrolling.
 *
 * The parent owns the selection (useBookSelection) and the item list; this
 * component runs the actions against the selected ids and reports progress
 * changes back so segment tracks / status update.
 */
import { useRef } from 'react'
import { Linking, StyleSheet, View } from 'react-native'
import type { ABSLibraryItem, ABSMediaProgress } from '@hearthshelf/core'
import { addToQueue } from '@/player/queue'
import { AddToListSheet } from '@/player/AddToListSheet'
import type { SheetHandle } from '@/player/sheets'
import { libraryDownloadUrl, itemAuthor, itemTitle, setItemFinished } from '@/api/abs'
import { AppText, IconButton, icons } from '@/ui/primitives'
import { colors, spacing } from '@/ui/theme'
import { haptics } from './haptics'
import type { BookSelection } from './useBookSelection'

export function BookSelectionToolbar({
  selection,
  books,
  libraryId,
  progressById,
  onProgressChanged,
  onToast,
}: {
  selection: BookSelection
  /** All books in the current surface (for select-all + finished-state). */
  books: ABSLibraryItem[]
  libraryId: string
  progressById: Map<string, ABSMediaProgress>
  /** Called after mark-finished so the parent can refetch progress. */
  onProgressChanged?: () => void
  onToast?: (message: string) => void
}) {
  const addSheetRef = useRef<SheetHandle>(null)
  const busy = useRef(false)

  const ids = [...selection.selected]
  const total = books.length
  const selectionAllFinished = ids.length > 0 && ids.every((id) => progressById.get(id)?.isFinished)

  const markFinished = async () => {
    if (!ids.length || busy.current) return
    busy.current = true
    try {
      await Promise.all(ids.map((id) => setItemFinished(id, !selectionAllFinished)))
      onProgressChanged?.()
      haptics.success()
      onToast?.(selectionAllFinished ? 'Marked not finished' : 'Marked finished')
      selection.clear()
    } catch {
      // best-effort
    } finally {
      busy.current = false
    }
  }

  const addToQueueAll = () => {
    const selectedBooks = books.filter((b) => selection.isSelected(b.id))
    for (const b of selectedBooks) {
      addToQueue({ libraryItemId: b.id, title: itemTitle(b), author: itemAuthor(b) })
    }
    haptics.success()
    onToast?.(`Added ${selectedBooks.length} to queue`)
    selection.clear()
  }

  const download = () => {
    const url = libraryDownloadUrl(libraryId, ids)
    if (url) void Linking.openURL(url)
    selection.clear()
  }

  if (!selection.selecting || ids.length === 0) return null

  const allSelected = ids.length === total

  return (
    <View style={styles.bar}>
      <IconButton name={icons.close} onPress={selection.clear} style={styles.action} />
      <AppText variant="label" color={colors.accent} numberOfLines={1}>
        {ids.length}
      </AppText>

      <View style={styles.actions}>
        <IconButton
          name={allSelected ? icons.checklist : icons.selectAll}
          size={20}
          color={colors.text}
          onPress={() =>
            allSelected ? selection.clear() : selection.selectAll(books.map((b) => b.id))
          }
          style={styles.action}
        />
        <IconButton
          name={selectionAllFinished ? icons.removeDone : icons.taskAlt}
          size={20}
          color={colors.text}
          onPress={() => void markFinished()}
          style={styles.action}
        />
        <IconButton
          name={icons.addList}
          size={20}
          color={colors.text}
          onPress={() => addSheetRef.current?.present()}
          style={styles.action}
        />
        <IconButton
          name={icons.queue}
          size={20}
          color={colors.text}
          onPress={addToQueueAll}
          style={styles.action}
        />
        <IconButton
          name={icons.download}
          size={20}
          color={colors.text}
          onPress={download}
          style={styles.action}
        />
      </View>

      <AddToListSheet
        ref={addSheetRef}
        libraryId={libraryId}
        libraryItemIds={ids}
        onAdded={(message) => {
          onToast?.(message)
          selection.clear()
        }}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  // The action cluster spreads to the right of the close/count so the icons sit
  // evenly across the row without horizontal scrolling.
  actions: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
  },
  action: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
