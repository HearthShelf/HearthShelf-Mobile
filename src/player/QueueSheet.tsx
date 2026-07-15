/**
 * Up-next queue sheet: Off/Manual/Auto/Playlist mode, the now-playing row, and
 * a drag-to-reorder up-next list (Manual mode) via react-native-draggable-
 * flatlist. Ported from the WebApp's MobilePlayer queue sheet + queueStore.ts.
 * Auto mode opens a second sub-sheet of toggleable rules.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { BottomSheetFlatList, BottomSheetTextInput } from '@gorhom/bottom-sheet'
import DraggableFlatList, { type RenderItemParams } from 'react-native-draggable-flatlist'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { coverHue } from '@hearthshelf/core'
import type { QueueEntry, ABSLibraryItem, AutoRulePref } from '@hearthshelf/core'
import {
  getQueueState,
  reorderQueue,
  removeFromQueue,
  setManual,
  addToQueue,
  subscribeQueue,
  QUEUE_MODES,
  QUEUE_MODE_SUB,
  AUTO_RULE_COPY,
} from './queue'
import {
  getSettingsState,
  setQueueMode,
  setSetting,
  subscribeSettings,
  toggleAutoRule,
} from '@/store/settings'
import { getState, subscribe } from './store'
import { coverUrl, getLibraries, searchLibraryAll, itemTitle, itemAuthor } from '@/api/abs'
import { AppText, Cover, IconButton, Sheet, type SheetRef, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { haptics } from '@/ui/haptics'
import { showToast } from '@/ui/Toast'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import type { SheetHandle } from './sheets'

const MODES = QUEUE_MODES
const MODE_SUB = QUEUE_MODE_SUB
const RULE_COPY = AUTO_RULE_COPY

export const QueueSheet = forwardRef<SheetHandle, { onJump: (itemId: string) => void }>(
  function QueueSheet({ onJump }, ref) {
    const colors = useColors()
    const styles = useMemo(() => makeStyles(colors), [colors])
    const sheetRef = useRef<SheetRef>(null)
    const rulesRef = useRef<SheetRef>(null)
    const addBooksRef = useRef<SheetRef>(null)
    useImperativeHandle(ref, () => ({
      present: () => sheetRef.current?.present(),
      dismiss: () => sheetRef.current?.dismiss(),
    }))

    const queue = useSyncExternalStore(subscribeQueue, getQueueState)
    const settings = useSyncExternalStore(subscribeSettings, getSettingsState)
    const { nowPlaying } = useSyncExternalStore(subscribe, getState)
    const [dragActive, setDragActive] = useState(false)

    // Which merged-list rows are hand-added: those whose id is in the durable
    // manual list. Only these get the inline X / drag handle in Auto mode; the
    // rest are rule-generated (bolt marker, not editable).
    const manualIds = useMemo(
      () => new Set(queue.manual.map((m) => m.libraryItemId)),
      [queue.manual],
    )

    // A drag inside the merged Auto list reorders the MANUAL rows among
    // themselves. Take the post-drag merged order, pull out just the manual
    // rows in their new relative order, and persist that as the manual list.
    // Auto rows re-derive from the server on the next pull, so their apparent
    // positions self-correct; only the manual order is durable.
    const reorderManualWithin = (merged: QueueEntry[]) => {
      const nextManual = merged.filter((e) => manualIds.has(e.libraryItemId))
      setManual(nextManual)
    }

    return (
      <>
        <Sheet ref={sheetRef} title="Up next" kicker="On the hearth" snapPoints={['80%']}>
          <View style={styles.segFull}>
            {MODES.map((m) => (
              <Touchable
                key={m.v}
                style={[styles.seg, settings.queueMode === m.v && styles.segOn]}
                onPress={() => setQueueMode(m.v)}
              >
                <AppText
                  variant="label"
                  color={settings.queueMode === m.v ? colors.accent : colors.textMuted}
                >
                  {m.label}
                </AppText>
              </Touchable>
            ))}
          </View>

          <View style={styles.subRow}>
            <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
              {MODE_SUB[settings.queueMode]}
            </AppText>
            {(settings.queueMode === 'manual' || settings.queueMode === 'auto') && (
              <Touchable style={styles.rulesBtn} onPress={() => addBooksRef.current?.present()}>
                <Icon name={icons.add} size={15} color={colors.text} />
                <AppText variant="caption">Add books</AppText>
              </Touchable>
            )}
            {settings.queueMode === 'auto' && (
              <Touchable style={styles.rulesBtn} onPress={() => rulesRef.current?.present()}>
                <Icon name={icons.tune} size={15} color={colors.text} />
                <AppText variant="caption">Auto rules</AppText>
              </Touchable>
            )}
          </View>

          {nowPlaying && (
            <View style={[styles.row, styles.rowNow]}>
              <Icon name={icons.nowPlaying} size={18} color={colors.accent} />
              <Cover
                uri={nowPlaying.artworkUrl}
                itemId={nowPlaying.itemId}
                size={46}
                radius={radius.tile}
                fallback={{
                  hue: coverHue(nowPlaying.itemId),
                  initial: nowPlaying.title.charAt(0).toUpperCase(),
                }}
              />
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="label" numberOfLines={1}>
                  {nowPlaying.title}
                </AppText>
                <AppText variant="caption" color={colors.accent} numberOfLines={1}>
                  Now playing
                </AppText>
              </View>
            </View>
          )}

          {settings.queueMode === 'off' ? (
            <View style={styles.empty}>
              <Icon name={icons.nothingQueued} size={36} color={colors.textFaint} />
              <AppText variant="label" style={{ marginTop: spacing.sm }}>
                Nothing queued
              </AppText>
              <AppText
                variant="caption"
                color={colors.textMuted}
                style={{ textAlign: 'center', marginTop: spacing.xs }}
              >
                Playback stops when this book ends. Switch to Manual or Auto to keep going.
              </AppText>
            </View>
          ) : settings.queueMode === 'auto' ? (
            // Auto: ONE merged list (server-computed). Rule-generated rows carry
            // a lightning-bolt marker and aren't editable; hand-added rows sit
            // wherever the 'manual' rule splices them in and keep their inline X
            // + drag handle, so you manage them right where they are. Dragging a
            // hand-added row reorders the manual books among themselves.
            queue.items.length === 0 ? (
              <AppText
                variant="meta"
                color={colors.textMuted}
                style={{ textAlign: 'center', marginTop: spacing.xl }}
              >
                Nothing queued yet. Books you add by hand show up here too.
              </AppText>
            ) : (
              <GestureHandlerRootView style={{ flex: 1 }}>
                <DraggableFlatList
                  data={queue.items}
                  keyExtractor={(item) => item.libraryItemId}
                  onDragBegin={() => setDragActive(true)}
                  onDragEnd={({ data, from, to }) => {
                    setDragActive(false)
                    if (from !== to) reorderManualWithin(data)
                  }}
                  renderItem={(params: RenderItemParams<QueueEntry>) => {
                    const isManual = manualIds.has(params.item.libraryItemId)
                    return (
                      <QueueRow
                        {...params}
                        canDrag={isManual}
                        canRemove={isManual}
                        showBolt={!isManual}
                        dragActive={dragActive}
                        onJump={() => {
                          sheetRef.current?.dismiss()
                          onJump(params.item.libraryItemId)
                        }}
                        onRemove={() => removeFromQueue(params.item.libraryItemId)}
                      />
                    )
                  }}
                />
              </GestureHandlerRootView>
            )
          ) : queue.items.length === 0 ? (
            <AppText
              variant="meta"
              color={colors.textMuted}
              style={{ textAlign: 'center', marginTop: spacing.xl }}
            >
              Nothing queued yet.
            </AppText>
          ) : (
            <GestureHandlerRootView style={{ flex: 1 }}>
              <DraggableFlatList
                data={queue.items}
                keyExtractor={(item) => item.libraryItemId}
                onDragBegin={() => setDragActive(true)}
                onDragEnd={({ from, to }) => {
                  setDragActive(false)
                  if (from !== to) reorderQueue(from, to)
                }}
                renderItem={(params: RenderItemParams<QueueEntry>) => {
                  // Manual is the only hand-edited mode; Playlist is server-owned,
                  // so reorder + remove are read-only there.
                  const editable = settings.queueMode === 'manual'
                  return (
                    <QueueRow
                      {...params}
                      canDrag={editable}
                      canRemove={editable}
                      showBolt={false}
                      dragActive={dragActive}
                      onJump={() => {
                        sheetRef.current?.dismiss()
                        onJump(params.item.libraryItemId)
                      }}
                      onRemove={() => removeFromQueue(params.item.libraryItemId)}
                    />
                  )
                }}
              />
            </GestureHandlerRootView>
          )}
        </Sheet>

        <Sheet ref={rulesRef} kicker="Auto-queue" stackBehavior="push">
          <AppText variant="caption" color={colors.textMuted} style={styles.rulesHint}>
            Higher rules fill the queue first. Drag to reprioritize.
          </AppText>
          <GestureHandlerRootView>
            <DraggableFlatList
              data={settings.queueAutoRules}
              keyExtractor={(r) => r.id}
              onDragEnd={({ data, from, to }) => {
                if (from !== to) setSetting('queueAutoRules', data)
              }}
              renderItem={({ item, drag, isActive }: RenderItemParams<AutoRulePref>) => {
                const copy = RULE_COPY[item.id]
                // new-in-series-all is a sub-modifier of new-in-series: indent it
                // and dim/disable it while the parent rule is off.
                const isSub = item.id === 'new-in-series-all'
                const parentOff =
                  isSub && !settings.queueAutoRules.find((x) => x.id === 'new-in-series')?.on
                return (
                  <View
                    style={[
                      styles.row,
                      isActive && styles.rowDragging,
                      isSub && styles.subRule,
                      parentOff && styles.ruleDisabled,
                    ]}
                  >
                    <Pressable onLongPress={drag} disabled={parentOff} hitSlop={8}>
                      <Icon name={icons.dragHandle} size={20} color={colors.textMuted} />
                    </Pressable>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <AppText variant="label">{copy.label}</AppText>
                      <AppText
                        variant="caption"
                        color={colors.textMuted}
                        style={{ marginTop: 3 }}
                        numberOfLines={2}
                      >
                        {copy.desc}
                      </AppText>
                    </View>
                    <Touchable
                      disabled={parentOff}
                      onPress={() => toggleAutoRule(item.id)}
                      style={[styles.toggleTrack, item.on && styles.toggleTrackOn]}
                    >
                      <View style={[styles.toggleKnob, item.on && styles.toggleKnobOn]} />
                    </Touchable>
                  </View>
                )
              }}
            />
          </GestureHandlerRootView>
          <AppText variant="caption" color={colors.textFaint} style={styles.rulesHint}>
            Changes rebuild the queue immediately.
          </AppText>
        </Sheet>

        <AddBooksSheet ref={addBooksRef} />
      </>
    )
  },
)

/** A search-the-library picker that appends the tapped book to the queue's
 *  durable manual list. Books already queued are marked and no-op. */
