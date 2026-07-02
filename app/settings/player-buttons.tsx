/**
 * Player buttons editor. One draggable list split by three section headers -
 * On screen (the row under the transport), In tray (the More sheet), and Hidden.
 * Long-press anywhere on a row (not just the handle icon) to drag it across a
 * header and change its placement, or within a section to reorder. Each row
 * also has a Quick Hide eye button that toggles it straight to/from Hidden
 * without a drag. An "Icon only" switch drops labels from the on-screen row so
 * more buttons fit.
 *
 * The single list is a flattened sequence of header sentinels + action rows.
 * On drag end we walk the new order, tracking which header each action fell
 * under, and rebuild playerActions from that - so placement and order both come
 * straight out of where things landed. The on-screen section is capped
 * (MAX_ONSCREEN_ACTIONS); an overflowing drop spills into the tray.
 *
 * Reached from My Settings > Playback > "Player buttons" and the player's More
 * sheet ("Edit buttons"). The arrangement lives in the settings store, so it
 * syncs across devices like every other preference.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import DraggableFlatList, { type RenderItemParams } from 'react-native-draggable-flatlist'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import {
  getSettingsState,
  subscribeSettings,
  setPlayerActions,
  setSetting,
  MAX_ONSCREEN_ACTIONS,
  type ActionPlacement,
  type PlayerActionKey,
  type PlayerActionPref,
} from '@/store/settings'
import { ACTION_META } from '@/player/actions'
import { AppText } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { SettingsToggle } from '@/ui/settingsControls'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

const SECTIONS: { placement: ActionPlacement; title: string; hint: string }[] = [
  { placement: 'onscreen', title: 'On screen', hint: 'Shown in the row under the controls' },
  { placement: 'tray', title: 'In tray', hint: 'Tucked into the More button' },
  { placement: 'hidden', title: 'Hidden', hint: 'Not shown anywhere' },
]

/** One entry in the flat draggable list: a section header, or an action row. */
type ListItem =
  { type: 'header'; placement: ActionPlacement } | { type: 'action'; action: PlayerActionPref }

const ITEM_KEY = (i: ListItem) =>
  i.type === 'header' ? `header:${i.placement}` : `action:${i.action.key}`

/** Build the flat list: each section's header followed by its actions, in order. */
function toListItems(actions: PlayerActionPref[]): ListItem[] {
  const items: ListItem[] = []
  for (const sec of SECTIONS) {
    items.push({ type: 'header', placement: sec.placement })
    for (const a of actions.filter((x) => x.placement === sec.placement)) {
      items.push({ type: 'action', action: a })
    }
  }
  return items
}

/**
 * Walk the dragged order top-to-bottom, assigning each action to the most
 * recent header above it, and rebuild playerActions. If the on-screen section
 * overflows its cap, the extras past the cap spill into the tray (keeping their
 * relative order) rather than being silently dropped.
 */
function fromListItems(items: ListItem[]): PlayerActionPref[] {
  let current: ActionPlacement = 'onscreen'
  let onscreenCount = 0
  const result: PlayerActionPref[] = []
  for (const it of items) {
    if (it.type === 'header') {
      current = it.placement
      continue
    }
    let placement = current
    if (placement === 'onscreen') {
      if (onscreenCount >= MAX_ONSCREEN_ACTIONS) placement = 'tray'
      else onscreenCount++
    }
    result.push({ key: it.action.key, placement })
  }
  return result
}

export default function PlayerButtonsScreen() {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)

  const listItems = toListItems(s.playerActions)
  const onScreenCount = s.playerActions.filter((a) => a.placement === 'onscreen').length

  return (
    <GestureHandlerRootView style={styles.screen}>
      <View style={styles.iconOnlyRow}>
        <View style={{ flex: 1 }}>
          <AppText variant="body">Icon only</AppText>
        </View>
        <SettingsToggle
          on={s.playerActionsIconOnly}
          onChange={(v) => setSetting('playerActionsIconOnly', v)}
        />
      </View>

      <AppText variant="caption" color={colors.textFaint} style={styles.dragHint}>
        Hold a button and drag it under a heading to move it, or tap the eye to quick hide.
      </AppText>

      <DraggableFlatList
        data={listItems}
        keyExtractor={ITEM_KEY}
        contentContainerStyle={styles.listContent}
        onDragEnd={({ data }) => setPlayerActions(fromListItems(data))}
        renderItem={(params: RenderItemParams<ListItem>) =>
          params.item.type === 'header' ? (
            <SectionHeader placement={params.item.placement} onScreenCount={onScreenCount} />
          ) : (
            <ActionRow {...params} />
          )
        }
      />
    </GestureHandlerRootView>
  )
}

function SectionHeader({
  placement,
  onScreenCount,
}: {
  placement: ActionPlacement
  onScreenCount: number
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const sec = SECTIONS.find((x) => x.placement === placement)!
  const atCap = placement === 'onscreen' && onScreenCount >= MAX_ONSCREEN_ACTIONS
  return (
    <View style={styles.sectionHeader}>
      <View style={styles.sectionTitleRow}>
        <AppText variant="eyebrow" color={colors.textMuted}>
          {sec.title}
        </AppText>
        {placement === 'onscreen' ? (
          <AppText variant="caption" color={atCap ? colors.accent : colors.textFaint}>
            {onScreenCount}/{MAX_ONSCREEN_ACTIONS}
          </AppText>
        ) : null}
      </View>
      <AppText variant="caption" color={colors.textFaint} style={{ marginTop: 1 }}>
        {sec.hint}
      </AppText>
    </View>
  )
}

function ActionRow({ item, drag, isActive }: RenderItemParams<ListItem>) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  if (item.type !== 'action') return null
  const meta = ACTION_META[item.action.key]
  const hidden = item.action.placement === 'hidden'
  return (
    <Pressable
      onLongPress={drag}
      delayLongPress={150}
      style={[styles.row, isActive && styles.rowDragging]}
    >
      <Icon name={icons.dragHandle} size={22} color={colors.textMuted} />
      <Icon name={meta.icon} size={20} color={colors.textMuted} />
      <View style={{ flex: 1 }}>
        <AppText variant="meta">{meta.label}</AppText>
        {meta.comingSoon ? (
          <AppText variant="caption" color={colors.textFaint} style={{ marginTop: 1 }}>
            Coming soon
          </AppText>
        ) : null}
      </View>
      <Pressable onPress={() => toggleHidden(item.action.key)} hitSlop={8} style={styles.hideBtn}>
        <Icon name={hidden ? icons.hidden : icons.visible} size={20} color={colors.textMuted} />
      </Pressable>
    </Pressable>
  )
}

/** Quick Hide: toggle one action between Hidden and its last visible placement. */
function toggleHidden(key: PlayerActionKey): void {
  const s = getSettingsState()
  const next = s.playerActions.map((a) => {
    if (a.key !== key) return a
    if (a.placement === 'hidden') return { ...a, placement: 'tray' as ActionPlacement }
    return { ...a, placement: 'hidden' as ActionPlacement }
  })
  setPlayerActions(next)
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
  screen: { flex: 1 },
  iconOnlyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  dragHint: { paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: 140 },
  sectionHeader: {
    paddingTop: spacing.lg,
    paddingBottom: spacing.sm,
  },
  sectionTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.row,
    marginBottom: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  rowDragging: { backgroundColor: colors.high, borderColor: colors.accent },
  hideBtn: { padding: spacing.xs },
  })
