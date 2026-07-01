/**
 * Draggable "Hearth Pill" scrubber, matching the web app's shipped
 * Scrubber.tsx + design.css `.scrub` exactly (not the earlier design-system
 * mockup variants - those had gold, a shimmer sweep, and chip backgrounds
 * that never shipped to web).
 *
 * Interaction mirrors the web component: while dragging, the displayed ratio
 * tracks the pointer locally and `onSeek` fires only once, on release - so a
 * drag that crosses a chapter/track boundary doesn't reload audio on every
 * move. A plain tap (no movement) still seeks immediately on release. `onDrag`
 * fires continuously with the live ratio (and once with `null` on end) so a
 * caller can preview the target time without committing a seek.
 *
 * Visual: a 30px rounded pill, ember fill (two-tone gradient toward a warmer
 * orange at the leading edge), interior elapsed / chapter / remain labels
 * (plain text, no background chips), and a full-height cream leading line
 * with an ember glow that thickens while dragging.
 */
import { useCallback, useRef, useState } from 'react'
import { StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { runOnJS } from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import { colors, radius } from '@/ui/theme'

const PILL_HEIGHT = 30
const EMBER = colors.accent // #e0654a
const CREAM = colors.brandCream // #ffe6cf
// Two-tone fill toward the leading edge. Matches web `.scrub > i`'s
// `color-mix(in oklab, accent 65%, #d27a3e) -> accent` exactly (computed in
// OKLab, not a linear-RGB guess - the two are visibly different colors).
const FILL_START = '#db6d46'
const FILL_END = EMBER

export function Scrubber({
  ratio,
  onSeek,
  onDrag,
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
        </View>

        {/* full-height cream leading line, behind the labels like web (the
            marker passes behind the text instead of overlapping it) */}
        {knob && (
          <View
            style={[styles.line, { left: `${pct}%`, width: dragging ? 3 : 2 }]}
            pointerEvents="none"
          />
        )}

        {/* interior labels - plain text over the fill/track, no background
            chip (web: .scrub-labels). Chapter takes all remaining width
            between elapsed/remain so long titles get real room instead of
            being clipped to a fixed max width. */}
        {hasLabels && (
          <View style={styles.labels} pointerEvents="none">
            <Text numberOfLines={1} style={styles.labelText}>
              {elapsed}
            </Text>
            {chapter !== undefined && (
              <Text numberOfLines={1} style={[styles.labelText, styles.labelChapter]}>
                {chapter}
              </Text>
            )}
            <Text numberOfLines={1} style={styles.labelText}>
              {remain}
            </Text>
          </View>
        )}
      </View>
    </GestureDetector>
  )
}

const styles = StyleSheet.create({
  pill: {
    height: PILL_HEIGHT,
    borderRadius: radius.pill,
    backgroundColor: '#232120', // color-mix(in oklab, text 9%, c-lowest)
    borderWidth: 1,
    borderColor: colors.hairline,
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
  labels: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 12,
  },
  labelText: {
    color: '#fff',
    fontSize: 10.5,
    fontWeight: '600',
    letterSpacing: 0.1,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  labelChapter: {
    flex: 1,
    textAlign: 'center',
    opacity: 0.85,
  },
  line: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    marginLeft: -1,
    backgroundColor: CREAM,
    // Dual-layer glow matches web's `box-shadow: 0 0 8px 1px accent, 0 0 2px
    // 0 cream` - RN only supports one shadow, so the ember bloom (the more
    // visible layer) wins; a plain shadowRadius:4 was much too faint.
    shadowColor: EMBER,
    shadowOpacity: 0.9,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
})
