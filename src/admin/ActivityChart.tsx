/**
 * All-time listening by hour of day or day of week. One series, so the title names
 * it and there is no legend. A phone has no hover: tapping a bar puts its value in
 * the line above the chart, which starts on the busiest bar.
 */
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import Svg, { Line, Path, Text as SvgText } from 'react-native-svg'
import { DAY_LABELS, HOUR_LABELS, activityValue, type HSServerActivity } from '@hearthshelf/core'
import { AppText } from '@/ui/primitives'
import { Seg } from '@/ui/settingsControls'
import { useColors } from '@/ui/ThemeProvider'
import { spacing, type as typeScale } from '@/ui/theme'

type Mode = 'hour' | 'day'

const PLOT_HEIGHT = 140
const AXIS_HEIGHT = 18
const BAR_GAP = 2
const BAR_RADIUS = 4
const MIN_BAR_HEIGHT = 2
const IDLE_BAR_OPACITY = 0.45

const MODES: { value: Mode; label: string }[] = [
  { value: 'hour', label: 'By hour' },
  { value: 'day', label: 'By day' },
]

/** A bar with a rounded top and a square foot on the baseline. */
function barPath(x: number, width: number, height: number): string {
  const r = Math.min(BAR_RADIUS, width / 2, height)
  const top = PLOT_HEIGHT - height
  return [
    `M${x} ${PLOT_HEIGHT}`,
    `V${top + r}`,
    `Q${x} ${top} ${x + r} ${top}`,
    `H${x + width - r}`,
    `Q${x + width} ${top} ${x + width} ${top + r}`,
    `V${PLOT_HEIGHT}`,
    'Z',
  ].join(' ')
}

export function ActivityChart({ data }: { data: HSServerActivity }) {
  const colors = useColors()
  const [mode, setMode] = useState<Mode>('hour')
  const [picked, setPicked] = useState<number | null>(null)
  const [width, setWidth] = useState(0)

  const values = mode === 'hour' ? data.byHour : data.byDay
  const labels = mode === 'hour' ? HOUR_LABELS : DAY_LABELS
  const labelEvery = mode === 'hour' ? 6 : 1
  const max = Math.max(0, ...values)
  const peak = values.indexOf(max)
  const selected = picked ?? peak
  const slot = width / values.length

  const changeMode = (next: Mode) => {
    setMode(next)
    setPicked(null)
  }

  if (!data.available) {
    return (
      <AppText variant="meta" color={colors.textMuted}>
        Activity will show up once the server can read its listening history.
      </AppText>
    )
  }
  if (max <= 0) {
    return (
      <AppText variant="meta" color={colors.textMuted}>
        No listening yet.
      </AppText>
    )
  }

  return (
    <View style={styles.wrap}>
      <Seg value={mode} onChange={changeMode} options={MODES} fill label="Group activity" />
      <AppText variant="label">
        {selected === peak ? 'Busiest: ' : ''}
        {labels[selected]}, {activityValue(values[selected] ?? 0)}
      </AppText>
      <View
        style={{ height: PLOT_HEIGHT + AXIS_HEIGHT }}
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        {width > 0 ? (
          <Svg width={width} height={PLOT_HEIGHT + AXIS_HEIGHT}>
            {values.map((seconds, i) =>
              seconds > 0 ? (
                <Path
                  key={labels[i]}
                  d={barPath(
                    i * slot + BAR_GAP / 2,
                    slot - BAR_GAP,
                    Math.max(MIN_BAR_HEIGHT, (seconds / max) * PLOT_HEIGHT),
                  )}
                  fill={colors.accent}
                  fillOpacity={i === selected ? 1 : IDLE_BAR_OPACITY}
                />
              ) : null,
            )}
            <Line
              x1={0}
              x2={width}
              y1={PLOT_HEIGHT}
              y2={PLOT_HEIGHT}
              stroke={colors.hairline}
              strokeWidth={1}
            />
            {labels.map((label, i) =>
              i % labelEvery === 0 ? (
                <SvgText
                  key={label}
                  // Hour slots are narrow, so the first label would clip if centered.
                  x={labelEvery > 1 && i === 0 ? 0 : (i + 0.5) * slot}
                  y={PLOT_HEIGHT + AXIS_HEIGHT - 4}
                  fontSize={typeScale.caption.fontSize}
                  fontFamily={typeScale.caption.fontFamily}
                  fill={colors.textMuted}
                  textAnchor={labelEvery > 1 && i === 0 ? 'start' : 'middle'}
                >
                  {label}
                </SvgText>
              ) : null,
            )}
          </Svg>
        ) : null}
        <View style={styles.hitRow}>
          {values.map((seconds, i) => (
            <Pressable
              key={labels[i]}
              style={styles.hit}
              onPress={() => setPicked(i)}
              accessibilityRole="button"
              accessibilityLabel={`${labels[i]}: ${activityValue(seconds)}`}
              accessibilityState={{ selected: i === selected }}
            />
          ))}
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.md },
  hitRow: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, flexDirection: 'row' },
  hit: { flex: 1 },
})
