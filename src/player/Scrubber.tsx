/**
 * Draggable "Hearth Pill" scrubber, ported from the web app's shipped
 * Scrubber.tsx + the design system's variant 2f ("Hearth Pill, calmer").
 *
 * Interaction mirrors the web component: while dragging, the displayed ratio
 * tracks the pointer locally and `onSeek` fires only once, on release - so a
 * drag that crosses a chapter/track boundary doesn't reload audio on every
 * move. A plain tap (no movement) still seeks immediately on release. `onDrag`
 * fires continuously with the live ratio (and once with `null` on end) so a
 * caller can preview the target time without committing a seek.
 *
 * Visual (2f): a 30px rounded pill with a two-tone gold -> ember fill, interior
 * elapsed / chapter / remain label chips, and a full-height cream leading line
 * that thickens while dragging. A shimmer sweeps the fill while playing.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  Easing,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import { colors, radius } from '@/ui/theme'

const PILL_HEIGHT = 30
const GOLD = colors.brandHearth // #bd863f
const EMBER = colors.accent // #e0654a
const CREAM = '#ffe6cf'
// Two-tone fill: gold blended toward ember, then ember. Matches web `.scrub > i`
// (`color-mix(accent 65%, #d27a3e)` -> accent); we approximate the mid stop.
const FILL_START = '#c07a42'
const FILL_END = EMBER

export function Scrubber({
  ratio,
  onSeek,
  onDrag,
  playing = false,
  knob = true,
  elapsed,
  remain,
  chapter,
}: {
  /** Current position, 0-1. Ignored while actively dragging. */
  ratio: number
  /** Called once, with the new 0-1 ratio, when a tap or drag ends. */
  onSeek: (ratio: number) => void
  /** Fires continuously while dragging with the live 0-1 ratio, and once with
   * null when the drag/tap ends - so the caller can preview the target time. */
  onDrag?: (ratio: number | null) => void
  playing?: boolean
  knob?: boolean
  elapsed?: string
  remain?: string
  chapter?: string
}) {
  const widthRef = useRef(0)
  const [dragRatio, setDragRatio] = useState<number | null>(null)
  const dragging = dragRatio !== null

  const onLayout = (e: LayoutChangeEvent) => {
    widthRef.current = e.nativeEvent.layout.width
  }

  const ratioFromX = useCallback((x: number) => {
    const w = widthRef.current
    if (w <= 0) return 0
    return Math.max(0, Math.min(1, x / w))
  }, [])

  const begin = useCallback(
    (x: number) => {
      const r = ratioFromX(x)
      setDragRatio(r)
      onDrag?.(r)
    },
    [ratioFromX, onDrag]
  )
  const move = useCallback(
    (x: number) => {
      const r = ratioFromX(x)
      setDragRatio(r)
      onDrag?.(r)
    },
    [ratioFromX, onDrag]
  )
  const end = useCallback(
    (x: number) => {
      const r = ratioFromX(x)
      setDragRatio(null)
      onDrag?.(null)
      onSeek(r)
    },
    [ratioFromX, onDrag, onSeek]
  )
  const cancel = useCallback(() => {
    setDragRatio(null)
    onDrag?.(null)
  }, [onDrag])

  // Pan recognizes a tap too (min distance 0), so tap-to-seek and drag share one
  // gesture. `x` is clamped in ratioFromX, so overshoot past the ends is fine.
  const pan = Gesture.Pan()
    .minDistance(0)
    .onBegin((e) => runOnJS(begin)(e.x))
    .onUpdate((e) => runOnJS(move)(e.x))
    .onEnd((e) => runOnJS(end)(e.x))
    .onFinalize((_e, success) => {
      if (!success) runOnJS(cancel)()
    })

  const shown = dragRatio ?? ratio
  const pct = Math.max(0, Math.min(1, shown)) * 100
  const hasLabels = elapsed !== undefined || remain !== undefined || chapter !== undefined

  // Shimmer sweep across the fill while playing (web: `hsShimmer` on the fill).
  const shimmer = useSharedValue(0)
  useEffect(() => {
    if (playing && !dragging) {
      shimmer.value = 0
      shimmer.value = withRepeat(
        withTiming(1, { duration: 2600, easing: Easing.linear }),
        -1,
        false
      )
    } else {
      cancelAnimation(shimmer)
      shimmer.value = 0
    }
  }, [playing, dragging, shimmer])

  const shimmerStyle = useAnimatedStyle(() => ({
    opacity: shimmer.value === 0 ? 0 : 1,
    transform: [{ translateX: `${-100 + shimmer.value * 200}%` }],
  }))

  return (
    <GestureDetector gesture={pan}>
      <View style={styles.pill} onLayout={onLayout} hitSlop={{ top: 8, bottom: 8 }}>
        {/* two-tone fill, exactly pill height */}
        <View style={[styles.fillClip, { width: `${pct}%` }]}>
          <LinearGradient
            colors={[FILL_START, FILL_END]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={StyleSheet.absoluteFill}
          />
          <Animated.View style={[styles.shimmer, shimmerStyle]} pointerEvents="none">
            <LinearGradient
              colors={['transparent', 'rgba(255,230,200,0.22)', 'transparent']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 0 }}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
        </View>

        {/* interior label chips - marker passes behind them */}
        {hasLabels && (
          <View style={styles.labels} pointerEvents="none">
            <LabelChip text={elapsed} />
            {chapter ? <LabelChip text={chapter} dim /> : <View />}
            <LabelChip text={remain ? `-${remain}` : undefined} />
          </View>
        )}

        {/* full-height cream leading line */}
        {knob && (
          <View
            style={[styles.line, { left: `${pct}%`, width: dragging ? 3 : 2 }]}
            pointerEvents="none"
          />
        )}
      </View>
    </GestureDetector>
  )
}

function LabelChip({ text, dim }: { text?: string; dim?: boolean }) {
  if (text === undefined) return <View />
  return (
    <View style={styles.chip}>
      <Text numberOfLines={1} style={[styles.labelText, dim && { opacity: 0.92 }]}>
        {text}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  pill: {
    height: PILL_HEIGHT,
    borderRadius: radius.pill,
    backgroundColor: '#232120', // color-mix(foreground 9%, lowest)
    borderWidth: 1,
    borderColor: 'rgba(224,101,74,0.48)', // #e0654a7a
    overflow: 'hidden',
    justifyContent: 'center',
  },
  fillClip: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    overflow: 'hidden',
  },
  shimmer: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: '55%',
  },
  labels: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  chip: {
    backgroundColor: 'rgba(18,13,10,0.34)',
    borderRadius: radius.pill,
    paddingHorizontal: 7,
    paddingVertical: 2,
    maxWidth: '46%',
  },
  labelText: {
    color: '#fff',
    fontSize: 10.5,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  line: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    marginLeft: -1,
    backgroundColor: CREAM,
    shadowColor: EMBER,
    shadowOpacity: 1,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 0 },
    elevation: 2,
  },
})
