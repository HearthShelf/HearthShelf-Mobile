/**
 * Long-press action popover for a single book, reusable across every browse
 * surface (Home shelves, the Continue hero, Library, See-all, Search, Author).
 * This is the app's most-used action sheet, so it speaks the SAME language as
 * the player's More tray (app/player.tsx MoreSheet): a 3-across grid of one-tap
 * launch tiles on top, then a divider, then pinned rows for the stateful /
 * destructive / drill-in actions.
 *
 * One instance serves many tiles: the parent holds a ref and calls
 * `present(item, isFinished, source?, series?)` from each tile's onLongPress, so
 * the sheet always targets the book that was pressed. Mark-finished reports back
 * through `onMarkedFinished` so the opener can update its own lists (e.g. drop a
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
import { useRouter } from 'expo-router'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { coverHue } from '@hearthshelf/core'
import { coverUrl, itemAuthor, itemTitle } from '@/api/abs'
import { markItemsFinished } from '@/store/progress'
import { playItemById } from '@/player/playback'
import { addToQueue, getQueueState, setManual, type QueueEntry } from '@/player/queue'
import {
  getDownloadsState,
  subscribeDownloads,
  downloadItem,
  downloadsAllowed,
  cancelDownload,
  deleteDownload,
} from '@/player/downloads'
import { AddToListSheet } from '@/player/AddToListSheet'
import type { SheetHandle } from '@/player/sheets'
import { AppText, Cover, Sheet, type SheetRef, Touchable } from '@/ui/primitives'
import { SpringPressable } from '@/ui/motion'
import { Icon, icons } from '@/ui/icons'
import { showToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { confirm } from '@/ui/confirm'
import { dismiss as dismissEntity, restore as restoreEntity } from '@/store/dismissals'
import { resetItemProgress } from '@/store/progress'

// Where the long-press originated, so the sheet can offer the right "hide"
// action: a Continue-Series tile hides the whole SERIES; a Continue-Listening
// tile hides just that book and offers Reset progress. 'browse' (default) is a
// plain tile with no dismiss affordance.
export type BookActionsSource = 'series' | 'listening' | 'browse'

export interface BookActionsHandle {
  /** Open the sheet targeting `item`, with its current finished state so the
   *  Finish tile reads correctly. `source` controls the dismiss / reset-progress
   *  rows. For a Continue-Series tile pass `series` ({id,name}) so "Hide this
   *  series" and "View series" target the right series (the minified item carries
   *  only a flat series name, not an id). */
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
  const router = useRouter()
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
  const seriesRef = target?.series
  const { byId } = useSyncExternalStore(subscribeDownloads, getDownloadsState)
  const dl = item ? byId.get(item.id) : undefined

  // A short toast helper that routes through the global host (so actions like
  // Undo are tappable) but also notifies the opener when it wants to react.
  const toast = (msg: string) => {
    showToast(msg)
    onToast?.(msg)
  }

  const close = () => sheetRef.current?.dismiss()

  const play = async () => {
    if (!item) return
    close()
    haptics.transport()
    await playItemById(item.id)
    router.push('/player')
  }

  const entryFor = (it: ABSLibraryItem): QueueEntry => ({
    libraryItemId: it.id,
    title: itemTitle(it),
    author: itemAuthor(it),
  })

  const playNext = () => {
    if (!item) return
    close()
    // Play next = jump to the front of the manual queue (deduped).
    const q = getQueueState()
    const rest = q.manual.filter((i) => i.libraryItemId !== item.id)
    setManual([entryFor(item), ...rest])
    haptics.select()
    toast('Playing next')
  }

  const queueLast = () => {
    if (!item) return
    close()
    addToQueue(entryFor(item))
    haptics.select()
    toast('Added to queue')
  }

  const markFinished = async () => {
    if (!item || busy) return
    const next = !finished
    setBusy(true)
    close()
    try {
      // D-FINISH: one tap. Mark now; the date is editable from the toast, not a
      // blocking prompt. Undo reverts.
      await markItemsFinished([{ id: item.id, duration: item.media.duration ?? 0 }], next)
      onMarkedFinished?.(item, next)
      if (next) {
        haptics.success()
        showToast('Finished', {
          action: {
            label: 'Undo',
            onPress: () => void markItemsFinished([{ id: item.id }], false),
          },
        })
      } else {
        showToast('Marked not finished')
      }
    } catch {
      toast('Could not update')
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
      toast('Download removed')
    } else if (dl?.status === 'downloading' || dl?.status === 'queued') {
      void cancelDownload(item.id)
      toast('Download cancelled')
    } else if (!downloadsAllowed()) {
      toast('Downloads are off - allow storage in Downloads & Storage settings')
    } else {
      void downloadItem(item.id, itemTitle(item), itemAuthor(item))
      toast('Downloading for offline')
    }
    close()
  }

  const addToList = () => {
    // Layer the add-to-list sheet on top of this one, then close this.
    addSheetRef.current?.present()
    close()
  }

  const shareBook = () => {
    if (!item) return
    close()
    void import('react-native').then(({ Share }) =>
      Share.share({ message: `${itemTitle(item)} by ${itemAuthor(item) || 'Unknown author'}` }),
    )
  }

  const viewSeries = () => {
    if (!item || !seriesRef) return
    close()
    router.push(
      `/series/${encodeURIComponent(seriesRef.id)}?libraryId=${encodeURIComponent(item.libraryId)}`,
    )
  }

  // Hide a series (Continue-Series) or a book (Continue-Listening) from Auto
  // sources. Optimistic via the dismissals store; reversible from the Undo toast.
  const dismissTarget = async () => {
    if (!item || busy) return
    close()
    const kind: 'series' | 'item' = source === 'series' ? 'series' : 'item'
    const entityId = source === 'series' ? seriesRef?.id : item.id
    if (!entityId) return
    const label = source === 'series' ? seriesRef?.name || 'series' : itemTitle(item)
    try {
      await dismissEntity(kind, entityId, label)
      onDismissed?.(`Hid "${label}"`)
      showToast(`Hid "${label}"`, {
        action: { label: 'Undo', onPress: () => void restoreEntity(kind, entityId) },
      })
    } catch {
      toast('Could not hide that')
    }
  }

  // Reset a book to the start. From a Continue-Listening tile it also hides the
  // book from the shelf (the product decision); elsewhere it just resets.
  const resetProgress = async () => {
    if (!item || busy) return
    close()
    const hideAfter = source === 'listening'
    const ok = await confirm({
      title: 'Reset progress',
      message: hideAfter
        ? `Start "${itemTitle(item)}" over from the beginning and remove it from Continue Listening?`
        : `Start "${itemTitle(item)}" over from the beginning?`,
      confirmLabel: 'Reset',
    })
    if (!ok) return
    try {
      await resetItemProgress(item.id)
      if (hideAfter) await dismissEntity('item', item.id, itemTitle(item))
      onDismissed?.(`Reset "${itemTitle(item)}"`)
      toast('Progress reset')
    } catch {
      toast('Could not reset progress')
    }
  }

  const canDismiss = source === 'series' ? !!seriesRef : source === 'listening'
  const canReset = source === 'listening'
  const canViewSeries = !!seriesRef

  // The Download tile encodes its tri-state in icon + label + color.
  const dlIcon =
    dl?.status === 'done'
      ? icons.downloadDone
      : dl?.status === 'downloading' || dl?.status === 'queued'
        ? icons.close
        : icons.download
  // Tiles are verbs, not status badges - every other tile in the grid names the
  // action it performs, so this one does too. The tri-state still reads from the
  // icon + accent wash; the confirm dialog is the guard on the destructive case.
  const dlLabel =
    dl?.status === 'done'
      ? 'Remove'
      : dl?.status === 'downloading' || dl?.status === 'queued'
        ? `${Math.round((dl.progress ?? 0) * 100)}%`
        : 'Download'

  return (
    <>
      <Sheet
        ref={sheetRef}
        stackBehavior="push"
        // Drop the target on close. One instance serves every tile, so a
        // retained target means the next open paints the PREVIOUS book's cover
        // and title for a frame before the new one commits.
        onDismiss={() => setTarget(null)}
      >
        {item ? (
          <Touchable
            style={styles.header}
            onPress={() => {
              close()
              router.push(`/item/${item.id}`)
            }}
          >
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
            <Icon name={icons.chevronRight} size={20} color={colors.textMuted} />
          </Touchable>
        ) : null}

        {/* 3-across launch grid: the peer one-tap actions, Play accent-filled. */}
        <View style={styles.grid}>
          <View style={styles.gridRow}>
            <GridTile icon={icons.play} label="Play" accent onPress={() => void play()} />
            <GridTile icon={icons.skipNext} label="Play next" onPress={playNext} />
            <GridTile icon={icons.queue} label="Add to queue" onPress={queueLast} />
          </View>
          <View style={styles.gridRow}>
            <GridTile icon={icons.addList} label="Add to list" onPress={addToList} />
            <GridTile
              icon={dlIcon}
              label={dlLabel}
              active={dl?.status === 'done'}
              onPress={() => void download()}
            />
            <GridTile
              icon={finished ? icons.removeDone : icons.taskAlt}
              label={finished ? 'Unfinish' : 'Finish'}
              active={finished}
              onPress={() => void markFinished()}
            />
          </View>
        </View>

        {/* Pinned rows: stateful / destructive / drill-in - deliberately below
            the fold, out of one-tap-by-accident range. */}
        <View style={styles.divider} />
        {canViewSeries && (
          <ActionRow icon={icons.book} label="View series" onPress={viewSeries} chevron />
        )}
        <ActionRow icon={icons.share} label="Share" onPress={shareBook} />
        {canReset && (
          <ActionRow
            icon={icons.replay}
            label="Reset progress"
            destructive
            onPress={() => void resetProgress()}
          />
        )}
        {canDismiss && (
          <ActionRow
            icon={icons.hidden}
            label={source === 'series' ? 'Not right now (hide series)' : 'Not right now'}
            destructive
            onPress={() => void dismissTarget()}
          />
        )}
      </Sheet>

      {item ? (
        <AddToListSheet
          ref={addSheetRef}
          libraryId={item.libraryId}
          libraryItemId={item.id}
          onAdded={(message) => toast(message)}
        />
      ) : null}
    </>
  )
})

