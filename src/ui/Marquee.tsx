/**
 * Horizontal marquee for a single line of text that would otherwise truncate.
 * When the content is wider than its container it scrolls left at a steady pace
 * after a short hold, loops with a gap, and fades at both edges. When it fits,
 * it renders as plain centered text with no animation. Honors Reduce Motion by
 * falling back to a truncated static line.
 *
 * Used for the player's title/author line and the scrubber's chapter label -
 * both places where a long string must stay fully readable without wrapping or
 * stealing vertical space (the player's one-row layout law).
 */
import { useEffect, useState } from 'react'
import {
  type LayoutChangeEvent,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native'
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'

const SPEED = 24 // px/s
const HOLD_MS = 1200
const GAP = 48 // px between the loop's tail and its repeat

export function Marquee({
  children,
  style,
  align = 'center',
}: {
  /** A single Text (or row of Texts) to scroll. Must render on one line. */
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
  /** How to place the content when it fits without scrolling. */
  align?: 'center' | 'flex-start'
}) {
  const [containerW, setContainerW] = useState(0)
  const [contentW, setContentW] = useState(0)
  const reduceMotion = useReducedMotion()
  const x = useSharedValue(0)

  const overflowing = contentW > 0 && containerW > 0 && contentW > containerW + 1
  const scrolls = overflowing && !reduceMotion

  useEffect(() => {
    if (!scrolls) {
      cancelAnimation(x)
      x.value = 0
      return
    }
    const distance = contentW + GAP
    const durationMs = (distance / SPEED) * 1000
    x.value = 0
    x.value = withDelay(
      HOLD_MS,
      withRepeat(withTiming(-distance, { duration: durationMs, easing: Easing.linear }), -1, false),
    )
    return () => cancelAnimation(x)
  }, [scrolls, contentW, x])

  const trackStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }))

  const onContainer = (e: LayoutChangeEvent) => setContainerW(e.nativeEvent.layout.width)
  const onContent = (e: LayoutChangeEvent) => setContentW(e.nativeEvent.layout.width)

  return (
    <View style={[styles.wrap, style]} onLayout={onContainer}>
      {scrolls ? (
        <Animated.View style={[styles.track, trackStyle]}>
          <View onLayout={onContent}>{children}</View>
          {/* Trailing copy so the loop reads continuous. */}
          <View style={{ marginLeft: GAP }}>{children}</View>
        </Animated.View>
      ) : (
        <View style={{ flexDirection: 'row', justifyContent: align, width: '100%' }}>
          <View onLayout={onContent}>{children}</View>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', width: '100%' },
  track: { flexDirection: 'row', alignItems: 'center' },
})
