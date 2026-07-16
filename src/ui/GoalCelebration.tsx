/**
 * Yearly reading-goal celebration - the app's loudest moment. A single host
 * (<GoalCelebrationHost>) mounted once at the root layout, fired from anywhere via
 * `celebrateGoal({ goal, done })` (module-level store, same shape as the toast
 * host). No dimming scrim: it drops a heavy rainbow confetti downpour over the
 * live screen and floats a giant glowing "65 Books!" card. The card's border is a
 * true chasing rainbow ring (distinct colors around the edge that rotate around
 * the perimeter), and a soft RGB bloom + cycling text-glow sits behind the number.
 * The bigger the goal, the denser the confetti - hit a huge number, get a
 * downpour. Tap anywhere to dismiss.
 *
 * The trigger decision (has the user hit the goal, and haven't we already
 * celebrated this exact goal number) lives in lib/goalCelebration.ts; this file
 * only renders. A "Raise the bar" button lets the user bump their goal on the
 * spot, which - because the celebrated-goal flag is keyed to the goal number -
 * re-arms the celebration for the new, higher target.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Dimensions, Pressable, StyleSheet, Text, View, type LayoutRectangle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LinearGradient } from 'expo-linear-gradient'
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

// The full RGB spectrum, looped so the text/glow can ripple continuously. The
// last stop repeats the first so the wrap-around has no seam.
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
// The rainbow ring wheel: distinct hues placed around a disc that we rotate, so a
// different color sits on each edge/corner and they chase around the perimeter.
const WHEEL = ['#ff0040', '#ff8000', '#ffe000', '#40ff00', '#00ffcc', '#0080ff', '#8000ff', '#ff00c0']
// The two crossed rainbow gradients that make the spinning ring, as fixed tuples
// (expo-linear-gradient wants a non-empty color tuple).
const RING_A = ['#ff0040', '#ff8000', '#ffe000', '#40ff00', '#00ffcc', '#0080ff', '#8000ff', '#ff00c0', '#ff0040'] as const
const RING_B = ['#00ffcc', '#0080ff', '#8000ff', '#ff00c0', '#ff0040', '#ff8000', '#ffe000', '#40ff00'] as const

const BORDER = 5 // ring thickness (px)
const RING_RADIUS = radius.card + BORDER

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window')

// Confetti scales with the goal: a modest goal still rains, a big one pours. The
// higher you climb, the more you get.
function confettiCountForGoal(goal: number): number {
  return Math.round(Math.max(80, Math.min(320, 80 + goal * 3)))
}

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

/**
 * A chasing rainbow ring behind the card. A rainbow-filled disc, sized to cover
 * the card, spins continuously; the card body sits on top and masks all but a
 * `BORDER`-thick frame, so what shows is a rotating rainbow border where each edge
 * carries a different hue that chases around the perimeter.
 */
function RainbowRing({ frame }: { frame: LayoutRectangle }) {
  const spin = useSharedValue(0)
  useEffect(() => {
    spin.value = 0
    spin.value = withRepeat(withTiming(1, { duration: 3200, easing: Easing.linear }), -1, false)
    return () => cancelAnimation(spin)
  }, [spin])

  // The disc must fully cover the card at any rotation, so its side = the card's
  // diagonal. Two crossed gradients give color on all four edges at once.
  const diag = Math.ceil(Math.hypot(frame.width + BORDER * 2, frame.height + BORDER * 2))
  const style = useAnimatedStyle(() => ({
    transform: [{ rotateZ: `${spin.value * 360}deg` }],
  }))

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left: -BORDER,
        top: -BORDER,
        width: frame.width + BORDER * 2,
        height: frame.height + BORDER * 2,
        borderRadius: RING_RADIUS,
        overflow: 'hidden',
      }}
    >
      <Animated.View
        style={[
          {
            position: 'absolute',
            width: diag,
            height: diag,
            left: (frame.width + BORDER * 2 - diag) / 2,
            top: (frame.height + BORDER * 2 - diag) / 2,
          },
          style,
        ]}
      >
        <LinearGradient
          colors={RING_A}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
        <LinearGradient
          colors={RING_B}
          start={{ x: 1, y: 0 }}
          end={{ x: 0, y: 1 }}
          style={[StyleSheet.absoluteFill, { opacity: 0.6 }]}
        />
      </Animated.View>
    </View>
  )
}

