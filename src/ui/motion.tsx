/**
 * The app's one motion vocabulary, so every surface pops/fades the same way:
 *  - POP_SPRING is the A-Z rail's bubble spring (the app's established "pop").
 *  - DUR matches the settings accordion's fade/layout timings.
 *  - PULSE_MS is the splash glow's breathing period, reused wherever something
 *    should feel like a live hearth rather than a static tint.
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
