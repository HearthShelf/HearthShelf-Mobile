/**
 * Player buttons editor. Arranges the player's action buttons across three
 * placements - On screen (the row under the transport), In tray (the More
 * sheet), and Hidden - and reorders within each. There's also an "Icon only"
 * switch that drops labels from the on-screen row so more buttons fit.
 *
 * Reached two ways (both land here): My Settings > Playback > "Player buttons",
 * and the Edit toggle in the player's More sheet. The arrangement lives in the
 * settings store (playerActions), so it syncs across devices like every other
 * preference.
 */
import { useSyncExternalStore } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
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
import { AppText, IconButton, Screen, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { SettingsToggle } from '@/ui/settingsControls'
import { colors, radius, spacing } from '@/ui/theme'

const SECTIONS: { placement: ActionPlacement; title: string; hint: string }[] = [
  { placement: 'onscreen', title: 'On screen', hint: 'Shown in the row under the controls' },
  { placement: 'tray', title: 'In tray', hint: 'Tucked into the More button' },
  { placement: 'hidden', title: 'Hidden', hint: 'Not shown anywhere' },
]

export default function PlayerButtonsScreen() {
  const router = useRouter()
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)
  const actions = s.playerActions

  const onScreenCount = actions.filter((a) => a.placement === 'onscreen').length
  const atOnScreenCap = onScreenCount >= MAX_ONSCREEN_ACTIONS

  /** Rebuild the list with `key` reassigned to `placement`, appended to the end
   *  of that section (its new order position). */
  const moveTo = (key: PlayerActionKey, placement: ActionPlacement) => {
    const moved = actions.find((a) => a.key === key)
    if (!moved || moved.placement === placement) return
    const without = actions.filter((a) => a.key !== key)
    setPlayerActions([...without, { key, placement }])
  }

  /** Swap `key` with its neighbor in the given direction, within its section. */
  const reorder = (key: PlayerActionKey, dir: -1 | 1) => {
    const placement = actions.find((a) => a.key === key)?.placement
    if (!placement) return
    const group = actions.filter((a) => a.placement === placement)
    const idx = group.findIndex((a) => a.key === key)
    const swapWith = idx + dir
    if (swapWith < 0 || swapWith >= group.length) return
    const reordered = group.slice()
    ;[reordered[idx], reordered[swapWith]] = [reordered[swapWith], reordered[idx]]
    // Splice the reordered group back into the flat list in section order.
    const others = actions.filter((a) => a.placement !== placement)
    const rebuilt: PlayerActionPref[] = []
    for (const sec of SECTIONS) {
      if (sec.placement === placement) rebuilt.push(...reordered)
      else rebuilt.push(...others.filter((a) => a.placement === sec.placement))
    }
    setPlayerActions(rebuilt)
  }

  return (
    <Screen>
      <View style={styles.header}>
        <IconButton name={icons.back} onPress={() => router.back()} style={styles.headerBtn} />
        <AppText variant="title">Player buttons</AppText>
      </View>

      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.iconOnlyRow}>
          <View style={{ flex: 1 }}>
            <AppText variant="body">Icon only</AppText>
            <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
              Hide labels on the on-screen buttons so more fit in the row.
            </AppText>
          </View>
          <SettingsToggle
            on={s.playerActionsIconOnly}
            onChange={(v) => setSetting('playerActionsIconOnly', v)}
          />
        </View>

        {SECTIONS.map((sec) => {
          const group = actions.filter((a) => a.placement === sec.placement)
          const showCap = sec.placement === 'onscreen'
          return (
            <View key={sec.placement} style={{ gap: spacing.sm }}>
              <View style={styles.sectionHead}>
                <AppText variant="eyebrow" color={colors.textMuted}>
                  {sec.title}
                </AppText>
                {showCap ? (
                  <AppText variant="caption" color={atOnScreenCap ? colors.accent : colors.textMuted}>
                    {onScreenCount}/{MAX_ONSCREEN_ACTIONS}
                  </AppText>
                ) : null}
              </View>
              <AppText variant="caption" color={colors.textFaint} style={{ marginTop: -spacing.xs }}>
                {sec.hint}
              </AppText>

              {group.length === 0 ? (
                <View style={styles.emptyGroup}>
                  <AppText variant="caption" color={colors.textFaint}>
                    Nothing here
                  </AppText>
                </View>
              ) : (
                <View style={styles.group}>
                  {group.map((a, i) => (
                    <ActionEditorRow
                      key={a.key}
                      action={a}
                      first={i === 0}
                      last={i === group.length - 1}
                      onScreenCapReached={atOnScreenCap}
                      onReorder={(dir) => reorder(a.key, dir)}
                      onMove={(p) => moveTo(a.key, p)}
                    />
                  ))}
                </View>
              )}
            </View>
          )
        })}
      </ScrollView>
    </Screen>
  )
}

