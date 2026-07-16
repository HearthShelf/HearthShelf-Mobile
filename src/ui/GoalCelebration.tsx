/**
 * Yearly reading-goal celebration - the app's loudest moment. A single host
 * (<GoalCelebrationHost>) mounted once at the root layout, fired from anywhere via
 * `celebrateGoal({ goal, done })` (module-level store, same shape as the toast
 * host). No dimming scrim: it drops an endless rainbow confetti downpour over the
 * live screen and floats a giant RGB-cycling "65 Books!" card whose text AND
 * border ripple through the full color spectrum for as long as it's up. Tap
 * anywhere to dismiss.
 *
 * The trigger decision (has the user hit the goal, and haven't we already
 * celebrated this exact goal number) lives in lib/goalCelebration.ts; this file
 * only renders. A "Raise the bar" button lets the user bump their goal on the
 * spot, which - because the celebrated-goal flag is keyed to the goal number -
 * re-arms the celebration for the new, higher target.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { Dimensions, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { haptics } from './haptics'
import { MAX_FONT_SCALE, radius, spacing, fonts, type Palette } from './theme'
import { useColors } from './ThemeProvider'

export interface GoalCelebration {
  /** The goal the user just reached (books this year). */
  goal: number
  /** How many books they've actually finished this year. */
  done: number
  /** Bump the goal (drives the "Raise the bar" button). */
  onRaise?: (nextGoal: number) => void
}

// --- global store: one celebration at a time ---
let current: GoalCelebration | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Raise the goal celebration from anywhere (launch check, diagnostics test). */
export function celebrateGoal(c: GoalCelebration): void {
  current = c
  emit()
}

