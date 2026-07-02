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
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Linking, StyleSheet, View } from 'react-native'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { coverHue } from '@hearthshelf/core'
import { coverUrl, itemAuthor, itemTitle, libraryDownloadUrl, setItemFinished } from '@/api/abs'
import { AddToListSheet } from '@/player/AddToListSheet'
import type { SheetHandle } from '@/player/sheets'
import { AppText, Cover, Sheet, type SheetRef, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { haptics } from '@/ui/haptics'

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

  const markFinished = async () => {
    if (!item || busy) return
    const next = !finished
    setBusy(true)
    haptics.success()
    try {
      await setItemFinished(item.id, next)
      onMarkedFinished?.(item, next)
      onToast?.(next ? 'Marked finished' : 'Marked not finished')
      sheetRef.current?.dismiss()
    } catch {
      onToast?.('Could not update')
    } finally {
      setBusy(false)
    }
  }

  const download = () => {
    if (!item) return
    const url = libraryDownloadUrl(item.libraryId, [item.id])
    if (url) {
      void Linking.openURL(url)
      onToast?.('Download started in browser')
    }
    sheetRef.current?.dismiss()
  }

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
        <ActionRow icon={icons.download} label="Download" onPress={download} />
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
