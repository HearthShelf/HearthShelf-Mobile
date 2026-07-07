/**
 * Shared queue-editing UI used by the player QueueSheet and the Playback
 * settings panel, so both surfaces manage the queue the same way:
 *   - AutoRuleList: drag-to-reorder + toggle the Auto-queue rules.
 *   - ManualQueueEditor: the durable hand-queued list (drag/remove), with the
 *     current Auto picks shown read-only + grayed above it in Auto mode.
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
  subscribeQueue,
  AUTO_RULE_COPY,
} from './queue'
import { coverUrl } from '@/api/abs'
import { AppText, Cover, IconButton, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

function sectionLabel(text: string, colors: Palette) {
  return (
    <AppText
      variant="meta"
      color={colors.textMuted}
      style={{
        marginTop: spacing.md,
        marginBottom: spacing.xs,
        paddingHorizontal: spacing.xs,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
    >
      {text}
    </AppText>
  )
}

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
          return (
            <View style={[styles.row, isActive && styles.rowDragging]}>
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
  editable,
}: RenderItemParams<QueueEntry> & { editable: boolean }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={[styles.row, isActive && styles.rowDragging, !editable && { opacity: 0.5 }]}>
      {editable ? (
        <Pressable onLongPress={drag} hitSlop={8}>
          <Icon name={icons.dragHandle} size={20} color={colors.textMuted} />
        </Pressable>
      ) : (
        <View style={{ width: 20, alignItems: 'center' }}>
          <Icon name={icons.bolt} size={16} color={colors.textMuted} />
        </View>
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
      {editable ? (
        <IconButton
          name={icons.close}
          size={20}
          color={colors.textMuted}
          onPress={() => removeFromQueue(item.libraryItemId)}
        />
      ) : (
        <View style={{ width: 20 }} />
      )}
    </View>
  )
}

// The durable hand-queued list (drag/remove). In Auto mode, the current Auto
// picks are shown read-only + grayed above the editable manual list.
export function ManualQueueEditor({ mode }: { mode: 'manual' | 'auto' }) {
  const colors = useColors()
  const queue = useSyncExternalStore(subscribeQueue, getQueueState)

  return (
    <View>
      {mode === 'auto' && (
        <>
          {sectionLabel('Auto picks', colors)}
          {queue.items.length === 0 ? (
            <AppText
              variant="caption"
              color={colors.textMuted}
              style={{ paddingHorizontal: spacing.xs }}
            >
              Auto hasn't picked anything yet.
            </AppText>
          ) : (
            queue.items.map((item) => (
              <ManualRow
                key={item.libraryItemId}
                item={item}
                drag={() => {}}
                getIndex={() => undefined}
                isActive={false}
                editable={false}
              />
            ))
          )}
          {sectionLabel('Books you queued by hand', colors)}
        </>
      )}
      {queue.manual.length === 0 ? (
        <AppText
          variant="caption"
          color={colors.textMuted}
          style={{ paddingHorizontal: spacing.xs }}
        >
          {mode === 'auto'
            ? 'Nothing queued by hand. Books you add play after your Auto picks.'
            : 'Nothing queued. Add books from a book page.'}
        </AppText>
      ) : (
        <NestableDraggableFlatList
          data={queue.manual}
          keyExtractor={(item) => item.libraryItemId}
          onDragEnd={({ from, to }) => {
            if (from !== to) reorderQueue(from, to)
          }}
          renderItem={(params: RenderItemParams<QueueEntry>) => <ManualRow {...params} editable />}
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