function ActionEditorRow({
  action,
  first,
  last,
  onScreenCapReached,
  onReorder,
  onMove,
}: {
  action: PlayerActionPref
  first: boolean
  last: boolean
  onScreenCapReached: boolean
  onReorder: (dir: -1 | 1) => void
  onMove: (placement: ActionPlacement) => void
}) {
  const meta = ACTION_META[action.key]
  // Can't add another on-screen button once the cap is hit (unless this one is
  // already on-screen, where the chip is just a highlight).
  const onScreenBlocked = onScreenCapReached && action.placement !== 'onscreen'

  return (
    <View style={[styles.row, !last && styles.rowDivider]}>
      <Icon name={meta.icon} size={20} color={colors.textMuted} />
      <View style={{ flex: 1 }}>
        <AppText variant="meta">{meta.label}</AppText>
        {meta.comingSoon ? (
          <AppText variant="caption" color={colors.textFaint} style={{ marginTop: 1 }}>
            Coming soon
          </AppText>
        ) : null}
      </View>

      {/* Reorder within the section */}
      <View style={styles.arrows}>
        <IconButton
          name={icons.expand}
          size={18}
          color={first ? colors.textFaint : colors.text}
          onPress={first ? undefined : () => onReorder(-1)}
          style={styles.arrowBtn}
        />
        <IconButton
          name={icons.collapse}
          size={18}
          color={last ? colors.textFaint : colors.text}
          onPress={last ? undefined : () => onReorder(1)}
          style={styles.arrowBtn}
        />
      </View>

      {/* Placement chips */}
      <View style={styles.placeChips}>
        <PlaceChip
          icon={icons.onScreen}
          on={action.placement === 'onscreen'}
          disabled={onScreenBlocked}
          onPress={() => onMove('onscreen')}
        />
        <PlaceChip
          icon={icons.inTray}
          on={action.placement === 'tray'}
          onPress={() => onMove('tray')}
        />
        <PlaceChip
          icon={icons.hidden}
          on={action.placement === 'hidden'}
          onPress={() => onMove('hidden')}
        />
      </View>
    </View>
  )
}

function PlaceChip({
  icon,
  on,
  disabled,
  onPress,
}: {
  icon: (typeof icons)[keyof typeof icons]
  on: boolean
  disabled?: boolean
  onPress: () => void
}) {
  return (
    <Touchable
      style={[styles.placeChip, on && styles.placeChipOn, disabled && { opacity: 0.3 }]}
      onPress={disabled ? undefined : onPress}
    >
      <Icon name={icon} size={16} color={on ? colors.onAccent : colors.textMuted} />
    </Touchable>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  headerBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: { padding: spacing.lg, paddingBottom: 140, gap: spacing.xl },
  iconOnlyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xs,
  },
  group: {
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    overflow: 'hidden',
  },
  emptyGroup: {
    padding: spacing.lg,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    borderStyle: 'dashed',
    alignItems: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.hairline },
  arrows: { flexDirection: 'row', gap: 2 },
  arrowBtn: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
  placeChips: { flexDirection: 'row', gap: 4 },
  placeChip: {
    width: 34,
    height: 30,
    borderRadius: radius.row,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeChipOn: { backgroundColor: colors.accent },
})
