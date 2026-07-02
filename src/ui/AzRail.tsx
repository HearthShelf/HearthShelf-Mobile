/**
 * Vertical A-Z jump rail, pinned to the right edge (mobile-only affordance from
 * the web library). Press or drag anywhere in the rail column to jump the list to
 * the first item in that letter's bucket; a floating teardrop bubble previews the
 * current letter while the finger is down so you can drag up and down the
 * alphabet. Letters with no items are dimmed and skipped.
 *
 * Uses react-native-gesture-handler's Pan gesture (not RN's raw responder
 * system) so the touch coordinate stays relative to the rail view for the
 * entire gesture. RN's `locationY` re-targets to whichever child (letter Text)
 * is currently under the finger, which made the picked letter jump around once
 * the finger drifted off the initial touch column - `e.y` from the gesture
 * does not have that problem.
 */
import { useCallback, useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  Easing,
} from 'react-native-reanimated'
import { colors, fonts, radius, spacing } from './theme'
import { haptics } from './haptics'

const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')]
// Reversed rail (Z on top, # at bottom) for descending name sorts.
const LETTERS_DESC = [...LETTERS].reverse()
const BUBBLE = 64
const BUBBLE_RADIUS = BUBBLE / 2
// Width of the rotated-square tail that pokes out the circle's right edge,
// forming the teardrop's point toward the rail.
const TAIL = 14

export function AzRail({
  available,
  onJump,
  reversed = false,
}: {
  /** Set of letters that have at least one item. */
  available: Set<string>
  /** Called with the chosen letter when the finger lands on / drags over it. */
  onJump: (letter: string) => void
  /** Flip the rail so Z is on top - matches a descending (Z-first) list. */
  reversed?: boolean
}) {
  const letters = reversed ? LETTERS_DESC : LETTERS
  const railHeight = useRef(0)
  const lastLetter = useRef<string | null>(null)
  // The letter currently under the finger (drives the preview bubble + highlight).
  const [active, setActive] = useState<string | null>(null)
  // Y of the finger within the rail, so the bubble sits beside it (not centered).
  const bubbleY = useSharedValue(0)
  const bubbleScale = useSharedValue(0)

  const pick = useCallback(
    (letter: string, y: number) => {
      // bubbleY is the finger's Y; the tail (point) sits at the circle's
      // vertical center, so centering the circle on bubbleY lands the point on
      // the letter under the finger.
      bubbleY.value = y
      if (letter === lastLetter.current) return
      lastLetter.current = letter
      setActive(letter)
      // Tick each time the finger crosses into a new letter, so scrubbing the
      // rail feels like ratcheting through the alphabet.
      haptics.select()
      if (available.has(letter)) onJump(letter)
    },
    [available, onJump, bubbleY],
  )

  const begin = useCallback(() => {
    lastLetter.current = null
    bubbleScale.value = withSpring(1, { damping: 13, stiffness: 380, mass: 0.5 })
  }, [bubbleScale])

  const end = useCallback(() => {
    lastLetter.current = null
    // Fade the shape out first, then clear the letter once it's hidden - so the
    // glyph doesn't blink away while the bubble is still visibly shrinking.
    bubbleScale.value = withTiming(0, { duration: 90, easing: Easing.in(Easing.ease) }, () => {
      runOnJS(setActive)(null)
    })
  }, [bubbleScale])

  // Runs on the JS thread. e.y is relative to the rail view for the whole
  // gesture (unlike RN's responder locationY, which re-targets per child under
  // the finger), so map it straight onto the letter list.
  const sample = useCallback(
    (y: number) => {
      const height = railHeight.current
      if (height <= 0) return
      const clamped = Math.max(0, Math.min(height, y))
      const idx = Math.min(letters.length - 1, Math.floor((clamped / height) * letters.length))
      pick(letters[idx], clamped)
    },
    [pick, letters],
  )

  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => {
      runOnJS(begin)()
      runOnJS(sample)(e.y)
    })
    .onUpdate((e) => runOnJS(sample)(e.y))
    .onEnd(() => runOnJS(end)())
    .onFinalize((_e, success) => {
      if (!success) runOnJS(end)()
    })

  const bubbleStyle = useAnimatedStyle(() => ({
    top: bubbleY.value - BUBBLE / 2,
    transform: [{ scale: bubbleScale.value }],
  }))

  return (
    <View style={styles.zone} pointerEvents="box-none">
      <Animated.View style={[styles.bubbleWrap, bubbleStyle]} pointerEvents="none">
        {/* Rotated square tucked behind the circle's right edge, pointing at
            the rail - the classic map-pin teardrop, laid on its side. */}
        <View style={styles.bubbleTail} />
        <View style={styles.bubble}>
          <Text style={styles.bubbleText}>{active}</Text>
        </View>
      </Animated.View>
      <GestureDetector gesture={pan}>
        <View
          style={styles.rail}
          onLayout={(e) => {
            railHeight.current = e.nativeEvent.layout.height
          }}
        >
          {letters.map((l) => (
            <Text
              key={l}
              style={[
                styles.letter,
                !available.has(l) && styles.letterEmpty,
                active === l && available.has(l) && styles.letterActive,
              ]}
            >
              {l}
            </Text>
          ))}
        </View>
      </GestureDetector>
    </View>
  )
}

/** Width the rail reserves on the right edge; the grid pads by this so covers
 *  never sit under the letters. */
export const AZ_RAIL_WIDTH = 28

const styles = StyleSheet.create({
  // Anchored strip down the right edge. The generous bottom inset keeps the rail
  // clear of the floating mini-player that docks over the list's lower edge, and
  // a matching top inset keeps the shortened rail vertically centered.
  zone: {
    position: 'absolute',
    right: 0,
    top: 24,
    bottom: 96,
    width: AZ_RAIL_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The touch target: a full-height column wide enough to hit comfortably.
  rail: {
    flex: 1,
    width: AZ_RAIL_WIDTH,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.fillStrong,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  letter: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
    fontFamily: fonts.mono,
    color: colors.textMuted,
  },
  letterEmpty: { color: colors.textFaint, opacity: 0.35 },
  letterActive: { color: colors.accent, fontWeight: '800' },
  // Positioned + scaled as a unit; `top` tracks the finger (set via animated
  // style) and the whole thing pops in/out with bubbleScale.
  bubbleWrap: {
    position: 'absolute',
    right: AZ_RAIL_WIDTH + spacing.sm,
    width: BUBBLE,
    height: BUBBLE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Small rotated square centered on the circle's right edge, same color, so
  // together they read as one sideways teardrop with its point toward the
  // rail (the classic map-pin shape, laid on its side). Half tucked under the
  // circle, half poking out - the circle is drawn after it, on top.
  bubbleTail: {
    position: 'absolute',
    top: '50%',
    left: BUBBLE - TAIL / 2,
    width: TAIL,
    height: TAIL,
    marginTop: -TAIL / 2,
    borderRadius: 3,
    backgroundColor: colors.accent,
    transform: [{ rotate: '45deg' }],
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 7,
  },
  bubble: {
    width: BUBBLE,
    height: BUBBLE,
    borderRadius: BUBBLE_RADIUS,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  bubbleText: {
    fontSize: 30,
    fontWeight: '800',
    fontFamily: fonts.mono,
    color: colors.onAccent,
  },
})
