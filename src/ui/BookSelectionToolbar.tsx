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
import { useMemo, useRef, useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { addToQueue } from '@/player/queue'
import { downloadItem, downloadsAllowed } from '@/player/downloads'
import { AddToListSheet } from '@/player/AddToListSheet'
import type { SheetHandle } from '@/player/sheets'
import { itemAuthor, itemTitle } from '@/api/abs'
import { getProgressState, subscribeProgress, promptAndMarkItemsFinished } from '@/store/progress'
import { AppText, IconButton, Sheet, type SheetRef, Touchable, icons } from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { haptics } from './haptics'
import { confirm } from './confirm'
import type { BookSelection } from './useBookSelection'

export function BookSelectionToolbar({
  selection,
  books,
  libraryId,
  onToast,
}: {
  selection: BookSelection
  /** All books in the current surface (for select-all + finished-state). */
  books: ABSLibraryItem[]
  libraryId: string
  onToast?: (message: string) => void
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const addSheetRef = useRef<SheetHandle>(null)
  const overflowRef = useRef<SheetRef>(null)
  const busy = useRef(false)
  const { byId } = useSyncExternalStore(subscribeProgress, getProgressState)

  const ids = [...selection.selected]
  const total = books.length
  const selectionAllFinished = ids.length > 0 && ids.every((id) => byId.get(id)?.isFinished)

  const markFinished = async () => {
    if (!ids.length || busy.current) return
    const next = !selectionAllFinished
    // Unfinishing a batch still confirms (it clears progress); finishing goes
    // straight to the date prompt, which itself is the intentional gate.
    if (!next) {
      const ok = await confirm({
        title: 'Mark not finished',
        message: `Mark ${ids.length} book${ids.length === 1 ? '' : 's'} as not finished?`,
        confirmLabel: 'Mark not finished',
        destructive: false,
      })
      if (!ok) return
    }
    busy.current = true
    const idSet = new Set(ids)
    try {
      const done = await promptAndMarkItemsFinished(
        books
          .filter((b) => idSet.has(b.id))
          .map((b) => ({ id: b.id, duration: b.media.duration ?? 0 })),
        next,
      )
      if (!done) return // dismissed the prompt
      haptics.success()
      onToast?.(next ? 'Marked finished' : 'Marked not finished')
      selection.clear()
    } catch {
      onToast?.('Could not update')
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

  const download = async () => {
    const selectedBooks = books.filter((b) => selection.isSelected(b.id))
    if (!selectedBooks.length) return
    if (!downloadsAllowed()) {
      onToast?.('Downloads are off - allow storage in Downloads & Storage settings')
      return
    }
    const ok = await confirm({
      title: 'Download for offline',
      message: `Download ${selectedBooks.length} book${selectedBooks.length === 1 ? '' : 's'} for offline listening? This can use a lot of storage and data.`,
      confirmLabel: 'Download',
      destructive: false,
    })
    if (!ok) return
    for (const b of selectedBooks) {
      void downloadItem(b.id, itemTitle(b), itemAuthor(b))
    }
    haptics.success()
    onToast?.(`Queued ${selectedBooks.length} for download`)
    selection.clear()
  }

  // Shown whenever selection mode is active - even with nothing selected yet
  // (entered via the Library "Select" button), so there's always a visible way
  // to select-all or exit.
  if (!selection.selecting) return null

  const allSelected = ids.length > 0 && ids.length === total
  const hasSelection = ids.length > 0

  return (
    <View style={styles.bar}>
      <IconButton name={icons.close} onPress={selection.clear} style={styles.action} />
      <AppText variant="label" numberOfLines={1} style={styles.count}>
        {hasSelection ? `${ids.length} selected` : 'Select books'}
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
          color={hasSelection ? colors.text : colors.textFaint}
          onPress={() => void markFinished()}
          style={styles.action}
        />
        <IconButton
          name={icons.addList}
          size={20}
          color={hasSelection ? colors.text : colors.textFaint}
          onPress={() => hasSelection && addSheetRef.current?.present()}
          style={styles.action}
        />
        <IconButton
          name={icons.queue}
          size={20}
          color={hasSelection ? colors.text : colors.textFaint}
          onPress={() => hasSelection && addToQueueAll()}
          style={styles.action}
        />
        {/* Rarer op (download) behind an overflow so the row isn't icon soup. */}
        <IconButton
          name={icons.more}
          size={20}
          color={hasSelection ? colors.text : colors.textFaint}
          onPress={() => hasSelection && overflowRef.current?.present()}
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

      <Sheet ref={overflowRef} title={`${ids.length} selected`}>
        <Touchable
          style={styles.overflowRow}
          onPress={() => {
            overflowRef.current?.dismiss()
            void download()
          }}
        >
          <Icon name={icons.download} size={22} color={colors.text} />
          <AppText variant="body">Download for offline</AppText>
        </Touchable>
      </Sheet>
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
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
    count: { minWidth: 78 },
    overflowRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      paddingBottom: spacing.xl,
      borderRadius: radius.row,
    },
  })
