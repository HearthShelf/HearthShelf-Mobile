/**
 * The signature cover-glow: a soft bloom of the now-playing (or focused) book's
 * hue falling from the top of a surface. Reused on the Home hero, book detail,
 * the player, and behind the mini-player. The hue comes from the book's real
 * artwork palette or the typeset fallback (coverHue), so color flows from the
 * art, not a fixed accent.
 *
 * RN has no radial-gradient, so `mode='gradient'` (default) approximates the
 * top-down radial bloom with a vertical LinearGradient from a translucent hue to
 * transparent. `mode='image'` is reserved for a pre-blurred PNG bloom (a
 * quality/appearance option per plan section 0.4 #3); until that asset ships it
 * falls back to the gradient renderer.
 */
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'

export type GlowMode = 'gradient' | 'image'

/** Convert #rrggbb + alpha (0..1) to an rgba() string. */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 0xff
  const g = (n >> 8) & 0xff
  const b = n & 0xff
  return `rgba(${r},${g},${b},${alpha})`
}

export function CoverGlow({
  hue,
  strength = 60,
  height = 360,
  mode = 'gradient',
  style,
}: {
  hue: string
  /** 0-100, mirrors the DS --glow-strength (60 dark). Scales peak opacity. */
  strength?: number
  /** How far down the bloom reaches, px. */
  height?: number
  mode?: GlowMode
  style?: StyleProp<ViewStyle>
}) {
  // Peak opacity from strength: 60 -> ~0.34, clamped so it stays a tint.
  const peak = Math.max(0, Math.min(0.6, (strength / 100) * 0.56))
  // `mode='image'` falls back to gradient until the blurred-PNG asset exists.
  return (
    <View pointerEvents="none" style={[styles.wrap, { height }, style]}>
      <LinearGradient
        colors={[withAlpha(hue, peak), withAlpha(hue, peak * 0.4), 'transparent']}
        locations={[0, 0.4, 1]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0 },
})
