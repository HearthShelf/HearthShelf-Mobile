/**
 * Download-progress overlay for a book cover. Sits on top of <Cover> whenever
 * the item is queued or downloading: dims the artwork and draws a circular
 * progress ring with the percentage in the middle. Disappears once the download
 * finishes (or if it fails / isn't downloading).
 *
 * Subscribes to the downloads store itself so it stays live no matter which
 * screen the cover is on - callers only pass the item id.
 */
import { useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Svg, { Circle } from 'react-native-svg'
import { subscribeDownloads, getDownloadsState } from '@/player/downloads'
import { useColors } from './ThemeProvider'

export function CoverDownloadOverlay({
  itemId,
  size,
  radius,
}: {
  itemId: string
  /** Side length of the (square-ish) cover in px, used to scale the ring. */
  size: number
  /** Corner radius of the cover, so the dim layer matches its shape. */
  radius: number
}) {
  const colors = useColors()
  const entry = useSyncExternalStore(subscribeDownloads, getDownloadsState).byId.get(itemId)

  // Only in-flight downloads get the overlay. 'done' shows normal art; 'failed'
  // and absent show nothing (the actions sheet surfaces retry).
  if (!entry || (entry.status !== 'queued' && entry.status !== 'downloading')) return null

  // Ring scales with the cover but is clamped so tiny grid tiles stay legible
  // and big detail covers don't get a comically thick stroke.
  const ring = Math.max(28, Math.min(72, size * 0.42))
  const stroke = Math.max(3, Math.round(ring * 0.09))
  const r = (ring - stroke) / 2
  const circumference = 2 * Math.PI * r
  const frac = Math.max(0, Math.min(1, entry.progress))
  const pct = Math.round(frac * 100)
  const fontSize = Math.max(10, Math.round(ring * 0.24))

  return (
    <View
      style={[StyleSheet.absoluteFill, { borderRadius: radius, backgroundColor: colors.scrim }]}
      pointerEvents="none"
    >
      <View style={styles.center}>
        <View style={{ width: ring, height: ring, alignItems: 'center', justifyContent: 'center' }}>
          <Svg width={ring} height={ring} style={StyleSheet.absoluteFill}>
            <Circle cx={ring / 2} cy={ring / 2} r={r} fill="rgba(0,0,0,0.7)" />
            <Circle
              cx={ring / 2}
              cy={ring / 2}
              r={r}
              stroke={colors.fillStrong}
              strokeWidth={stroke}
              fill="none"
            />
            <Circle
              cx={ring / 2}
              cy={ring / 2}
              r={r}
              stroke={colors.accent}
              strokeWidth={stroke}
              strokeLinecap="round"
              fill="none"
              strokeDasharray={circumference}
              strokeDashoffset={circumference * (1 - frac)}
              // Start the arc at 12 o'clock instead of 3 o'clock.
              transform={`rotate(-90 ${ring / 2} ${ring / 2})`}
            />
          </Svg>
          <Text
            allowFontScaling={false}
            style={{ fontSize, fontWeight: '700', color: '#fff' }}
          >
            {`${pct}%`}
          </Text>
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  center: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
