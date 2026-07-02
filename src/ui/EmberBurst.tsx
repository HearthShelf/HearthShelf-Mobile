/**
 * A brief rise of ember particles off a control - the hearth's version of
 * confetti, for the app's emotional peaks (marking a book finished). Overlay it
 * on a relatively-positioned parent and bump `burst` to fire; it renders
 * nothing until the first burst and never intercepts touches.
 */
import { useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated'

const PARTICLE_COUNT = 7

interface ParticleSpec {
  delay: number
  dx: number
  rise: number
  size: number
  color: string
}

function Particle({ burst, spec }: { burst: number; spec: ParticleSpec }) {
  const progress = useSharedValue(0)

  // Re-run the flight on every burst; useMemo (not useEffect) so the launch
  // isn't a frame behind the state change that triggered it.
  useMemo(() => {
    progress.value = 0
    progress.value = withDelay(
      spec.delay,
      withTiming(1, { duration: 760, easing: Easing.out(Easing.quad) }),
    )
  }, [burst, progress, spec.delay])

  const style = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.08, 0.65, 1], [0, 1, 0.75, 0]),
    transform: [
      { translateY: interpolate(progress.value, [0, 1], [0, -spec.rise]) },
      { translateX: interpolate(progress.value, [0, 1], [0, spec.dx]) },
      { scale: interpolate(progress.value, [0, 0.2, 1], [0.5, 1, 0.35]) },
    ],
  }))

  return (
    <Animated.View
      style={[
        styles.particle,
        {
          width: spec.size,
          height: spec.size,
          borderRadius: spec.size / 2,
          backgroundColor: spec.color,
          marginLeft: -spec.size / 2,
        },
        style,
      ]}
    />
  )
}

export function EmberBurst({
  burst,
  colors,
}: {
  /** Increment to fire a burst. 0 renders nothing. */
  burst: number
  /** Ember tints, cycled across particles (e.g. [accent, brandHearth]). */
  colors: string[]
}) {
  // Fresh random drifts per burst so repeat fires don't look canned.
  const specs = useMemo<ParticleSpec[]>(
    () =>
      Array.from({ length: PARTICLE_COUNT }, (_, i) => ({
        delay: Math.random() * 140,
        dx: (Math.random() - 0.5) * 44,
        rise: 52 + Math.random() * 34,
        size: 4 + Math.random() * 3,
        color: colors[i % colors.length],
      })),
    [burst, colors],
  )

  if (burst === 0) return null
  return (
    <View style={styles.wrap} pointerEvents="none">
      {specs.map((spec, i) => (
        <Particle key={`${burst}-${i}`} burst={burst} spec={spec} />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'visible',
  },
  particle: { position: 'absolute', bottom: 10, left: '50%' },
})
