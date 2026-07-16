/**
 * Yearly reading-goal celebration - the app's loudest moment. A single host
 * (<GoalCelebrationHost>) mounted once at the root layout, fired from anywhere via
 * `celebrateGoal({ goal, done })` (module-level store, same shape as the toast
 * host). No dimming scrim: a heavy cut-paper confetti downpour falls over the live
 * screen and a dark "glass" card floats in the middle. The card is backlit by a
 * thin chasing-rainbow rim whose soft glow bleeds outward off the border (the
 * iOS-glass look); the number and text are static white on dark so they stay
 * legible. The bigger the goal, the denser the confetti. Tap anywhere to dismiss.
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
import { LinearGradient } from 'expo-linear-gradient'
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  type SharedValue,
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

// The rainbow ring wheel: distinct hues placed around a disc that we rotate, so a
// different color sits on each edge/corner and they chase around the perimeter.
const WHEEL = ['#ff0040', '#ff8000', '#ffe000', '#40ff00', '#00ffcc', '#0080ff', '#8000ff', '#ff00c0']
// The two crossed rainbow gradients that make the spinning ring, as fixed tuples
// (expo-linear-gradient wants a non-empty color tuple).
const RING_A = ['#ff0040', '#ff8000', '#ffe000', '#40ff00', '#00ffcc', '#0080ff', '#8000ff', '#ff00c0', '#ff0040'] as const
const RING_B = ['#00ffcc', '#0080ff', '#8000ff', '#ff00c0', '#ff0040', '#ff8000', '#ffe000', '#40ff00'] as const

// Edge glow: an accent tint at each edge (gradient endpoints) fading to fully
const BORDER = 3 // rainbow rim thickness (px) - a thin bright line, not a slab
const CARD_RADIUS = radius.card
// Opaque near-black glass face, so only the rim + text read (not a rainbow slab).
const FACE = '#0e0d0c'

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window')

// Confetti scales with the goal: a modest goal still rains, a big one pours. The
// higher you climb, the more you get.
function confettiCountForGoal(goal: number): number {
  return Math.round(Math.max(80, Math.min(320, 80 + goal * 3)))
}

interface ConfettiSpec {
  x: number // start x (px)
  w: number // piece width (px)
  h: number // piece height (px) - taller than wide = a paper strip
  color: string
  fallMs: number // time to cross the screen once
  delayMs: number // initial stagger so the stream isn't a synchronized wall
  drift: number // horizontal sway amplitude (px)
  spin: number // full rotations per fall
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
          width: spec.w,
          height: spec.h,
          backgroundColor: spec.color,
        },
        style,
      ]}
    />
  )
}

/** A spinning two-gradient rainbow disc that fills its parent. Reused for both the
 *  crisp rim and the soft outward glow (the glow is just a blurred-substitute copy
 *  rendered larger and faint behind the card). */
function RainbowDisc({ spin, side }: { spin: SharedValue<number>; side: number }) {
  const style = useAnimatedStyle(() => ({
    transform: [{ rotateZ: `${spin.value * 360}deg` }],
  }))
  return (
    <Animated.View style={[{ width: side, height: side }, style]}>
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
  )
}

/**
 * The celebration card, built as stacked layers so it reads like backlit glass:
 *   1. a rim CONTAINER carrying a soft native shadow - that shadow is the outward
 *      glow bleeding off the border (the iOS-glass "light off the edge" look);
 *   2. a crisp rainbow RIM - the spinning disc clipped to the rounded frame;
 *   3. an opaque dark glass FACE inset by BORDER, on top of the rim, holding
 *      the content so only a thin bright rainbow line shows around it.
 */
function GlowCard({ children, style }: { children: React.ReactNode; style?: object }) {
  const spin = useSharedValue(0)
  useEffect(() => {
    spin.value = 0
    spin.value = withRepeat(withTiming(1, { duration: 3600, easing: Easing.linear }), -1, false)
    return () => cancelAnimation(spin)
  }, [spin])

  // Disc side must exceed the card's diagonal so color reaches every corner at any
  // rotation. A fixed size comfortably larger than the max card covers it.
  const DISC = 900

  return (
    <View style={[glowStyles.rim, style]}>
      {/* Rainbow rim: the spinning disc, clipped to the rounded card frame. */}
      <View style={glowStyles.rimClip} pointerEvents="none">
        <RainbowDisc spin={spin} side={DISC} />
      </View>
      {/* Opaque glass face inset by BORDER, on top of the rim. */}
      <View style={glowStyles.face}>{children}</View>
    </View>
  )
}

