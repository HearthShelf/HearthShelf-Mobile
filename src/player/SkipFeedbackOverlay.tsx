/**
 * Visual feedback for relative skips (rewind / forward). When the user skips,
 * an overlay dims the cover art and a large signed amount blooms out from the
 * center ("+30", "-15"). Skipping again before the overlay fades accumulates
 * the total ("+30" -> "+1:00" -> "+1:30"...) and restarts the fade, so a rapid
 * flurry of taps reads as one running total rather than a stutter of numbers.
 *
 * Rendered as an absolute fill over the cover; drive it through the ref's
 * `bump(dir, seconds)`. Direction is inferred from the accumulated sign, so
 * skipping the opposite way while a total is showing resets rather than adds.
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { icons } from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { radius } from '@/ui/theme'

export type SkipFeedbackHandle = {
  /** Register a skip of `seconds` (always positive) in direction `dir`. */
  bump: (dir: -1 | 1, seconds: number) => void
}

/** "+30" under a minute, "+1:30" / "-2:00" at or above it. */
function formatDelta(totalSeconds: number): string {
  const sign = totalSeconds < 0 ? '-' : '+'
  const abs = Math.abs(totalSeconds)
  if (abs < 60) return `${sign}${abs}`
  const m = Math.floor(abs / 60)
  const s = abs % 60
  return `${sign}${m}:${String(s).padStart(2, '0')}`
}

// How long the overlay lingers after the last tap before fading out.
const LINGER_MS = 900
const FADE_OUT_MS = 260
const BLOOM_MS = 220

export const SkipFeedbackOverlay = forwardRef<SkipFeedbackHandle, unknown>((_props, ref) => {
  const [total, setTotal] = useState(0)
  const [dir, setDir] = useState<-1 | 1>(1)
  // Overlay visibility/dim (0 hidden, 1 shown) and the number's bloom scale.
  const opacity = useSharedValue(0)
  const scale = useSharedValue(0)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Live accumulator kept in a ref so back-to-back taps read the latest total
  // without waiting for a state flush.
  const acc = useRef(0)

  useImperativeHandle(
    ref,
    () => ({
      bump(d: -1 | 1, seconds: number) {
        // Opposite-direction tap while a total is up: start fresh from this tap.
        const restarting = acc.current === 0 || Math.sign(acc.current) !== d
        acc.current = restarting ? d * seconds : acc.current + d * seconds
        setDir(d)
        setTotal(acc.current)

        if (clearTimer.current) clearTimeout(clearTimer.current)
        cancelAnimation(opacity)
        cancelAnimation(scale)

        if (restarting) {
          // First tap: bloom the number out from the center.
          opacity.value = withTiming(1, { duration: 120 })
          scale.value = 0.2
          scale.value = withTiming(1, {
            duration: BLOOM_MS,
            easing: Easing.out(Easing.back(1.6)),
          })
        } else {
          // Subsequent taps: a quick pop to acknowledge the added time.
          opacity.value = 1
          scale.value = 0.86
          scale.value = withTiming(1, { duration: 140, easing: Easing.out(Easing.quad) })
        }

        clearTimer.current = setTimeout(() => {
          acc.current = 0
          opacity.value = withTiming(0, { duration: FADE_OUT_MS, easing: Easing.in(Easing.quad) })
          scale.value = withTiming(0.6, { duration: FADE_OUT_MS }, (finished) => {
            if (finished) runOnJS(setTotal)(0)
          })
        }, LINGER_MS)
      },
    }),
    [opacity, scale],
  )

  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current)
    },
    [],
  )

  const scrimStyle = useAnimatedStyle(() => ({ opacity: opacity.value }))
  const numStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ scale: scale.value }],
  }))

  if (total === 0) return null

  return (
    <View pointerEvents="none" style={styles.fill}>
      <Animated.View style={[styles.scrim, scrimStyle]} />
      <Animated.View style={[styles.badge, numStyle]}>
        <Icon name={dir < 0 ? icons.rewind : icons.forward} size={40} color="#fff" />
        <Text allowFontScaling={false} style={styles.number}>
          {formatDelta(total)}
        </Text>
      </Animated.View>
    </View>
  )
})

SkipFeedbackOverlay.displayName = 'SkipFeedbackOverlay'

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2,
  },
  scrim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: radius.card,
  },
  badge: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  number: {
    color: '#fff',
    fontSize: 76,
    fontWeight: '800',
    lineHeight: 84,
    marginTop: 4,
    textShadowColor: 'rgba(0,0,0,0.4)',
    textShadowOffset: { width: 0, height: 2 },
    textShadowRadius: 8,
  },
})
