/**
 * The app's one motion vocabulary, so every surface pops/fades the same way:
 *  - POP_SPRING is the A-Z rail's bubble spring (the app's established "pop").
 *  - DUR matches the settings accordion's fade/layout timings.
 *  - PULSE_MS is the splash glow's breathing period, reused wherever something
 *    should feel like a live hearth rather than a static tint.
 *  - BUBBLE_SPRING grows the More menu out of its corner (a slower, larger-
 *    surface entrance than POP).
 * New animation work should draw from these instead of inventing new curves.
 */
import { useEffect } from 'react'
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native'
import Animated, {
  useAnimatedStyle,
  useReducedMotion as useReanimatedReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated'

/**
 * True when the OS "Reduce Motion" accessibility setting is on. Thin re-export of
 * Reanimated's hook so every motion consumer gates on ONE import (D-A11Y): loops
 * become static, big entrances become cross-fades. Kept here beside the other
 * motion primitives so it's the obvious place to reach for.
 */
export function useReducedMotion(): boolean {
  return useReanimatedReducedMotion()
}

export const POP_SPRING = { damping: 13, stiffness: 380, mass: 0.5 } as const

export const DUR = { fast: 120, base: 180, slow: 220 } as const

/**
 * The More menu bubble's growth (docs/redesign/more-menu.html). Deliberately NOT
 * POP_SPRING: that one is tuned for press feedback and snaps in ~200ms, which
 * reads as a flash on a surface this large. This is slower and only just
 * underdamped - ~520ms to rest with roughly 2% overshoot, matching the mockup's
 * cubic-bezier(0.2, 0.82, 0.26, 1.12).
 *
 * Driven as ONE spring per axis from start to rest. Intermediate waypoints
 * restart the easing mid-growth, which reads as a stutter (see design.md).
 */
export const BUBBLE_SPRING = { damping: 26, stiffness: 190, mass: 1 } as const

/** Bubble dismissal: no overshoot, just a quick shrink back to the corner. */
export const BUBBLE_CLOSE_MS = 160

/** Per-row reveal, counted back from the row nearest the growth corner. */
export const BUBBLE_STAGGER_MS = 34
export const BUBBLE_STAGGER_DELAY_MS = 150
export const BUBBLE_ROW_FADE_MS = 220

/**
 * Shelf Lift navigation doses (docs/redesign/08-transitions-2.html). Every
 * navigation entrance is fade + upward settle; every exit sinks. Only the dose
 * changes with the gesture: tab swaps whisper (micro), pushes and the player
 * speak (standard), and Reduce Motion / tabletop drop displacement entirely
 * (zero: opacity only). Distances in px, durations in ms.
 */
export const LIFT = {
  // 200ms after on-device tuning: 160 read as a blink on tab swaps.
  micro: { distance: 8, duration: 200 },
  standard: { distance: 18, duration: 240 },
  zero: { distance: 0, duration: 120 },
} as const

/**
 * Player downward-swipe rejection: the surface follows the finger at
 * `followRatio` up to `capPx`, then springs back. The rubber band IS the
 * feedback - no toast, no navigation.
 */
export const LIFT_REJECT = { followRatio: 0.1, capPx: 14 } as const
export const LIFT_REJECT_SPRING = { damping: 18, stiffness: 240, mass: 0.7 } as const

export const PULSE_MS = 2600

const AnimatedPressable = Animated.createAnimatedComponent(Pressable)

/**
 * A Pressable that springs down to `scaleTo` while held and pops back on
 * release - touch acknowledgment that reads on every platform (Android ripple
 * can't be used here: the scale transform would clip it).
 */
export function SpringPressable({
  children,
  style,
  scaleTo = 0.96,
  disabled,
  ...pressableProps
}: {
  children: React.ReactNode
  style?: StyleProp<ViewStyle>
  /** How far the surface sinks while held. Smaller = punchier. */
  scaleTo?: number
} & Omit<PressableProps, 'style' | 'children'>) {
  const scale = useSharedValue(1)
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }))

  // A disabled surface mid-press should not stay sunken.
  useEffect(() => {
    if (disabled) scale.value = withSpring(1, POP_SPRING)
  }, [disabled, scale])

  return (
    <AnimatedPressable
      {...pressableProps}
      disabled={disabled}
      onPressIn={(e) => {
        scale.value = withSpring(scaleTo, POP_SPRING)
        pressableProps.onPressIn?.(e)
      }}
      onPressOut={(e) => {
        scale.value = withSpring(1, POP_SPRING)
        pressableProps.onPressOut?.(e)
      }}
      style={[style, animated]}
    >
      {children}
    </AnimatedPressable>
  )
}
