/**
 * Typeset duotone cover - the fallback shown when a book has no real ABS
 * artwork (or it hasn't loaded). Ports the design system's cover treatment: a
 * single hue rendered as a diagonal duotone with a faint oversized initial in
 * the corner, and an optional kicker/title. Real artwork is always preferred
 * (plan section 0.4 #1); this only fills the gap.
 *
 * The hue also drives the cover-glow, so callers derive it once (coverHue) and
 * pass it to both this and <CoverGlow>.
 */
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { colors } from './theme'

/** Darken a #rrggbb hex toward black by `amount` (0..1). */
function darken(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  const f = (c: number) => Math.max(0, Math.round(c * (1 - amount)))
  const to2 = (c: number) => c.toString(16).padStart(2, '0')
  return `#${to2(f(r))}${to2(f(g))}${to2(f(b))}`
}

export function TypesetCover({
  hue,
  initial,
  kicker,
  title,
  radius = 10,
  style,
}: {
  hue: string
  initial: string
  kicker?: string
  title?: string
  radius?: number
  style?: StyleProp<ViewStyle>
}) {
  // DS: linear-gradient(155deg, mix(cv, #000 ~8%), mix(cv, #07060a ~52%)).
  const top = darken(hue, 0.08)
  const bottom = darken(hue, 0.55)
  return (
    <View style={[styles.wrap, { borderRadius: radius }, style]}>
      <LinearGradient
        colors={[top, bottom]}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Text style={styles.initial} numberOfLines={1} allowFontScaling={false}>
        {initial}
      </Text>
      {(kicker || title) && (
        <View style={styles.meta}>
          {kicker ? (
            <Text style={styles.kicker} numberOfLines={1}>
              {kicker.toUpperCase()}
            </Text>
          ) : null}
          {title ? (
            <Text style={styles.title} numberOfLines={2}>
              {title}
            </Text>
          ) : null}
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { overflow: 'hidden', justifyContent: 'flex-end' },
  // Faint oversized initial, bleeding off the bottom-right corner.
  initial: {
    position: 'absolute',
    right: '-6%',
    bottom: '-14%',
    fontSize: 120,
    fontWeight: '800',
    lineHeight: 120,
    color: 'rgba(255,255,255,0.12)',
  },
  meta: { padding: 11, gap: 3 },
  kicker: {
    fontSize: 7,
    letterSpacing: 1.2,
    fontWeight: '600',
    color: 'rgba(255,255,255,0.6)',
  },
  title: {
    fontSize: 11.5,
    fontWeight: '700',
    lineHeight: 13,
    color: colors.brandShelf,
  },
})
