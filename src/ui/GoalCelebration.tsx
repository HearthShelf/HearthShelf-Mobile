/**
 * Yearly reading-goal celebration. A single host (<GoalCelebrationHost>) mounted
 * once at the root layout, fired from anywhere via `celebrateGoal({ goal, done })`
 * (module-level store, same shape as the toast host). When it fires it takes over
 * the screen with a warm scrim, a spring-in "Goal!" card, and a big ember burst -
 * the app's biggest emotional peak, one notch above a book-finished burst.
 *
 * The trigger decision (has the user hit the goal, and haven't we already
 * celebrated this exact goal number) lives in lib/goalCelebration.ts; this file
 * only renders. A "Raise the bar" button lets the user bump their goal on the
 * spot, which - because the celebrated-goal flag is keyed to the goal number -
 * re-arms the celebration for the new, higher target.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated'
import { EmberBurst } from './EmberBurst'
import { haptics } from './haptics'
import { MAX_FONT_SCALE, radius, spacing, fonts, type Palette } from './theme'
import { useColors } from './ThemeProvider'

export interface GoalCelebration {
  /** The goal the user just reached (books this year). */
  goal: number
  /** How many books they've actually finished this year. */
  done: number
  /** Bump the goal by `by` books (drives the "Raise the bar" button). */
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

/** Mounted once at the root layout, above every screen and the mini player. */
export function GoalCelebrationHost() {
  const state = useSyncExternalStore(subscribe, getState)
  const insets = useSafeAreaInsets()
  const colors = useColors()
  const styles = makeStyles(colors)

  // Drive the scrim + card entrance. Both live at the top so the hook order is
  // stable whether or not a celebration is showing.
  const scrim = useSharedValue(0)
  const pop = useSharedValue(0)

  useEffect(() => {
    if (!state) {
      scrim.value = 0
      pop.value = 0
      return
    }
    haptics.success()
    scrim.value = withTiming(1, { duration: 260, easing: Easing.out(Easing.quad) })
    // A brief overshoot pop so "Goal!" lands with a bounce, then settles.
    pop.value = withDelay(80, withSpring(1, { damping: 9, stiffness: 140, mass: 0.7 }))
  }, [state, scrim, pop])

  const scrimStyle = useAnimatedStyle(() => ({ opacity: scrim.value }))
  const cardStyle = useAnimatedStyle(() => ({
    opacity: scrim.value,
    transform: [{ scale: 0.7 + pop.value * 0.3 }, { translateY: (1 - pop.value) * 20 }],
  }))

  const handleRaise = useCallback(() => {
    if (!state) return
    haptics.confirm()
    const next = state.goal + RAISE_STEP
    state.onRaise?.(next)
    dismissCelebration()
  }, [state])

  if (!state) return null

  const done = state.done
  const goal = state.goal
  const over = Math.max(0, done - goal)

  return (
    <Pressable
      style={StyleSheet.absoluteFill}
      onPress={dismissCelebration}
      // The whole scrim is the dismiss target; buttons stopPropagation below.
    >
      <Animated.View style={[styles.scrim, scrimStyle]} pointerEvents="none" />
      <View style={[styles.center, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
        <Animated.View style={[styles.card, cardStyle]}>
          {/* Ember burst rises from behind the card's headline. Two stacked
              bursts (each has its own random drifts) read as a fuller shower for
              the app's biggest moment. */}
          <View style={styles.burstAnchor} pointerEvents="none">
            <EmberBurst burst={1} colors={[colors.accent, colors.brandHearth]} />
            <EmberBurst burst={1} colors={[colors.brandHearth, colors.success]} />
          </View>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.kicker}>
            READING GOAL
          </Text>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.headline}>
            Goal!
          </Text>
          <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.body}>
            {over > 0
              ? `You've finished ${done} books this year - ${over} past your goal of ${goal}.`
              : `You hit your goal of ${goal} ${goal === 1 ? 'book' : 'books'} this year.`}
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
    scrim: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.72)',
    },
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
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: 'visible',
    },
    burstAnchor: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      height: 120,
    },
    kicker: {
      color: colors.accent,
      fontSize: 12,
      fontWeight: '800',
      letterSpacing: 2,
    },
    headline: {
      color: colors.text,
      fontFamily: fonts.mono,
      fontSize: 44,
      fontWeight: '800',
      marginTop: spacing.xs,
    },
    body: {
      color: colors.textMuted,
      fontSize: 15,
      lineHeight: 21,
      textAlign: 'center',
      marginTop: spacing.xs,
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