/** Mounted once at the root layout, above every screen and the mini player. */
export function GoalCelebrationHost() {
  const state = useSyncExternalStore(subscribe, getState)
  const insets = useSafeAreaInsets()
  const colors = useColors()
  const styles = makeStyles(colors)

  // Card entrance pop + a forever-looping hue driver for the RGB text/glow.
  const pop = useSharedValue(0)
  const hue = useSharedValue(0)
  // Card frame, measured on layout, to size the rainbow ring behind it.
  const [frame, setFrame] = useState<LayoutRectangle | null>(null)

  const goal = state?.goal ?? 0
  // Fresh confetti field each time a celebration opens (density scales w/ goal).
  const confetti = useMemo<ConfettiSpec[]>(() => {
    void state
    const count = confettiCountForGoal(goal)
    return Array.from({ length: count }, () => {
      // Perspective: pieces starting lower read as "closer" - bigger and faster.
      const depth = Math.random()
      return {
        x: Math.random() * SCREEN_W,
        size: 6 + depth * 14,
        color: WHEEL[Math.floor(Math.random() * WHEEL.length)],
        fallMs: 2600 - depth * 1400 + Math.random() * 400,
        delayMs: Math.random() * 2600,
        drift: 12 + Math.random() * 46,
        spin: 1 + Math.random() * 3,
        round: Math.random() < 0.4,
      }
    })
  }, [state, goal])

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
  }))

  // The big number: cycles color AND carries a fat same-color glow (text-shadow).
  const bragStyle = useAnimatedStyle(() => {
    const c = interpolateColor(hue.value, SPECTRUM_INPUT, SPECTRUM)
    return { color: c, textShadowColor: c }
  })
  const kickerStyle = useAnimatedStyle(() => ({
    color: interpolateColor((hue.value + 0.5) % 1, SPECTRUM_INPUT, SPECTRUM),
  }))
  // Radial-ish bloom behind the number, tinted with the current hue.
  const bloomStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(hue.value, SPECTRUM_INPUT, SPECTRUM),
  }))

  const handleRaise = useCallback(() => {
    if (!state) return
    haptics.confirm()
    state.onRaise?.(state.goal + RAISE_STEP)
    dismissCelebration()
  }, [state])

  if (!state) return null

  const done = state.done
  // Headline number: what they actually finished, the bragging figure.
  const bragCount = Math.max(done, goal)

  return (
    <Pressable style={styles.fill} onPress={dismissCelebration}>
      {/* Heavy rainbow downpour over the live screen (no dimming layer). */}
      <View style={styles.fill} pointerEvents="none">
        {confetti.map((spec, i) => (
          <Confetti key={i} spec={spec} />
        ))}
      </View>

      <View style={[styles.center, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Animated.View style={cardStyle}>
          <View onLayout={(e) => setFrame(e.nativeEvent.layout)} style={styles.card}>
            {frame ? <RainbowRing frame={frame} /> : null}

            <Animated.Text
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              style={[styles.kicker, kickerStyle]}
            >
              READING GOAL SMASHED
            </Animated.Text>

            {/* Glow bloom sits behind the number. */}
            <View style={styles.bragWrap}>
              <Animated.View style={[styles.bloom, bloomStyle]} pointerEvents="none" />
              <Animated.Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={[styles.brag, bragStyle]}>
                {bragCount} {bragCount === 1 ? 'Book' : 'Books'}!
              </Animated.Text>
            </View>

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
    },
    kicker: {
      fontSize: 13,
      fontWeight: '900',
      letterSpacing: 2,
    },
    bragWrap: {
      alignItems: 'center',
      justifyContent: 'center',
      marginVertical: spacing.xs,
    },
    bloom: {
      position: 'absolute',
      width: 220,
      height: 120,
      borderRadius: 110,
      opacity: 0.5,
    },
    brag: {
      fontFamily: fonts.mono,
      fontSize: 64,
      fontWeight: '900',
      letterSpacing: -1,
      textAlign: 'center',
      textShadowOffset: { width: 0, height: 0 },
      textShadowRadius: 22,
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