const AddBooksSheet = forwardRef<SheetHandle>(function AddBooksSheet(_props, ref) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const sheetRef = useRef<SheetRef>(null)
  useImperativeHandle(ref, () => ({
    present: () => {
      setQuery('')
      setResults([])
      sheetRef.current?.present()
    },
    dismiss: () => sheetRef.current?.dismiss(),
  }))

  const queue = useSyncExternalStore(subscribeQueue, getQueueState)
  const queuedIds = useMemo(
    () => new Set(queue.manual.map((m) => m.libraryItemId)),
    [queue.manual],
  )
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ABSLibraryItem[]>([])
  const [loading, setLoading] = useState(false)
  const libraryIdRef = useRef<string | null>(null)

  const resolveLibraryId = useCallback(async () => {
    if (libraryIdRef.current) return libraryIdRef.current
    const libs = await getLibraries()
    libraryIdRef.current = (libs.find((l) => l.mediaType === 'book') ?? libs[0])?.id ?? null
    return libraryIdRef.current
  }, [])

  const runSearch = useCallback(
    async (q: string) => {
      const trimmed = q.trim()
      if (!trimmed) {
        setResults([])
        return
      }
      setLoading(true)
      try {
        const libraryId = await resolveLibraryId()
        if (!libraryId) return
        const data = await searchLibraryAll(libraryId, trimmed)
        setResults(data.book.map((b) => b.libraryItem))
      } catch {
        setResults([])
      } finally {
        setLoading(false)
      }
    },
    [resolveLibraryId],
  )

  useEffect(() => {
    const t = setTimeout(() => void runSearch(query), 300)
    return () => clearTimeout(t)
  }, [query, runSearch])

  return (
    <Sheet ref={sheetRef} kicker="Add to queue" snapPoints={['80%']} stackBehavior="push">
      <View style={styles.addSearch}>
        <Icon name={icons.search} size={18} color={colors.textMuted} />
        <BottomSheetTextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search your library"
          placeholderTextColor={colors.textFaint}
          style={styles.addSearchInput}
          autoCorrect={false}
          autoCapitalize="none"
        />
      </View>
      <BottomSheetFlatList
        data={results}
        keyExtractor={(it) => it.id}
        ListEmptyComponent={
          <AppText
            variant="meta"
            color={colors.textMuted}
            style={{ textAlign: 'center', paddingVertical: spacing.xl }}
          >
            {loading ? 'Searching...' : query.trim() ? 'No matches' : 'Search to add a book'}
          </AppText>
        }
        renderItem={({ item }) => {
          const already = queuedIds.has(item.id)
          return (
            <Touchable
              style={styles.addRow}
              disabled={already}
              onPress={() => {
                addToQueue({
                  libraryItemId: item.id,
                  title: itemTitle(item),
                  author: itemAuthor(item),
                })
                haptics.success()
                showToast(`Added ${itemTitle(item)} to queue`)
              }}
            >
              <Cover
                uri={coverUrl(item.id)}
                itemId={item.id}
                size={46}
                radius={radius.tile}
                fallback={{ hue: coverHue(item.id), initial: itemTitle(item).charAt(0).toUpperCase() }}
              />
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="label" numberOfLines={1}>
                  {itemTitle(item)}
                </AppText>
                <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                  {itemAuthor(item)}
                </AppText>
              </View>
              <Icon
                name={already ? icons.checkCircle : icons.add}
                size={22}
                color={already ? colors.success : colors.accent}
              />
            </Touchable>
          )
        }}
      />
    </Sheet>
  )
})

