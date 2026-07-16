/**
 * Yearly reading-goal celebration. The launch/checking behavior lives in
 * lib/goalCelebration.ts; this file owns the brief, app-wide visual moment.
 *
 * The milestone itself stays compact and luminous while a finite depth-sorted
 * confetti field crosses the live app behind and in front of it. One shared
 * animation drives the entire field, so a bigger goal can earn more confetti
 * without starting an animation loop for every piece.
 */
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  AccessibilityInfo,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Defs, Ellipse, RadialGradient, Stop } from 'react-native-svg'
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { haptics } from './haptics'
import { fonts, MAX_FONT_SCALE, radius, spacing, type Palette } from './theme'
import { useColors } from './ThemeProvider'

export interface GoalCelebration {
  /** The goal the user just reached (books this year). */
  goal: number
  /** How many books they have actually finished this year. */
  done: number
  /** Bump the goal from the challenge button. */
  onRaise?: (nextGoal: number) => void
}

// --- global store: one celebration at a time -------------------------------

let current: GoalCelebration | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

/** Raise the goal celebration from anywhere (launch check or diagnostics). */
export function celebrateGoal(celebration: GoalCelebration): void {
  current = celebration
  emit()
}

function dismissCelebration(): void {
  current = null
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getState(): GoalCelebration | null {
  return current
}

const RAISE_STEP = 5

// Restrained, warm-saturated paper colors. Keeping lime and pure RGB out of the
// field lets the glow remain the visual signature instead of turning into a rave.
const CONFETTI_COLORS = ['#f16a4f', '#f3ad4f', '#f8e7c7', '#8b72e8', '#45beba', '#d968a1'] as const

/** More ambitious goals earn a denser burst, with a ceiling for older devices. */
function confettiCountForGoal(goal: number): number {
  return Math.min(128, Math.max(48, Math.round(36 + Math.sqrt(Math.max(1, goal)) * 7)))
}

type ConfettiFlight = 'burst' | 'fall'

interface ConfettiSpec {
  color: string
  delay: number
  depth: number
  dx: number
  dy: number
  end: number
  flight: ConfettiFlight
  height: number
  /** Fall chips only: fixed 0..1 offset into the wrapping rain phase. */
  loopOffset: number
  phase: number
  rise: number
  rotation: number
  turns: number
  width: number
  x: number
  y: number
}

function buildConfetti(
  goal: number,
  viewportWidth: number,
  viewportHeight: number,
): ConfettiSpec[] {
  const count = confettiCountForGoal(goal)
  const centerY = Math.min(viewportHeight * 0.44, viewportHeight - 280)

  return Array.from({ length: count }, (_, index) => {
    const depth = Math.random()
    const flight: ConfettiFlight = index < Math.round(count * 0.3) ? 'burst' : 'fall'
    const size = 3.5 + depth * 6
    const isRibbon = Math.random() < 0.52
    // Fall delays spread across most of the loop so the looping rain reads as
    // continuous instead of arriving in waves.
    const delay = flight === 'burst' ? 0.04 + Math.random() * 0.1 : Math.random() * 0.55
    const duration = 0.58 + (1 - depth) * 0.24
    const x =
      flight === 'burst'
        ? viewportWidth / 2 + (Math.random() - 0.5) * Math.min(190, viewportWidth * 0.52)
        : Math.random() * viewportWidth
    const y =
      flight === 'burst'
        ? centerY + (Math.random() - 0.5) * 90
        : -50 - Math.random() * viewportHeight * 0.28

    return {
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      delay,
      depth,
      dx:
        flight === 'burst'
          ? (Math.random() - 0.5) * viewportWidth * (0.7 + depth * 0.45)
          : (Math.random() - 0.5) * (32 + depth * 54),
      dy: viewportHeight - y + 80 + Math.random() * 120,
      end: Math.min(1, delay + duration),
      flight,
      height: isRibbon ? size * (1.8 + Math.random() * 1.7) : size,
      // Even, per-chip spread across the wrapping loop. Deterministic spacing
      // (index-based) plus a small jitter keeps the rain uniformly dense with
      // no synchronized gap between loops.
      loopOffset: (index / count + Math.random() * 0.12) % 1,
      phase: Math.random() * Math.PI * 2,
      rise: flight === 'burst' ? 80 + Math.random() * 150 : 0,
      rotation: Math.random() * 180,
      turns: 1.5 + Math.random() * 3.5,
      width: size,
      x,
      y,
    }
  })
}

/**
 * A single paper chip. Burst chips ride the one-shot progress; falling chips
 * ride the looping progress so the rain continues while the modal is open.
 */
function ConfettiPiece({
  burst,
  fall: fallProgress,
  spec,
}: {
  burst: SharedValue<number>
  fall: SharedValue<number>
  spec: ConfettiSpec
}) {
  const animatedStyle = useAnimatedStyle(() => {
    if (spec.flight === 'burst') {
      const local = Math.min(1, Math.max(0, (burst.value - spec.delay) / (spec.end - spec.delay)))
      const sway = Math.sin(local * Math.PI * 4 + spec.phase) * (8 + spec.depth * 16) * local
      const burstArc = -Math.sin(local * Math.PI) * spec.rise

      return {
        opacity: interpolate(local, [0, 0.045, 0.8, 1], [0, 1, 0.92, 0]),
        transform: [
          { translateX: spec.dx * local + sway },
          { translateY: burstArc + spec.dy * local * local },
          { rotateZ: `${spec.rotation + local * spec.turns * 360}deg` },
          { scale: 0.72 + spec.depth * 0.42 },
        ],
      }
    }

    // Fall chips ride a continuously wrapping phase: each has a fixed offset,
    // so the field is uniformly populated top-to-bottom at every instant and
    // never empties out between loops.
    const local = (fallProgress.value + spec.loopOffset) % 1
    const sway = Math.sin(local * Math.PI * 4 + spec.phase) * (8 + spec.depth * 16)

    return {
      // Fade in at the top, out near the bottom; both ends live off-screen via
      // spec.y so a chip is invisible only while it wraps.
      opacity: interpolate(local, [0, 0.08, 0.85, 1], [0, 1, 1, 0]),
      transform: [
        { translateX: spec.dx * local + sway },
        { translateY: spec.dy * local },
        { rotateZ: `${spec.rotation + local * spec.turns * 360}deg` },
        { scale: 0.72 + spec.depth * 0.42 },
      ],
    }
  })

  return (
    <Animated.View
      style={[
        particleStyles.piece,
        {
          backgroundColor: spec.color,
          height: spec.height,
          left: spec.x,
          top: spec.y,
          width: spec.width,
        },
        animatedStyle,
      ]}
    />
  )
}

function ConfettiField({
  burst,
  fall,
  specs,
}: {
  burst: SharedValue<number>
  fall: SharedValue<number>
  specs: ConfettiSpec[]
}) {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {specs.map((spec, index) => (
        <ConfettiPiece burst={burst} fall={fall} key={index} spec={spec} />
      ))}
    </View>
  )
}

