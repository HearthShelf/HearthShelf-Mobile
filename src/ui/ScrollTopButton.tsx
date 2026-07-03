/**
 * Contextual "scroll to top" pill for long lists. Hidden until the list has
 * scrolled past a threshold, then fades + slides up into view centered above the
 * mini player; fades back out on the way up. A transient tool, not permanent
 * chrome - so it stays out of the way until you're deep enough to want it.
 *
 * The caller owns the list ref and feeds `visible` (usually gated on scroll
 * offset AND not-in-selection-mode). This component only handles the show/hide
 * motion and its own press feedback, drawing from the app's motion vocabulary.
 */
import { StyleSheet } from 'react-native'
import Animated, { useAnimatedStyle, useSharedValue, withTiming, Easing } from 'react-native-reanimated'
import { useEffect } from 'react'
import { SpringPressable, DUR } from './motion'
import { useTheme } from './ThemeProvider'
import { Icon, icons } from './icons'
import { radius } from './theme'

export function ScrollTopButton({
  visible,
  onPress,
  bottom,
}: {
  visible: boolean
  onPress: () => void
  /** Distance from the list's bottom edge, so it clears the mini player. */
  bottom: number
}) {
  const { colors, shadow } = useTheme()
  // 0 = hidden (faded + nudged down), 1 = shown. One driver for both props keeps
  // the fade and slide locked together.
  const t = useSharedValue(visible ? 1 : 0)

  useEffect(() => {
    t.value = withTiming(visible ? 1 : 0, {
      duration: DUR.base,
      easing: Easing.out(Easing.cubic),
    })
  }, [visible, t])

  const animated = useAnimatedStyle(() => ({
    opacity: t.value,
    transform: [{ translateY: (1 - t.value) * 12 }],
  }))

  return (
    // `visible` gates hit-testing so a faded-out button can't swallow taps;
    // box-none lets touches through the centered row to the list behind it.
    <Animated.View
      style={[styles.wrap, { bottom }, animated]}
      pointerEvents={visible ? 'box-none' : 'none'}
    >
      <SpringPressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel="Scroll to top"
        style={[styles.pill, { backgroundColor: colors.accent }, shadow.accentLift]}
      >
        <Icon name={icons.arrowUpward} size={22} color={colors.onAccent} />
      </SpringPressable>
    </Animated.View>
  )
}

const SIZE = 44

const styles = StyleSheet.create({
  // Centered across the list's width; the row itself passes touches through
  // (box-none) so only the pill is interactive.
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  pill: {
    width: SIZE,
    height: SIZE,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
