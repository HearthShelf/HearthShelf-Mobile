/**
 * Shared queue-editing UI used by the player QueueSheet and the Playback
 * settings panel, so both surfaces manage the queue the same way:
 *   - AutoRuleList: drag-to-reorder + toggle the Auto-queue rules.
 *   - ManualQueueEditor: in Manual mode the durable hand-queued list; in Auto
 *     mode ONE merged list where rule picks are read-only (bolt marker) and
 *     hand-added books keep their drag/remove inline where they sit.
 *
 * Drag is a long-press on the handle (react-native-draggable-flatlist), so these
 * coexist with a surrounding ScrollView's own scroll gesture.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { NestableDraggableFlatList, type RenderItemParams } from 'react-native-draggable-flatlist'
import { coverHue } from '@hearthshelf/core'
import type { AutoRulePref, QueueEntry } from '@hearthshelf/core'
import {
  getQueueState,
  reorderQueue,
  removeFromQueue,
  setManual,
  subscribeQueue,
  AUTO_RULE_COPY,
} from './queue'
import { coverUrl } from '@/api/abs'
import { AppText, Cover, IconButton, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

// Drag-to-reorder + toggle list of the Auto-queue rules. Order = priority.
export function AutoRuleList({
  rules,
  onChange,
}: {
  rules: AutoRulePref[]
  onChange: (rules: AutoRulePref[]) => void
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const toggle = (id: AutoRulePref['id']) =>
    onChange(rules.map((r) => (r.id === id ? { ...r, on: !r.on } : r)))
  const reorder = (from: number, to: number) => {
    const next = rules.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onChange(next)
  }
  return (
    <View>
      <NestableDraggableFlatList
        data={rules}
        keyExtractor={(r) => r.id}
        onDragEnd={({ from, to }) => {
          if (from !== to) reorder(from, to)
        }}
        renderItem={({ item, drag, isActive }: RenderItemParams<AutoRulePref>) => {
          const copy = AUTO_RULE_COPY[item.id]
          // new-in-series-all is a sub-modifier of new-in-series: indent it and
          // dim/disable it while the parent is off (it does nothing on its own).
          const isSub = item.id === 'new-in-series-all'
          const parentOff = isSub && !rules.find((x) => x.id === 'new-in-series')?.on
          return (
            <View
              style={[
                styles.row,
                isActive && styles.rowDragging,
                isSub && styles.subRule,
                parentOff && styles.ruleDisabled,
              ]}
            >
              <Pressable onLongPress={drag} hitSlop={8}>
                <Icon name={icons.dragHandle} size={20} color={colors.textMuted} />
              </Pressable>
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="label">{copy.label}</AppText>
                <AppText variant="caption" color={colors.textMuted} numberOfLines={2}>
                  {copy.desc}
                </AppText>
              </View>
              <Touchable
                disabled={parentOff}
                onPress={() => toggle(item.id)}
                style={[styles.toggleTrack, item.on && styles.toggleTrackOn]}
              >
                <View style={[styles.toggleKnob, item.on && styles.toggleKnobOn]} />
              </Touchable>
            </View>
          )
        }}
      />
    </View>
  )
}

function ManualRow({
  item,
  drag,
  isActive,
  canEdit,
}: RenderItemParams<QueueEntry> & { canEdit: boolean }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={[styles.row, isActive && styles.rowDragging]}>
      {canEdit ? (
        <Pressable onLongPress={drag} hitSlop={8}>
          <Icon name={icons.dragHandle} size={20} color={colors.textMuted} />
        </Pressable>
      ) : (
        <View style={{ width: 20 }} />
      )}
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
      {canEdit ? (
        <IconButton
          name={icons.close}
          size={20}
          color={colors.textMuted}
          onPress={() => removeFromQueue(item.libraryItemId)}
        />
      ) : (
        <View style={{ width: 20, alignItems: 'center' }}>
          <Icon name={icons.bolt} size={16} color={colors.accent} />
        </View>
      )}
    </View>
  )
}

// The up-next queue editor. In Manual mode it's the durable hand-queued list.
// In Auto mode it's ONE merged list: rule-generated picks carry a lightning
// bolt (read-only), hand-added books keep their drag handle + X inline where
// they sit, and dragging a hand-added book reorders the manual books among
// themselves.
export function ManualQueueEditor({ mode }: { mode: 'manual' | 'auto' }) {
  const colors = useColors()
  const queue = useSyncExternalStore(subscribeQueue, getQueueState)
  const manualIds = useMemo(() => new Set(queue.manual.map((m) => m.libraryItemId)), [queue.manual])

  if (mode === 'auto') {
    if (queue.items.length === 0) {
      return (
        <AppText
          variant="caption"
          color={colors.textMuted}
          style={{ paddingHorizontal: spacing.xs }}
        >
          Nothing queued yet. Books you add by hand show up here too.
        </AppText>
      )
    }
    return (
      <NestableDraggableFlatList
        data={queue.items}
        keyExtractor={(item) => item.libraryItemId}
        onDragEnd={({ data, from, to }) => {
          // Reorder the manual rows among themselves (see QueueSheet).
          if (from !== to) setManual(data.filter((e) => manualIds.has(e.libraryItemId)))
        }}
        renderItem={(params: RenderItemParams<QueueEntry>) => (
          <ManualRow {...params} canEdit={manualIds.has(params.item.libraryItemId)} />
        )}
      />
    )
  }

  return (
    <View>
      {queue.manual.length === 0 ? (
        <AppText
          variant="caption"
          color={colors.textMuted}
          style={{ paddingHorizontal: spacing.xs }}
        >
          Nothing queued. Add books from a book page.
        </AppText>
      ) : (
        <NestableDraggableFlatList
          data={queue.manual}
          keyExtractor={(item) => item.libraryItemId}
          onDragEnd={({ from, to }) => {
            if (from !== to) reorderQueue(from, to)
          }}
          renderItem={(params: RenderItemParams<QueueEntry>) => <ManualRow {...params} canEdit />}
        />
      )}
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.xs,
    },
    rowDragging: { backgroundColor: colors.high, borderRadius: radius.row },
    subRule: { paddingLeft: spacing.xl, marginLeft: spacing.xs },
    ruleDisabled: { opacity: 0.4 },
    toggleTrack: {
      width: 42,
      height: 26,
      borderRadius: 999,
      backgroundColor: colors.fill,
      padding: 3,
      justifyContent: 'center',
    },
    toggleTrackOn: { backgroundColor: colors.accent },
    toggleKnob: {
      width: 20,
      height: 20,
      borderRadius: 999,
      backgroundColor: colors.textMuted,
    },
    toggleKnobOn: { backgroundColor: colors.onAccent ?? '#fff', alignSelf: 'flex-end' },
  })