function QueueRow({
  item,
  drag,
  isActive,
  canDrag,
  canRemove,
  showBolt,
  dragActive,
  onJump,
  onRemove,
}: RenderItemParams<QueueEntry> & {
  // Drag handle shown + long-press arms a reorder (Manual mode, and hand-added
  // rows inside the Auto list, which reorder among themselves).
  canDrag: boolean
  // Remove (X) shown - only hand-added rows can be pulled out inline.
  canRemove: boolean
  // Auto-generated rows show a lightning bolt where the X would be: a marker
  // that the rules manage this pick (it isn't removable, it'll come back).
  showBolt: boolean
  dragActive: boolean
  onJump: () => void
  onRemove: () => void
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={[styles.row, isActive && styles.rowDragging]}>
      {canDrag ? (
        <Pressable onLongPress={drag} disabled={dragActive} hitSlop={8}>
          <Icon name={icons.dragHandle} size={20} color={colors.textMuted} />
        </Pressable>
      ) : (
        <View style={{ width: 20 }} />
      )}
      <Touchable style={styles.rowTap} onPress={onJump}>
        <Cover
          uri={coverUrl(item.libraryItemId)}
          itemId={item.libraryItemId}
          size={46}
          radius={radius.tile}
          fallback={{
            hue: coverHue(item.libraryItemId),
            initial: item.title.charAt(0).toUpperCase(),
          }}
        />
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="label" numberOfLines={1}>
            {item.title}
          </AppText>
          <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
            {item.author}
          </AppText>
        </View>
      </Touchable>
      {canRemove ? (
        <IconButton name={icons.close} size={20} color={colors.textMuted} onPress={onRemove} />
      ) : showBolt ? (
        <View style={styles.boltSlot}>
          <Icon name={icons.bolt} size={16} color={colors.accent} />
        </View>
      ) : (
        <View style={{ width: 20 }} />
      )}
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    segFull: {
      flexDirection: 'row',
      gap: 4,
      backgroundColor: colors.fill,
      borderRadius: radius.card,
      padding: 4,
      marginBottom: spacing.sm,
    },
    seg: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: spacing.sm + 2,
      borderRadius: radius.row,
    },
    segOn: { backgroundColor: colors.accentWash },
    subRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    rulesBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
    },
    addSearch: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      marginBottom: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    addSearchInput: {
      flex: 1,
      paddingVertical: spacing.sm + 2,
      color: colors.text,
      fontSize: 15,
    },
    addRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.xs,
    },
    rowNow: {
      backgroundColor: colors.accentWash,
      borderRadius: radius.row,
      marginBottom: spacing.sm,
    },
    rowTap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minWidth: 0 },
    rowDragging: { backgroundColor: colors.high, borderRadius: radius.row },
    rulesHint: { paddingHorizontal: spacing.xs, paddingVertical: spacing.sm },
    boltSlot: { width: 20, alignItems: 'center', justifyContent: 'center' },
    subRule: { paddingLeft: spacing.xl, marginLeft: spacing.xs },
    ruleDisabled: { opacity: 0.4 },
    empty: { alignItems: 'center', paddingVertical: spacing.xxl, paddingHorizontal: spacing.xl },
    hintRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: spacing.md },
    toggleTrack: {
      width: 46,
      height: 27,
      borderRadius: 999,
      backgroundColor: colors.elevated,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      justifyContent: 'center',
    },
    toggleTrackOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    toggleKnob: { width: 21, height: 21, borderRadius: 11, backgroundColor: '#fff', marginLeft: 3 },
    toggleKnobOn: { marginLeft: 22 },
  })
