/**
 * Up-next queue sheet: Off/Manual/Auto/Playlist mode, the now-playing row, and
 * a drag-to-reorder up-next list (Manual mode) via react-native-draggable-
 * flatlist. Ported from the WebApp's MobilePlayer queue sheet + queueStore.ts.
 * Auto mode opens a second sub-sheet of toggleable rules.
 */
import { forwardRef, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import DraggableFlatList, { type RenderItemParams } from 'react-native-draggable-flatlist'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { coverHue } from '@hearthshelf/core'
import type { QueueEntry } from '@hearthshelf/core'
import {
  getQueueState,
  reorderQueue,
  removeFromQueue,
  subscribeQueue,
  QUEUE_MODES,
  QUEUE_MODE_SUB,
  AUTO_RULE_COPY,
} from './queue'
import { getSettingsState, setQueueMode, subscribeSettings, toggleAutoRule } from '@/store/settings'
import { getState, subscribe } from './store'
import { coverUrl } from '@/api/abs'
import { AppText, Cover, IconButton, Sheet, type SheetRef, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { colors, radius, spacing } from '@/ui/theme'
import type { SheetHandle } from './sheets'

const MODES = QUEUE_MODES
const MODE_SUB = QUEUE_MODE_SUB
const RULE_COPY = AUTO_RULE_COPY

export const QueueSheet = forwardRef<SheetHandle, { onJump: (itemId: string) => void }>(
  function QueueSheet({ onJump }, ref) {
    const sheetRef = useRef<SheetRef>(null)
    const rulesRef = useRef<SheetRef>(null)
    useImperativeHandle(ref, () => ({
      present: () => sheetRef.current?.present(),
      dismiss: () => sheetRef.current?.dismiss(),
    }))

    const queue = useSyncExternalStore(subscribeQueue, getQueueState)
    const settings = useSyncExternalStore(subscribeSettings, getSettingsState)
    const { nowPlaying } = useSyncExternalStore(subscribe, getState)
    const [dragActive, setDragActive] = useState(false)

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
                <AppText variant="label" color={settings.queueMode === m.v ? colors.text : colors.textMuted}>
                  {m.label}
                </AppText>
              </Touchable>
            ))}
          </View>

          <View style={styles.subRow}>
            <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
              {MODE_SUB[settings.queueMode]}
            </AppText>
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
                size={46}
                radius={radius.tile}
                fallback={{ hue: coverHue(nowPlaying.itemId), initial: nowPlaying.title.charAt(0).toUpperCase() }}
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
              <AppText variant="caption" color={colors.textMuted} style={{ textAlign: 'center', marginTop: spacing.xs }}>
                Playback stops when this book ends. Switch to Manual or Auto to keep going.
              </AppText>
            </View>
          ) : queue.items.length === 0 ? (
            <AppText variant="meta" color={colors.textMuted} style={{ textAlign: 'center', marginTop: spacing.xl }}>
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
                renderItem={(params: RenderItemParams<QueueEntry>) => (
                  <QueueRow
                    {...params}
                    draggable={settings.queueMode === 'manual'}
                    dragActive={dragActive}
                    onJump={() => {
                      sheetRef.current?.dismiss()
                      onJump(params.item.libraryItemId)
                    }}
                    onRemove={() => removeFromQueue(params.item.libraryItemId)}
                  />
                )}
              />
            </GestureHandlerRootView>
          )}
        </Sheet>

        <Sheet ref={rulesRef} kicker="Auto-queue" stackBehavior="push">
          <View>
            {settings.queueAutoRules.map((r) => {
              const copy = RULE_COPY[r.id]
              return (
                <Touchable key={r.id} style={styles.row} onPress={() => toggleAutoRule(r.id)}>
                  <View style={{ flex: 1 }}>
                    <AppText variant="label">{copy.label}</AppText>
                    <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 3 }}>
                      {copy.desc}
                    </AppText>
                  </View>
                  <View style={[styles.toggleTrack, r.on && styles.toggleTrackOn]}>
                    <View style={[styles.toggleKnob, r.on && styles.toggleKnobOn]} />
                  </View>
                </Touchable>
              )
            })}
          </View>
        </Sheet>
      </>
    )
  }
)

function QueueRow({
  item,
  drag,
  isActive,
  draggable,
  dragActive,
  onJump,
  onRemove,
}: RenderItemParams<QueueEntry> & {
  draggable: boolean
  dragActive: boolean
  onJump: () => void
  onRemove: () => void
}) {
  return (
    <View style={[styles.row, isActive && styles.rowDragging]}>
      {draggable ? (
        <Pressable onLongPress={drag} disabled={dragActive} hitSlop={8}>
          <Icon name={icons.dragHandle} size={20} color={colors.textMuted} />
        </Pressable>
      ) : (
        <View style={{ width: 20 }} />
      )}
      <Touchable style={styles.rowTap} onPress={onJump}>
        <Cover
          uri={coverUrl(item.libraryItemId)}
          size={46}
          radius={radius.tile}
          fallback={{ hue: coverHue(item.libraryItemId), initial: item.title.charAt(0).toUpperCase() }}
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
      <IconButton name={icons.close} size={20} color={colors.textMuted} onPress={onRemove} />
    </View>
  )
}

const styles = StyleSheet.create({
  segFull: {
    flexDirection: 'row',
    gap: 4,
    backgroundColor: colors.fill,
    borderRadius: radius.card,
    padding: 4,
    marginBottom: spacing.sm,
  },
  seg: { flex: 1, alignItems: 'center', paddingVertical: spacing.sm + 2, borderRadius: radius.row },
  segOn: { backgroundColor: colors.card },
  subRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.md },
  rulesBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    backgroundColor: colors.fill,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
  },
  rowNow: { backgroundColor: colors.accentWash, borderRadius: radius.row, marginBottom: spacing.sm },
  rowTap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minWidth: 0 },
  rowDragging: { backgroundColor: colors.high, borderRadius: radius.row },
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
