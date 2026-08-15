/**
 * The app-wide slider for numeric adjustments (speed, sleep rewind/fade, skip
 * amounts). Replaces @react-native-community/slider, whose responder-based
 * dragging loses the gesture fight inside bottom sheets and whose touch target
 * is only the thin rendered track.
 *
 * Built on a gesture-handler Pan with zero min distance (same recipe as the
 * player Scrubber), so it activates on touch-down and wins against a parent
 * sheet's pan. The whole 44px strip is the hitbox. Optional ticks render
 * markers on the track with labels anchored to the real track positions, so
 * labels always line up with where the thumb actually lands.
 *
 * The thumb is driven by a shared value on the UI thread, never React state.
 * Consumers wire onChange to a store write, and that store notifies every
 * subscriber synchronously - so a React-state thumb meant each notch waited on
 * a full settings-panel re-render, which is what made fast drags stutter and
 * lag behind the finger. The gesture now only hops to JS when the snapped value
 * actually changes, and `commitMode` lets a consumer defer the write to
 * release.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated'
import { haptics } from '@/ui/haptics'
import { AppText } from '@/ui/primitives'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

const TRACK_H = 6
const THUMB_R = 10
const HIT_H = 44

function snap(v: number, min: number, max: number, step: number): number {
  'worklet'
  const clamped = Math.max(min, Math.min(max, v))
  const stepped = min + Math.round((clamped - min) / step) * step
  // Trim float drift (0.30000000000000004) so consumers can compare/display raw.
  const decimals = Math.min(6, `${step}`.split('.')[1]?.length ?? 0)
  return Number(Math.max(min, Math.min(max, stepped)).toFixed(decimals))
}

export function AppSlider({
  value,
  min,
  max,
  step = 1,
  onChange,
  onComplete,
  commitMode = 'live',
  ticks,
  formatTick,
  haptic = true,
  style,
}: {
  value: number
  min: number
  max: number
  step?: number
  /** Fires with each snapped value change while dragging. */
  onChange: (v: number) => void
  /** Fires once with the final value when the drag/tap ends. */
  onComplete?: (v: number) => void
  /** 'live' (default) reports every snapped step. 'release' reports only when
   *  the finger lifts - use it when onChange writes to a store whose notify
   *  re-renders a whole screen. The thumb tracks the finger either way. */
  commitMode?: 'live' | 'release'
  /** Values to mark on the track, with labels beneath (e.g. [0.5, 1, 2, 3]). */
  ticks?: number[]
  formatTick?: (v: number) => string
  /** Per-step select haptic while dragging. Off for fine-grained sliders (e.g.
   *  the reader position bar) that fire their own coarser haptic instead. */
  haptic?: boolean
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [trackW, setTrackW] = useState(0)

  // Live drag state lives on the UI thread. `dragging` (not a sentinel value)
  // decides whether the thumb follows the finger or the `value` prop, so
  // sliders with negative or zero minimums are handled the same as any other.
  const trackWSV = useSharedValue(0)
  const valueSV = useSharedValue(value)
  const dragValue = useSharedValue(value)
  const dragging = useSharedValue(false)
  const lastSent = useSharedValue(value)
  useEffect(() => {
    valueSV.value = value
    // Resync the change-dedupe baseline too, so an external change (a reset,
    // a synced setting) doesn't swallow a later drag back to that same value.
    if (!dragging.value) lastSent.value = value
  }, [value, valueSV, dragging, lastSent])

  // Consumers often pass inline arrows for onChange/onComplete; route them
  // through refs so our gesture callbacks stay stable regardless.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  const onLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width
    trackWSV.value = w
    setTrackW(w)
  }

  // Only these three ever cross to JS, and only on an actual snapped change -
  // not per frame.
  const emitChange = useCallback((v: number) => onChangeRef.current(v), [])
  const emitComplete = useCallback((v: number) => onCompleteRef.current?.(v), [])
  const tapHaptic = useCallback(() => haptics.select(), [])

  const pan = useMemo(() => {
    const valueFromX = (x: number) => {
      'worklet'
      const usable = trackWSV.value - THUMB_R * 2
      if (usable <= 0) return valueSV.value
      const ratio = Math.max(0, Math.min(1, (x - THUMB_R) / usable))
      return snap(min + ratio * (max - min), min, max, step)
    }
    const move = (x: number) => {
      'worklet'
      const v = valueFromX(x)
      dragging.value = true
      dragValue.value = v
      if (v !== lastSent.value) {
        lastSent.value = v
        if (haptic) runOnJS(tapHaptic)()
        if (commitMode === 'live') runOnJS(emitChange)(v)
      }
    }
    // Zero min distance: activates on touch-down, so taps seat the thumb and
    // the parent sheet never steals the drag.
    return Gesture.Pan()
      .minDistance(0)
      .onBegin((e) => move(e.x))
      .onUpdate((e) => move(e.x))
      .onEnd((e) => {
        const v = valueFromX(e.x)
        dragging.value = false
        if (commitMode === 'release' || v !== lastSent.value) {
          lastSent.value = v
          runOnJS(emitChange)(v)
        }
        runOnJS(emitComplete)(v)
      })
      .onFinalize((_e, success) => {
        if (!success) dragging.value = false
      })
  }, [
    min,
    max,
    step,
    haptic,
    commitMode,
    emitChange,
    emitComplete,
    tapHaptic,
    trackWSV,
    valueSV,
    dragValue,
    dragging,
    lastSent,
  ])

  const usable = Math.max(0, trackW - THUMB_R * 2)

  // Position follows the drag on the UI thread; when idle it tracks the prop.
  const thumbX = useDerivedValue(() => {
    const shown = dragging.value ? dragValue.value : valueSV.value
    const r = max > min ? (Math.max(min, Math.min(max, shown)) - min) / (max - min) : 0
    return r * Math.max(0, trackWSV.value - THUMB_R * 2)
  })
  const thumbStyle = useAnimatedStyle(() => ({
    left: thumbX.value,
    transform: [{ scale: dragging.value ? 1.15 : 1 }],
  }))
  const fillStyle = useAnimatedStyle(() => ({ width: THUMB_R + thumbX.value }))

  const tickX = (t: number) => THUMB_R + (max > min ? ((t - min) / (max - min)) * usable : 0)

  return (
    <View style={style}>
      <GestureDetector gesture={pan}>
        <View style={styles.hitStrip} onLayout={onLayout} hitSlop={{ top: 6, bottom: 6 }}>
          <View style={styles.track}>
            <Animated.View style={[styles.fill, fillStyle]} />
            {ticks?.map((t) => (
              <TickMark key={t} x={tickX(t) - 1} thumbX={thumbX} styles={styles} />
            ))}
          </View>
          <Animated.View style={[styles.thumb, thumbStyle]} />
        </View>
      </GestureDetector>
      {ticks && formatTick ? (
        <View style={styles.tickLabels}>
          {ticks.map((t) => (
            <View key={t} style={[styles.tickAnchor, { left: tickX(t) }]}>
              <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                {formatTick(t)}
              </AppText>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  )
}

/** A tick on the track that fills in as the thumb passes it. Compares against
 *  the thumb's live position so it recolors on the UI thread mid-drag. */
function TickMark({
  x,
  thumbX,
  styles,
}: {
  x: number
  thumbX: SharedValue<number>
  styles: ReturnType<typeof makeStyles>
}) {
  const passed = useAnimatedStyle(() => ({ opacity: thumbX.value >= x ? 1 : 0 }))
  return (
    <>
      <View style={[styles.tickMark, { left: x }]} />
      <Animated.View style={[styles.tickMark, styles.tickMarkPassed, { left: x }, passed]} />
    </>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    hitStrip: {
      height: HIT_H,
      justifyContent: 'center',
    },
    track: {
      height: TRACK_H,
      borderRadius: radius.pill,
      backgroundColor: colors.fillStrong,
      overflow: 'hidden',
    },
    fill: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      backgroundColor: colors.accent,
      borderRadius: radius.pill,
    },
    tickMark: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      width: 2,
      backgroundColor: colors.hairline,
    },
    tickMarkPassed: {
      backgroundColor: 'rgba(0,0,0,0.25)',
    },
    thumb: {
      position: 'absolute',
      width: THUMB_R * 2,
      height: THUMB_R * 2,
      borderRadius: THUMB_R,
      backgroundColor: colors.accent,
      borderWidth: 2,
      borderColor: colors.brandCream,
      // Vertically centered in the hit strip.
      top: HIT_H / 2 - THUMB_R,
    },
    // Zero-width anchors: each label centers itself on the exact track x of its
    // tick, so labels can't drift from where the thumb lands.
    tickLabels: {
      height: 16,
      marginTop: 2,
    },
    tickAnchor: {
      position: 'absolute',
      top: 0,
      width: 0,
      alignItems: 'center',
    },
  })