const particleStyles = StyleSheet.create({
  piece: {
    borderRadius: 1.5,
    position: 'absolute',
  },
})

// Color cycle for the card interior. First and last entries match so the
// rotating sweep loops seamlessly; hues stay in the warm/violet family with
// one teal beat so the drift reads as living color, not a rainbow strobe.
const CARD_SWEEP_COLORS = [
  '#3459c8',
  '#7558da',
  '#c750b4',
  '#f16a4f',
  '#dfa348',
  '#45a8c8',
  '#3459c8',
] as const

/** Three offset radial fields create the soft multi-hue glow behind the badge. */
function AuroraGlow({ accent }: { accent: string }) {
  return (
    <Svg height="100%" viewBox="0 0 360 260" width="100%">
      <Defs>
        <RadialGradient cx="42%" cy="50%" id="warmGlow" r="56%">
          <Stop offset="0" stopColor={accent} stopOpacity="0.54" />
          <Stop offset="0.48" stopColor="#d968a1" stopOpacity="0.14" />
          <Stop offset="1" stopColor="#d968a1" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient cx="64%" cy="42%" id="coolGlow" r="58%">
          <Stop offset="0" stopColor="#7968e8" stopOpacity="0.52" />
          <Stop offset="0.52" stopColor="#456fd8" stopOpacity="0.12" />
          <Stop offset="1" stopColor="#456fd8" stopOpacity="0" />
        </RadialGradient>
        <RadialGradient cx="55%" cy="66%" id="goldGlow" r="48%">
          <Stop offset="0" stopColor="#f1b15a" stopOpacity="0.36" />
          <Stop offset="1" stopColor="#f1b15a" stopOpacity="0" />
        </RadialGradient>
      </Defs>
      <Ellipse cx="162" cy="134" fill="url(#warmGlow)" rx="148" ry="104" />
      <Ellipse cx="202" cy="118" fill="url(#coolGlow)" rx="144" ry="102" />
      <Ellipse cx="188" cy="158" fill="url(#goldGlow)" rx="116" ry="80" />
    </Svg>
  )
}