/** Tear the celebration down (tap-to-dismiss, or after the user raises the bar). */
function dismissCelebration(): void {
  current = null
  emit()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function getState(): GoalCelebration | null {
  return current
}

// How many books "Raise the bar" adds to the current goal.
const RAISE_STEP = 5

// The full RGB spectrum, looped so text/border can ripple continuously. The last
// stop repeats the first so the wrap-around has no seam.
const SPECTRUM = [
  '#ff0040',
  '#ff8000',
  '#ffe000',
  '#40ff00',
  '#00ffcc',
  '#0080ff',
  '#8000ff',
  '#ff00c0',
  '#ff0040',
]
const SPECTRUM_INPUT = SPECTRUM.map((_, i) => i / (SPECTRUM.length - 1))

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window')
// Confetti count - a genuine downpour, not a polite sprinkle.
const CONFETTI_COUNT = 90

interface ConfettiSpec {
  x: number // start x (px)
  size: number // side length (px)
  color: string
  fallMs: number // time to cross the screen once
  delayMs: number // initial stagger so the stream isn't a synchronized wall
  drift: number // horizontal sway amplitude (px)
  spin: number // full rotations per fall
  round: boolean // circle vs square piece
}

/**
 * One confetti piece: falls from above the top edge to below the bottom, looping
 * forever, swaying and spinning as it goes. Each piece owns its own driver so the
 * stream is continuous and desynchronized.
 */
function Confetti({ spec }: { spec: ConfettiSpec }) {
  const t = useSharedValue(0)

  useEffect(() => {
    t.value = 0
    t.value = withDelay(
      spec.delayMs,
      withRepeat(withTiming(1, { duration: spec.fallMs, easing: Easing.linear }), -1, false),
    )
    return () => cancelAnimation(t)
  }, [t, spec.delayMs, spec.fallMs])

  const style = useAnimatedStyle(() => {
    const fall = interpolate(t.value, [0, 1], [-40, SCREEN_H + 40])
    const sway = Math.sin(t.value * Math.PI * 4) * spec.drift
    const rot = t.value * 360 * spec.spin
    return {
      transform: [{ translateY: fall }, { translateX: sway }, { rotateZ: `${rot}deg` }],
    }
  })

  return (
    <Animated.View
      style={[
        {
          position: 'absolute',
          top: 0,
          left: spec.x,
          width: spec.size,
          height: spec.size,
          borderRadius: spec.round ? spec.size / 2 : 2,
          backgroundColor: spec.color,
        },
        style,
      ]}
    />
  )
}

/** Mounted once at the root layout, above every screen and the mini player. */
export function GoalCelebrationHost() {
  const state = useSyncExternalStore(subscribe, getState)
  const insets = useSafeAreaInsets()
  const colors = useColors()
  const styles = makeStyles(colors)

  // Card entrance pop + a forever-looping hue driver for the RGB text/border.
  const pop = useSharedValue(0)
  const hue = useSharedValue(0)

  // Fresh confetti field each time a celebration opens (new random spread).
  const confetti = useMemo<ConfettiSpec[]>(() => {
    // `state` in deps so a re-fire (diagnostics) reshuffles the field.
    void state
    return Array.from({ length: CONFETTI_COUNT }, () => ({
      x: Math.random() * SCREEN_W,
      size: 7 + Math.random() * 9,
      color: SPECTRUM[Math.floor(Math.random() * (SPECTRUM.length - 1))],
      fallMs: 1600 + Math.random() * 1800,
      delayMs: Math.random() * 2400,
      drift: 12 + Math.random() * 40,
      spin: 1 + Math.random() * 3,
      round: Math.random() < 0.4,
    }))
  }, [state])

  useEffect(() => {
    if (!state) {
      pop.value = 0
      cancelAnimation(hue)
      return
    }
    haptics.success()
    pop.value = withDelay(60, withSpring(1, { damping: 8, stiffness: 150, mass: 0.7 }))
    hue.value = 0
    hue.value = withRepeat(withTiming(1, { duration: 1400, easing: Easing.linear }), -1, false)
    return () => cancelAnimation(hue)
  }, [state, pop, hue])

  const cardStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pop.value, [0, 0.3, 1], [0, 1, 1]),
    transform: [{ scale: 0.6 + pop.value * 0.4 }, { rotateZ: `${(1 - pop.value) * -6}deg` }],
    borderColor: interpolateColor(hue.value, SPECTRUM_INPUT, SPECTRUM),
  }))

  // Text hue offset a third of the way round the wheel so it never matches the
  // border - the two chase each other through the spectrum.
  const textStyle = useAnimatedStyle(() => ({
    color: interpolateColor((hue.value + 0.33) % 1, SPECTRUM_INPUT, SPECTRUM),
  }))
  const kickerStyle = useAnimatedStyle(() => ({
    color: interpolateColor((hue.value + 0.66) % 1, SPECTRUM_INPUT, SPECTRUM),
  }))

  const handleRaise = useCallback(() => {
    if (!state) return
    haptics.confirm()
    state.onRaise?.(state.goal + RAISE_STEP)
    dismissCelebration()
  }, [state])

  if (!state) return null

  const done = state.done
  const goal = state.goal
  // Headline number: what they actually finished, the bragging figure.
  const bragCount = Math.max(done, goal)

  return (
    <Pressable style={styles.fill} onPress={dismissCelebration}>
      {/* Endless rainbow downpour over the live screen (no dimming layer). */}
      <View style={styles.fill} pointerEvents="none">
        {confetti.map((spec, i) => (
          <Confetti key={i} spec={spec} />
        ))}
      </View>

      <View style={[styles.center, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Animated.View style={[styles.card, cardStyle]}>
          <Animated.Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.kicker, kickerStyle]}>
            READING GOAL SMASHED
          </Animated.Text>
          <Animated.Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.brag, textStyle]}>
            {bragCount} {bragCount === 1 ? 'Book' : 'Books'}!
          </Animated.Text>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.body}>
            {done > goal
              ? `${done - goal} past your goal of ${goal} this year.`
              : `You hit your goal of ${goal} this year.`}
          </Text>

          <View style={styles.actions}>
            <Pressable
              onPress={handleRaise}
              style={({ pressed }) => [styles.raiseBtn, pressed && styles.pressed]}
            >
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.raiseText}>
                Raise the bar to {goal + RAISE_STEP}
              </Text>
            </Pressable>
            <Pressable
              onPress={dismissCelebration}
              hitSlop={8}
              style={({ pressed }) => [styles.dismissBtn, pressed && styles.pressed]}
            >
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.dismissText}>
                Nice
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      </View>
    </Pressable>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    center: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.xl,
    },
    card: {
      width: '100%',
      maxWidth: 380,
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xl,
      paddingHorizontal: spacing.lg,
      borderRadius: radius.card,
      backgroundColor: colors.elevated,
      borderWidth: 4,
    },
    kicker: {
      fontSize: 13,
      fontWeight: '900',
      letterSpacing: 2,
    },
    brag: {
      fontFamily: fonts.mono,
      fontSize: 60,
      fontWeight: '900',
      letterSpacing: -1,
      marginVertical: spacing.xs,
      textAlign: 'center',
    },
    body: {
      color: colors.textMuted,
      fontSize: 15,
      lineHeight: 21,
      textAlign: 'center',
      marginBottom: spacing.sm,
    },
    actions: {
      alignSelf: 'stretch',
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    raiseBtn: {
      alignItems: 'center',
      paddingVertical: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    raiseText: { color: colors.scaffold, fontSize: 15, fontWeight: '700' },
    dismissBtn: {
      alignItems: 'center',
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
    },
    dismissText: { color: colors.textMuted, fontSize: 14, fontWeight: '600' },
    pressed: { opacity: 0.7 },
  })