function GridTile({
  icon,
  label,
  accent,
  active,
  onPress,
}: {
  icon: (typeof icons)[keyof typeof icons]
  label: string
  /** The most-tapped action (Play) - filled with the accent. */
  accent?: boolean
  /** Live-state (finished / downloaded) - accent wash + accent glyph. */
  active?: boolean
  onPress: () => void
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const iconColor = accent ? colors.onAccent : active ? colors.accent : colors.text
  return (
    <SpringPressable
      style={[styles.tile, accent && styles.tileAccent, active && styles.tileActive]}
      scaleTo={0.94}
      onPress={onPress}
    >
      <Icon name={icon} size={24} color={iconColor} />
      <AppText
        variant="caption"
        numberOfLines={2}
        style={styles.tileLabel}
        color={accent ? colors.onAccent : active ? colors.accent : colors.textMuted}
      >
        {label}
      </AppText>
    </SpringPressable>
  )
}

function ActionRow({
  icon,
  label,
  destructive,
  chevron,
  disabled,
  onPress,
}: {
  icon: (typeof icons)[keyof typeof icons]
  label: string
  destructive?: boolean
  chevron?: boolean
  disabled?: boolean
  onPress: () => void
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const tint = destructive ? colors.destructive : undefined
  return (
    <Touchable style={styles.row} onPress={onPress} disabled={disabled}>
      <Icon name={icon} size={21} color={tint ?? colors.textMuted} />
      <AppText variant="body" color={tint} style={{ flex: 1 }}>
        {label}
      </AppText>
      {chevron ? <Icon name={icons.chevronRight} size={20} color={colors.textMuted} /> : null}
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
      marginBottom: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    gridRow: {
      flexDirection: 'row',
      gap: spacing.sm,
    },
    grid: {
      gap: spacing.sm,
    },
    tile: {
      // Flex-thirds rather than a % width: a percentage + aspectRatio can't
      // resolve during the bottom sheet's dynamic-sizing measure pass, which
      // made the sheet reserve a chunk of dead space below the grid. A fixed
      // height measures on the first pass and keeps all six tiles identical.
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 0,
      height: 78,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.xs,
      borderRadius: radius.card,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    tileLabel: { textAlign: 'center' },
    tileAccent: { backgroundColor: colors.accent, borderColor: colors.accent },
    tileActive: { backgroundColor: colors.accentWash, borderColor: colors.accent },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.hairline,
      marginTop: spacing.lg,
      marginBottom: spacing.xs,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
    },
  })