const glowStyles = StyleSheet.create({
  rim: {
    borderRadius: CARD_RADIUS + BORDER,
    padding: BORDER,
    // The outward glow: a soft, wide, low-opacity halo radiating off the border.
    // iOS reads shadowRadius as a blur; Android approximates with elevation.
    shadowColor: '#8a7bff',
    shadowOpacity: 0.8,
    shadowRadius: 26,
    shadowOffset: { width: 0, height: 0 },
    elevation: 24,
  },
  rimClip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: CARD_RADIUS + BORDER,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  face: {
    borderRadius: CARD_RADIUS,
    backgroundColor: FACE,
    overflow: 'hidden',
  },
})

/** Mounted once at the root layout, above every screen and the mini player. */
export function GoalCelebrationHost() {
  const state = useSyncExternalStore(subscribe, getState)
  const insets = useSafeAreaInsets()
  const colors = useColors()
  const styles = makeStyles(colors)

  // Card entrance pop. The text is static; only the ring + confetti move.
  const pop = useSharedValue(0)

  const goal = state?.goal ?? 0
  // Fresh confetti field each time a celebration opens (density scales w/ goal).
  const confetti = useMemo<ConfettiSpec[]>(() => {
    void state
    const count = confettiCountForGoal(goal)
    return Array.from({ length: count }, () => {
      // Perspective: pieces starting lower read as "closer" - bigger and faster.
      const depth = Math.random()
      // Cut-paper: sharp little squares and thin strips. Base width scales with
      // depth; ~40% are elongated into rectangles (a taller-than-wide chip).
      const base = 4 + depth * 8
      const strip = Math.random() < 0.4
      return {
        x: Math.random() * SCREEN_W,
        w: base,
        h: strip ? base * (2 + Math.random() * 1.5) : base,
        color: WHEEL[Math.floor(Math.random() * WHEEL.length)],
        fallMs: 2600 - depth * 1400 + Math.random() * 400,
        delayMs: Math.random() * 2600,
        drift: 12 + Math.random() * 46,
        spin: 1 + Math.random() * 3,
      }
    })
  }, [state, goal])

  useEffect(() => {
    if (!state) {
      pop.value = 0
      return
    }
    haptics.success()
    pop.value = withDelay(60, withSpring(1, { damping: 8, stiffness: 150, mass: 0.7 }))
  }, [state, pop])

  const cardStyle = useAnimatedStyle(() => ({
    opacity: interpolate(pop.value, [0, 0.3, 1], [0, 1, 1]),
    transform: [{ scale: 0.6 + pop.value * 0.4 }, { rotateZ: `${(1 - pop.value) * -6}deg` }],
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
      {/* Heavy cut-paper downpour over the live screen (no dimming layer). */}
      <View style={styles.fill} pointerEvents="none">
        {confetti.map((spec, i) => (
          <Confetti key={i} spec={spec} />
        ))}
      </View>

      <View style={[styles.center, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Animated.View style={cardStyle}>
          <GlowCard style={styles.cardShape}>
            <View style={styles.cardInner}>
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.kicker}>
                READING GOAL SMASHED
              </Text>

              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.brag}>
                {bragCount} {bragCount === 1 ? 'Book' : 'Books'}!
              </Text>

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
          </GlowCard>
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
    // Sizing lives on the GlowCard wrapper; the face + content padding is inside.
    cardShape: {
      width: '100%',
      maxWidth: 380,
    },
    cardInner: {
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.xl,
      paddingHorizontal: spacing.lg,
    },
    kicker: {
      color: '#c9b8ff',
      fontSize: 13,
      fontWeight: '900',
      letterSpacing: 2,
    },
    brag: {
      color: '#ffffff',
      fontFamily: fonts.mono,
      fontSize: 64,
      fontWeight: '900',
      letterSpacing: -1,
      textAlign: 'center',
      marginVertical: spacing.xs,
    },
    body: {
      color: 'rgba(255,255,255,0.62)',
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
    dismissText: { color: 'rgba(255,255,255,0.7)', fontSize: 14, fontWeight: '600' },
    pressed: { opacity: 0.7 },
  })
