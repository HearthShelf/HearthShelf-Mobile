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
 */
import { useCallback, useMemo, useRef, useState } from 'react'
import { StyleSheet, View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { runOnJS } from 'react-native-reanimated'
import { haptics } from '@/ui/haptics'
import { AppText } from '@/ui/primitives'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

const TRACK_H = 6
const THUMB_R = 10
const HIT_H = 44

function snap(v: number, min: number, max: number, step: number): number {
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
  ticks,
  formatTick,
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
  /** Values to mark on the track, with labels beneath (e.g. [0.5, 1, 2, 3]). */
  ticks?: number[]
  formatTick?: (v: number) => string
  style?: StyleProp<ViewStyle>
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [trackW, setTrackW] = useState(0)
  const [dragValue, setDragValue] = useState<number | null>(null)
  const lastSent = useRef(value)

  // Read live geometry/value through refs so the gesture callbacks (and the
  // gesture object itself) never need to be rebuilt when `value` or `trackW`
  // change. Rebuilding them mid-drag re-attached the GestureDetector every frame
  // and, together with the onChange->store->re-render feedback, spun React into
  // a "maximum update depth exceeded" loop and made dragging crawl.
  const trackWRef = useRef(trackW)
  trackWRef.current = trackW
  const valueRef = useRef(value)
  valueRef.current = value
  // Consumers often pass inline arrows for onChange/onComplete; route them
  // through refs so our gesture callbacks stay stable regardless.
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  const onLayout = (e: LayoutChangeEvent) => setTrackW(e.nativeEvent.layout.width)

  const valueFromX = useCallback(
    (x: number) => {
      const usable = trackWRef.current - THUMB_R * 2
      if (usable <= 0) return valueRef.current
      const ratio = Math.max(0, Math.min(1, (x - THUMB_R) / usable))
      return snap(min + ratio * (max - min), min, max, step)
    },
    [min, max, step],
  )

  const update = useCallback(
    (x: number) => {
      const v = valueFromX(x)
      setDragValue(v)
      if (v !== lastSent.current) {
        lastSent.current = v
        haptics.select()
        onChangeRef.current(v)
      }
    },
    [valueFromX],
  )
  const finish = useCallback(
    (x: number) => {
      const v = valueFromX(x)
      setDragValue(null)
      if (v !== lastSent.current) {
        lastSent.current = v
        onChangeRef.current(v)
      }
      onCompleteRef.current?.(v)
    },
    [valueFromX],
  )
  const cancel = useCallback(() => setDragValue(null), [])

  // Zero min distance: activates on touch-down, so taps seat the thumb and the
  // parent sheet never steals the drag. Memoized so GestureDetector isn't handed
  // a fresh gesture object on every render (which re-attaches mid-drag).
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .minDistance(0)
        .onBegin((e) => runOnJS(update)(e.x))
        .onUpdate((e) => runOnJS(update)(e.x))
        .onEnd((e) => runOnJS(finish)(e.x))
        .onFinalize((_e, success) => {
          if (!success) runOnJS(cancel)()
        }),
    [update, finish, cancel],
  )

  const shown = dragValue ?? value
  const ratio = max > min ? (Math.max(min, Math.min(max, shown)) - min) / (max - min) : 0
  const usable = Math.max(0, trackW - THUMB_R * 2)
  const thumbX = ratio * usable

  const tickX = (t: number) =>
    THUMB_R + (max > min ? ((t - min) / (max - min)) * usable : 0)

  return (
    <View style={style}>
      <GestureDetector gesture={pan}>
        <View style={styles.hitStrip} onLayout={onLayout} hitSlop={{ top: 6, bottom: 6 }}>
          <View style={styles.track}>
            <View style={[styles.fill, { width: THUMB_R + thumbX }]} />
            {ticks?.map((t) => (
              <View
                key={t}
                style={[
                  styles.tickMark,
                  { left: tickX(t) - 1 },
                  shown >= t && styles.tickMarkPassed,
                ]}
              />
            ))}
          </View>
          <View style={[styles.thumb, { left: thumbX }, dragValue !== null && styles.thumbActive]} />
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
    thumbActive: {
      transform: [{ scale: 1.15 }],
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
