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

export interface BookActionsHandle {
  /** Open the sheet targeting `item`, with its current finished state so the
   *  first row reads "Mark finished" vs "Mark unfinished" correctly. */
  present: (item: ABSLibraryItem, isFinished: boolean) => void
}

export const BookActionsSheet = forwardRef<
  BookActionsHandle,
  {
    /** Called after a successful mark-finished so the opener can reconcile its
     *  own lists. `finished` is the new state. */
    onMarkedFinished?: (item: ABSLibraryItem, finished: boolean) => void
    onToast?: (message: string) => void
  }
>(function BookActionsSheet({ onMarkedFinished, onToast }, ref) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const sheetRef = useRef<SheetRef>(null)
  const addSheetRef = useRef<SheetHandle>(null)
  const [target, setTarget] = useState<{ item: ABSLibraryItem; finished: boolean } | null>(null)
  const [busy, setBusy] = useState(false)

  useImperativeHandle(ref, () => ({
    present: (item, isFinished) => {
      setTarget({ item, finished: isFinished })
      sheetRef.current?.present()
    },
  }))

  const item = target?.item
  const finished = target?.finished ?? false
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