/** Mounted once at the root layout, above every route and player surface. */
export function GoalCelebrationHost() {
  const state = useSyncExternalStore(subscribe, getState)
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const { height, width } = useWindowDimensions()
  const reduceMotion = useReducedMotion()
  const styles = makeStyles(colors)

  const backdrop = useSharedValue(0)
  const badge = useSharedValue(0)
  const details = useSharedValue(0)
  const confettiProgress = useSharedValue(0)
  const confettiRain = useSharedValue(0)
  const glow = useSharedValue(0)
  const colorDrift = useSharedValue(0)

  const goal = state?.goal ?? 0
  const done = state?.done ?? 0
  const nextGoal = goal + RAISE_STEP
  const badgeWidth = Math.min(300, Math.max(248, width - spacing.xl * 2))
  const allConfetti = useMemo(
    () => (state && !reduceMotion ? buildConfetti(goal, width, height) : []),
    [goal, height, reduceMotion, state, width],
  )
  const behindConfetti = useMemo(
    () => allConfetti.filter((piece) => piece.depth < 0.78),
    [allConfetti],
  )
  const foregroundConfetti = useMemo(
    () => allConfetti.filter((piece) => piece.depth >= 0.78),
    [allConfetti],
  )

  useEffect(() => {
    cancelAnimation(backdrop)
    cancelAnimation(badge)
    cancelAnimation(details)
    cancelAnimation(confettiProgress)
    cancelAnimation(confettiRain)
    cancelAnimation(glow)
    cancelAnimation(colorDrift)

    if (!state) {
      backdrop.value = 0
      badge.value = 0
      details.value = 0
      confettiProgress.value = 0
      confettiRain.value = 0
      glow.value = 0
      colorDrift.value = 0
      return
    }

    haptics.success()
    void AccessibilityInfo.announceForAccessibility(
      `Yearly reading goal reached. ${state.goal} ${state.goal === 1 ? 'book' : 'books'}.`,
    )

    if (reduceMotion) {
      backdrop.value = 1
      badge.value = 1
      details.value = 1
      glow.value = 0.84
      return
    }

    backdrop.value = withTiming(1, { duration: 240, easing: Easing.out(Easing.quad) })
    badge.value = withDelay(90, withSpring(1, { damping: 14, mass: 0.72, stiffness: 175 }))
    confettiProgress.value = withDelay(
      260,
      withTiming(1, { duration: 3000, easing: Easing.linear }),
    )
    confettiRain.value = withDelay(
      260,
      withRepeat(withTiming(1, { duration: 3400, easing: Easing.linear }), -1, false),
    )
    details.value = withDelay(
      620,
      withTiming(1, { duration: 360, easing: Easing.out(Easing.cubic) }),
    )
    colorDrift.value = withRepeat(
      withTiming(1, { duration: 9000, easing: Easing.linear }),
      -1,
      false,
    )
    glow.value = withDelay(
      120,
      withSequence(
        withTiming(1, { duration: 520, easing: Easing.out(Easing.cubic) }),
        withTiming(0.82, { duration: 760, easing: Easing.inOut(Easing.quad) }),
        withTiming(0.9, { duration: 460, easing: Easing.out(Easing.quad) }),
      ),
    )
  }, [
    backdrop,
    badge,
    confettiProgress,
    confettiRain,
    details,
    glow,
    reduceMotion,
    colorDrift,
    state,
  ])

  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.value }))
  const badgeStyle = useAnimatedStyle(() => ({
    opacity: interpolate(badge.value, [0, 0.22, 1], [0, 1, 1]),
    transform: [{ scale: interpolate(badge.value, [0, 1], [0.72, 1]) }],
  }))
  const detailStyle = useAnimatedStyle(() => ({
    opacity: details.value,
    transform: [{ translateY: interpolate(details.value, [0, 1], [14, 0]) }],
  }))
  const glowStyle = useAnimatedStyle(() => ({
    opacity: interpolate(glow.value, [0, 1], [0, 0.68]),
    transform: [
      { scale: interpolate(glow.value, [0, 1], [0.72, 1]) },
      // Slow counter-rotation drifts the offset warm/cool/gold fields around
      // the badge, so the halo's hues travel instead of sitting still.
      { rotateZ: `${-colorDrift.value * 360}deg` },
    ],
  }))
  // The card interior: an oversized gradient square spins behind the static
  // base wash, fading between them so the card's color slowly travels.
  const sweepStyle = useAnimatedStyle(() => ({
    opacity: 0.5 + Math.sin(colorDrift.value * Math.PI * 2) * 0.28,
    transform: [{ rotateZ: `${colorDrift.value * 360}deg` }],
  }))

  const handleRaise = useCallback(() => {
    if (!state) return
    haptics.mode()
    state.onRaise?.(state.goal + RAISE_STEP)
    dismissCelebration()
  }, [state])

  if (!state) return null

  const year = new Date().getFullYear()
  const statusCopy =
    done > goal
      ? `${done} finished, ${done - goal} past the goal.`
      : `${done} ${done === 1 ? 'book' : 'books'} this year.`

  return (
    <Modal
      animationType="none"
      hardwareAccelerated
      onRequestClose={dismissCelebration}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible
    >
      <View accessibilityViewIsModal style={styles.fill}>
        <Animated.View pointerEvents="none" style={[styles.backdrop, backdropStyle]} />
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={dismissCelebration}
          style={styles.fill}
        />

        <ConfettiField burst={confettiProgress} fall={confettiRain} specs={behindConfetti} />

        <View
          pointerEvents="box-none"
          style={[
            styles.content,
            {
              paddingBottom: Math.max(insets.bottom, spacing.lg),
              paddingTop: Math.max(insets.top, spacing.lg),
            },
          ]}
        >
          <Animated.View style={[styles.milestoneWrap, { width: badgeWidth }, badgeStyle]}>
            <Animated.View pointerEvents="none" style={[styles.glow, glowStyle]}>
              <AuroraGlow accent={colors.accent} />
            </Animated.View>

            <View style={styles.badgeShadow}>
              <View style={styles.badge}>
                <LinearGradient
                  colors={['#3459c8', '#7558da', colors.accent, '#dfa348']}
                  end={{ x: 1, y: 1 }}
                  pointerEvents="none"
                  start={{ x: 0, y: 0 }}
                  style={StyleSheet.absoluteFill}
                />
                <Animated.View pointerEvents="none" style={[styles.cardSweep, sweepStyle]}>
                  <LinearGradient
                    colors={CARD_SWEEP_COLORS}
                    end={{ x: 1, y: 1 }}
                    start={{ x: 0, y: 0 }}
                    style={StyleSheet.absoluteFill}
                  />
                </Animated.View>
                <LinearGradient
                  colors={['rgba(255,255,255,0.28)', 'rgba(255,255,255,0.02)', 'rgba(0,0,0,0.2)']}
                  end={{ x: 1, y: 1 }}
                  pointerEvents="none"
                  start={{ x: 0, y: 0 }}
                  style={StyleSheet.absoluteFill}
                />
                <View pointerEvents="none" style={styles.badgeHighlight} />

                <View
                  accessible
                  accessibilityLabel={`${year} reading goal. ${goal} ${goal === 1 ? 'book' : 'books'}. Goal reached.`}
                  accessibilityRole="header"
                  style={styles.badgeContent}
                >
                  <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.kicker}>
                    {year} READING GOAL
                  </Text>
                  <View style={styles.numberRow}>
                    <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.goalNumber}>
                      {goal}
                    </Text>
                    <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.goalUnit}>
                      {goal === 1 ? 'BOOK' : 'BOOKS'}
                    </Text>
                  </View>
                  <View style={styles.badgeRule} />
                  <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.reached}>
                    GOAL REACHED
                  </Text>
                </View>
              </View>
            </View>
          </Animated.View>

          <Animated.View style={[styles.details, detailStyle]}>
            {state.onRaise ? (
              <View style={styles.challenge}>
                <Pressable
                  accessibilityHint="Updates your yearly reading goal"
                  accessibilityLabel={`Raise yearly goal to ${nextGoal} books`}
                  accessibilityRole="button"
                  onPress={handleRaise}
                  style={({ pressed }) => [styles.raiseButton, pressed && styles.pressed]}
                >
                  <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.raiseButtonText}>
                    Raise it to {nextGoal}
                  </Text>
                  <Text
                    accessibilityElementsHidden
                    maxFontSizeMultiplier={MAX_FONT_SCALE}
                    style={styles.arrow}
                  >
                    →
                  </Text>
                </Pressable>
              </View>
            ) : null}

            <Pressable
              accessibilityLabel={`Keep yearly goal at ${goal} books`}
              accessibilityRole="button"
              hitSlop={8}
              onPress={dismissCelebration}
              style={({ pressed }) => [styles.keepButton, pressed && styles.pressed]}
            >
              <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.keepButtonText}>
                Keep {goal}
              </Text>
            </Pressable>
          </Animated.View>
        </View>

        <ConfettiField burst={confettiProgress} fall={confettiRain} specs={foregroundConfetti} />
      </View>
    </Modal>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    fill: {
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    backdrop: {
      bottom: 0,
      backgroundColor: 'rgba(8,7,10,0.96)',
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    content: {
      alignItems: 'center',
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: spacing.xl,
    },
    milestoneWrap: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    glow: {
      height: 260,
      position: 'absolute',
      width: 360,
    },
    badgeShadow: {
      borderRadius: 30,
      elevation: 24,
      shadowColor: colors.accent,
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.42,
      shadowRadius: 28,
      width: '100%',
    },
    // Oversized square spinning inside the clipped badge; the card is a
    // moving window onto it, so its colors sweep across the surface.
    cardSweep: {
      height: 460,
      left: '50%',
      marginLeft: -230,
      marginTop: -230,
      position: 'absolute',
      top: '50%',
      width: 460,
    },
    badge: {
      borderRadius: 30,
      minHeight: 204,
      overflow: 'hidden',
      width: '100%',
    },
    badgeHighlight: {
      bottom: 0,
      borderColor: 'rgba(255,255,255,0.42)',
      borderRadius: 30,
      borderWidth: StyleSheet.hairlineWidth,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
    badgeContent: {
      alignItems: 'center',
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.xl,
    },
    kicker: {
      color: 'rgba(255,255,255,0.78)',
      fontFamily: fonts.brand,
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 1.7,
    },
    numberRow: {
      alignItems: 'flex-end',
      flexDirection: 'row',
      gap: spacing.sm,
      justifyContent: 'center',
      marginBottom: spacing.xs,
      marginTop: spacing.xs,
    },
    goalNumber: {
      color: '#fffdf8',
      fontFamily: fonts.mono,
      fontSize: 68,
      fontWeight: '700',
      letterSpacing: -3,
      lineHeight: 76,
      textShadowColor: 'rgba(19,10,36,0.24)',
      textShadowOffset: { width: 0, height: 2 },
      textShadowRadius: 8,
    },
    goalUnit: {
      color: 'rgba(255,255,255,0.86)',
      fontFamily: fonts.sans,
      fontSize: 16,
      fontWeight: '700',
      letterSpacing: 1.2,
      lineHeight: 27,
      marginBottom: 11,
    },
    badgeRule: {
      backgroundColor: 'rgba(255,255,255,0.32)',
      height: StyleSheet.hairlineWidth,
      marginBottom: spacing.sm,
      width: 76,
    },
    reached: {
      color: '#fffdf8',
      fontFamily: fonts.sans,
      fontSize: 12,
      fontWeight: '700',
      letterSpacing: 2.3,
    },
    details: {
      alignItems: 'center',
      marginTop: spacing.xl,
      maxWidth: 360,
      width: '100%',
    },
    statusCopy: {
      color: 'rgba(255,255,255,0.86)',
      fontFamily: fonts.sans,
      fontSize: 16,
      fontWeight: '600',
      lineHeight: 23,
      textAlign: 'center',
    },
    challenge: {
      alignItems: 'center',
      marginTop: spacing.lg,
      width: '100%',
    },
    raiseButton: {
      alignItems: 'center',
      backgroundColor: 'rgba(255,255,255,0.11)',
      borderColor: 'rgba(255,255,255,0.2)',
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      justifyContent: 'center',
      minHeight: 52,
      paddingHorizontal: spacing.xl,
      width: '100%',
    },
    raiseButtonText: {
      color: '#fffdf8',
      fontFamily: fonts.sans,
      fontSize: 15,
      fontWeight: '700',
    },
    arrow: {
      color: '#f5bd73',
      fontFamily: fonts.sans,
      fontSize: 20,
      marginLeft: spacing.sm,
      marginTop: -2,
    },
    keepButton: {
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 48,
      paddingHorizontal: spacing.lg,
    },
    keepButtonText: {
      color: 'rgba(255,255,255,0.7)',
      fontFamily: fonts.sans,
      fontSize: 14,
      fontWeight: '600',
    },
    pressed: {
      opacity: 0.68,
      transform: [{ scale: 0.985 }],
    },
  })
