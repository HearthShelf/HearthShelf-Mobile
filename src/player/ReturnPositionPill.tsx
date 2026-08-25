/**
 * The "Jump to furthest" pill that appears over the artwork after a large
 * backwards seek. Tap returns to the spot playback had reached; a horizontal
 * swipe throws that spot away instead.
 *
 * Dismissal exists because the furthest point is not always a place worth going
 * back to - falling asleep with no sleep timer running leaves it hours ahead of
 * anything actually heard. Swiping the pill away makes the current spot the
 * furthest one again.
 */
import { StyleSheet } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  FadeIn,
  FadeOut,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { formatTimestamp } from '@hearthshelf/core'
import { AppText, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { useTheme } from '@/ui/ThemeProvider'
import { haptics } from '@/ui/haptics'
import { DUR, POP_SPRING, useReducedMotion } from '@/ui/motion'
import { radius, spacing, withAlpha } from '@/ui/theme'
import { dismissReturnPosition, jumpToReturnPosition } from './store'

/** How far the pill must travel (or how hard it must be flung) to be dismissed. */
const DISMISS_PX = 72
const DISMISS_VELOCITY = 600

export function ReturnPositionPill({ position }: { position: number }) {
  const { colors } = useTheme()
  const reduceMotion = useReducedMotion()
  const x = useSharedValue(0)

  const dismiss = (direction: -1 | 1) => {
    haptics.select()
    if (reduceMotion) {
      dismissReturnPosition()
      return
    }
    // Let the pill finish leaving the screen before it unmounts, so the swipe
    // reads as throwing it away rather than as a tap that made it vanish.
    x.value = withTiming(direction * 400, { duration: DUR.fast })
    setTimeout(dismissReturnPosition, DUR.fast)
  }

  // Horizontal-only: the player's own vertical pans (immersive lift, drag
  // rejection) fail on horizontal movement, so the two never contend.
  const swipe = Gesture.Pan()
    .activeOffsetX([-12, 12])
    .failOffsetY([-14, 14])
    .onUpdate((e) => {
      x.value = e.translationX
    })
    .onEnd((e) => {
      if (Math.abs(e.translationX) > DISMISS_PX || Math.abs(e.velocityX) > DISMISS_VELOCITY) {
        runOnJS(dismiss)(e.translationX < 0 ? -1 : 1)
      } else {
        x.value = withSpring(0, POP_SPRING)
      }
    })

  // Fade with the drag so the pill visibly weakens as it approaches release.
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: x.value }],
    opacity: Math.max(0, 1 - Math.abs(x.value) / (DISMISS_PX * 2)),
  }))

  return (
    <GestureDetector gesture={swipe}>
      <Animated.View
        entering={reduceMotion ? undefined : FadeIn.duration(DUR.base)}
        exiting={reduceMotion ? undefined : FadeOut.duration(DUR.fast)}
        style={[styles.wrap, { backgroundColor: withAlpha(colors.accent, 0.94) }, style]}
      >
        <Touchable
          style={styles.tap}
          onPress={jumpToReturnPosition}
          accessibilityRole="button"
          accessibilityLabel={`Jump to furthest position, ${formatTimestamp(position)}`}
          accessibilityHint="Swipe the pill sideways to forget the furthest position"
        >
          <Icon name={icons.recent} size={15} color="#fff" />
          <AppText variant="caption" color="#fff" style={{ fontWeight: '700' }}>
            Jump to furthest
          </AppText>
        </Touchable>
      </Animated.View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 10,
    left: 56,
    right: 56,
    borderRadius: radius.pill,
    zIndex: 24,
  },
  tap: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
  },
})
