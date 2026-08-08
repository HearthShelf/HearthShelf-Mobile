/**
 * Swipe-to-reveal row actions.
 *
 * Wraps a row in a right-swipe panel exposing one or more buttons. Built on
 * gesture-handler's ReanimatedSwipeable (the Reanimated rewrite - the older
 * `Swipeable` is deprecated), which owns the drag, the open/close springs and
 * the release threshold.
 *
 * The actions here mirror whatever the row already offers by long press rather
 * than replacing it: swipe is the discoverable shortcut, long press stays the
 * accessible path (a swipe target is invisible to a screen reader, so removing
 * the long press would strand those users).
 *
 * The panel is laid out at a fixed width and revealed by translating it in from
 * the right edge, so buttons keep their size instead of stretching with the
 * drag. Dragging past the panel width keeps pulling the row (friction handles
 * the rubber-band) but the buttons stay put.
 */
import { useCallback, useMemo, useRef } from 'react'
import { StyleSheet } from 'react-native'
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated'
import ReanimatedSwipeable, {
  type SwipeableMethods,
} from 'react-native-gesture-handler/ReanimatedSwipeable'
import { AppText, Touchable } from './primitives'
import { Icon, type IconName } from './icons'
import { haptics } from './haptics'
import { spacing, type Palette } from './theme'
import { useColors } from './ThemeProvider'

/** Width of one action button. Two of these is a comfortable reveal that still
 *  leaves most of the row readable while open. */
const ACTION_WIDTH = 76

/**
 * Button tint. Presentation only - a `destructive` tone does not add a
 * confirmation step, the caller still owns that.
 *   neutral     - plain fill, for actions that need no signal
 *   affirmative - muted green, for a safe/constructive action (edit, save)
 *   destructive - red, for one that removes something
 */
export type SwipeActionTone = 'neutral' | 'affirmative' | 'destructive'

export interface SwipeAction {
  key: string
  label: string
  icon: IconName
  onPress: () => void
  tone?: SwipeActionTone
}

export function SwipeableRow({
  actions,
  children,
  /** Renders the row bare, without the gesture wrapper. For a list that turns
   *  swiping off wholesale; an empty `actions` does the same thing. */
  enabled = true,
}: {
  actions: SwipeAction[]
  children: React.ReactNode
  enabled?: boolean
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const ref = useRef<SwipeableMethods>(null)

  const panelWidth = actions.length * ACTION_WIDTH

  const renderRightActions = useCallback(
    (_progress: SharedValue<number>, translation: SharedValue<number>) => (
      <ActionPanel
        actions={actions}
        translation={translation}
        panelWidth={panelWidth}
        styles={styles}
        colors={colors}
        onRun={(run) => {
          // Close first so the row is settled before a sheet or alert takes
          // over; leaving it open behind a modal reads as a stuck row.
          ref.current?.close()
          run()
        }}
      />
    ),
    [actions, panelWidth, styles, colors],
  )

  if (!enabled || actions.length === 0) return <>{children}</>

  return (
    <ReanimatedSwipeable
      ref={ref}
      friction={2}
      rightThreshold={ACTION_WIDTH / 2}
      overshootRight={false}
      renderRightActions={renderRightActions}
      onSwipeableWillOpen={() => haptics.select()}
    >
      {children}
    </ReanimatedSwipeable>
  )
}

/**
 * The revealed buttons. `translation` is negative while swiping left; the panel
 * is parked just off the right edge and slid in by that amount, clamped to its
 * own width so an over-drag doesn't tear it away from the row.
 */
function ActionPanel({
  actions,
  translation,
  panelWidth,
  styles,
  colors,
  onRun,
}: {
  actions: SwipeAction[]
  translation: SharedValue<number>
  panelWidth: number
  styles: ReturnType<typeof makeStyles>
  colors: Palette
  onRun: (run: () => void) => void
}) {
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: Math.max(translation.value, -panelWidth) + panelWidth }],
  }))

  return (
    <Animated.View style={[styles.panel, { width: panelWidth }, style]}>
      {actions.map((action) => {
        const tone = action.tone ?? 'neutral'
        // Tinted buttons carry a solid fill, so their content flips to the
        // on-accent ink; the neutral fill is subtle enough to keep body text.
        const ink = tone === 'neutral' ? colors.text : colors.onAccent
        return (
          <Touchable
            key={action.key}
            onPress={() => onRun(action.onPress)}
            style={[styles.action, styles[tone]]}
            accessibilityRole="button"
            accessibilityLabel={action.label}
          >
            <Icon name={action.icon} size={20} color={ink} />
            <AppText variant="caption" color={ink} numberOfLines={1}>
              {action.label}
            </AppText>
          </Touchable>
        )
      })}
    </Animated.View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    panel: { flexDirection: 'row' },
    action: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
    },
    neutral: { backgroundColor: colors.fill },
    affirmative: { backgroundColor: colors.success },
    destructive: { backgroundColor: colors.destructive },
  })
