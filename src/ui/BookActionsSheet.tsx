/**
 * Long-press action popover for a single book, reusable across browse surfaces
 * (Home shelves, the Continue hero, etc). A compact bottom sheet with the
 * actions people reach for without opening the detail page: Mark finished /
 * unfinished, Download, and Add to a list.
 *
 * One instance serves many tiles: the parent holds a ref and calls
 * `present(item, isFinished)` from each tile's onLongPress, so the sheet always
 * targets the book that was pressed. Mark-finished reports back through
 * `onMarkedFinished` so the opener can update its own lists (e.g. drop a
 * newly-finished book out of Continue) without a full reload.
 */
import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { StyleSheet, View } from 'react-native'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { coverHue } from '@hearthshelf/core'
import { coverUrl, itemAuthor, itemTitle } from '@/api/abs'
import { promptAndMarkItemsFinished } from '@/store/progress'
import {
  getDownloadsState,
  subscribeDownloads,
  downloadItem,
  cancelDownload,
  deleteDownload,
} from '@/player/downloads'
import { AddToListSheet } from '@/player/AddToListSheet'
import type { SheetHandle } from '@/player/sheets'
import { AppText, Cover, Sheet, type SheetRef, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { confirm } from '@/ui/confirm'
import { dismiss as dismissEntity } from '@/store/dismissals'
import { resetItemProgress } from '@/store/progress'

// Where the long-press originated, so the sheet can offer the right "hide"
// action: a Continue-Series tile hides the whole SERIES; a Continue-Listening
// tile hides just that book and offers Reset progress. 'browse' (default) is a
// plain tile with no dismiss affordance.
export type BookActionsSource = 'series' | 'listening' | 'browse'

export interface BookActionsHandle {
  /** Open the sheet targeting `item`, with its current finished state so the
   *  first row reads "Mark finished" vs "Mark unfinished" correctly. `source`
   *  controls the dismiss / reset-progress rows. For a Continue-Series tile pass
   *  `series` ({id,name}) so "Hide this series" dismisses the right series (the
   *  minified item carries only a series name, not an id). */
  present: (
    item: ABSLibraryItem,
    isFinished: boolean,
    source?: BookActionsSource,
    series?: { id: string; name: string },
  ) => void
}

export const BookActionsSheet = forwardRef<
  BookActionsHandle,
  {
    /** Called after a successful mark-finished so the opener can reconcile its
     *  own lists. `finished` is the new state. */
    onMarkedFinished?: (item: ABSLibraryItem, finished: boolean) => void
    /** Called after a successful dismiss/reset so the opener can drop the tile
     *  and re-pull the queue. `label` is a short confirmation ("Hid ..."). */
    onDismissed?: (label: string) => void
    onToast?: (message: string) => void
  }
>(function BookActionsSheet({ onMarkedFinished, onDismissed, onToast }, ref) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const sheetRef = useRef<SheetRef>(null)
  const addSheetRef = useRef<SheetHandle>(null)
  const [target, setTarget] = useState<{
    item: ABSLibraryItem
    finished: boolean
    source: BookActionsSource
    series?: { id: string; name: string }
  } | null>(null)
  const [busy, setBusy] = useState(false)

  useImperativeHandle(ref, () => ({
    present: (item, isFinished, source = 'browse', series) => {
      setTarget({ item, finished: isFinished, source, series })
      sheetRef.current?.present()
    },
  }))

  const item = target?.item
  const finished = target?.finished ?? false
  const source = target?.source ?? 'browse'
  // The series this tile stands for (Continue-Series), if any - drives the
  // "Hide this series" action. Passed in explicitly by the caller.
  const seriesRef = target?.series
  const { byId } = useSyncExternalStore(subscribeDownloads, getDownloadsState)
  const dl = item ? byId.get(item.id) : undefined

  const markFinished = async () => {
    if (!item || busy) return
    const next = !finished
    setBusy(true)
    // Close right away - the finish-date prompt (or the optimistic flip on the
    // screen behind) takes over; holding the tray open on a wait feels stuck.
    sheetRef.current?.dismiss()
    try {
      // Finishing asks "when did you finish?"; unfinishing is instant.
      const ok = await promptAndMarkItemsFinished(
        [{ id: item.id, duration: item.media.duration ?? 0 }],
        next,
      )
      if (!ok) return // dismissed the prompt
      onMarkedFinished?.(item, next)
      onToast?.(next ? 'Marked finished' : 'Marked not finished')
    } catch {
      onToast?.('Could not update')
    } finally {
      setBusy(false)
    }
  }

  const download = async () => {
    if (!item) return
    if (dl?.status === 'done') {
      const ok = await confirm({
        title: 'Remove download',
        message: `Delete the downloaded copy of "${itemTitle(item)}"? You can download it again later.`,
        confirmLabel: 'Delete',
      })
      if (!ok) return
      void deleteDownload(item.id)
      onToast?.('Download removed')
    } else if (dl?.status === 'downloading' || dl?.status === 'queued') {
      void cancelDownload(item.id)
      onToast?.('Download cancelled')
    } else {
      void downloadItem(item.id, itemTitle(item), itemAuthor(item))
      onToast?.('Downloading for offline')
    }
    sheetRef.current?.dismiss()
  }

  const downloadLabel =
    dl?.status === 'done'
      ? 'Remove download'
      : dl?.status === 'downloading' || dl?.status === 'queued'
        ? `Cancel download (${Math.round((dl.progress ?? 0) * 100)}%)`
        : 'Download for offline'
  const downloadIcon = dl?.status === 'done' ? icons.downloadDone : icons.download

  const addToList = () => {
    // Layer the add-to-list sheet on top of this one, then close this.
    addSheetRef.current?.present()
    sheetRef.current?.dismiss()
  }

  // Hide a series (Continue-Series) or a book (Continue-Listening) from Auto
  // sources. Optimistic via the dismissals store; the opener gets an Undo.
  const dismissTarget = async () => {
    if (!item || busy) return
    sheetRef.current?.dismiss()
    const kind: 'series' | 'item' = source === 'series' ? 'series' : 'item'
    const entityId = source === 'series' ? seriesRef?.id : item.id
    if (!entityId) return
    const label = source === 'series' ? seriesRef?.name || 'series' : itemTitle(item)
    try {
      await dismissEntity(kind, entityId)
      onDismissed?.(`Hid "${label}"`)
    } catch {
      onToast?.('Could not hide that')
    }
  }

  // Reset a Continue-Listening book to the start AND hide it from the shelf
  // (per the product decision: reset to 0 and remove from the list).
  const resetProgress = async () => {
    if (!item || busy) return
    sheetRef.current?.dismiss()
    const ok = await confirm({
      title: 'Reset progress',
      message: `Start "${itemTitle(item)}" over from the beginning and remove it from Continue Listening?`,
      confirmLabel: 'Reset',
    })
    if (!ok) return
    try {
      await resetItemProgress(item.id)
      await dismissEntity('item', item.id)
      onDismissed?.(`Reset "${itemTitle(item)}"`)
    } catch {
      onToast?.('Could not reset progress')
    }
  }

  const canDismiss = source === 'series' ? !!seriesRef : source === 'listening'

  return (
    <>
      <Sheet ref={sheetRef} stackBehavior="push">
        {item ? (
          <View style={styles.header}>
            <Cover
              uri={coverUrl(item.id)}
              itemId={item.id}
              size={52}
              radius={radius.tile}
              fallback={{
                hue: coverHue(item.id),
                initial: itemTitle(item).charAt(0).toUpperCase(),
              }}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText variant="label" numberOfLines={1}>
                {itemTitle(item)}
              </AppText>
              <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                {itemAuthor(item)}
              </AppText>
            </View>
          </View>
        ) : null}

        <ActionRow
          icon={finished ? icons.removeDone : icons.taskAlt}
          label={finished ? 'Mark not finished' : 'Mark finished'}
          disabled={busy}
          onPress={() => void markFinished()}
        />
        <ActionRow icon={icons.addList} label="Add to list" onPress={addToList} />
        <ActionRow icon={downloadIcon} label={downloadLabel} onPress={() => void download()} />
        {source === 'listening' && (
          <ActionRow
            icon={icons.replay}
            label="Reset progress"
            onPress={() => void resetProgress()}
          />
        )}
        {canDismiss && (
          <ActionRow
            icon={icons.hidden}
            label={source === 'series' ? 'Hide this series' : 'Not right now'}
            onPress={() => void dismissTarget()}
          />
        )}
      </Sheet>

      {item ? (
        <AddToListSheet
          ref={addSheetRef}
          libraryId={item.libraryId}
          libraryItemId={item.id}
          onAdded={(message) => onToast?.(message)}
        />
      ) : null}
    </>
  )
})

function ActionRow({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: (typeof icons)[keyof typeof icons]
  label: string
  disabled?: boolean
  onPress: () => void
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <Touchable style={styles.row} onPress={onPress} disabled={disabled}>
      <Icon name={icon} size={21} color={colors.textMuted} />
      <AppText variant="body">{label}</AppText>
    </Touchable>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingBottom: spacing.md,
      marginBottom: spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
    },
  })
