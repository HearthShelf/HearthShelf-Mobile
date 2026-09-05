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
import { useEffect, useSyncExternalStore } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { PULSE_MS } from './motion'

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
  strength,
  height = 360,
  mode = 'gradient',
  breathe = false,
  style,
}: {
  hue: string
  /** 0-100, mirrors the DS --glow-strength (60 dark). Scales peak opacity.
   *  Omit to follow the user's `glow` setting, which is the normal case - it is
   *  account-scoped and shared with the web app, so the slider in Appearance
   *  moves the bloom on every surface. Pass a value only to hold a surface
   *  deliberately dimmer than the user's pick (a hero behind dense text). */
  strength?: number
  /** How far down the bloom reaches, px. */
  height?: number
  mode?: GlowMode
  /** Slow opacity pulse on the splash glow's period - a live hearth, for the
   *  player. Leave off for browse surfaces. */
  breathe?: boolean
  style?: StyleProp<ViewStyle>
}) {
  // Flat/OLED sets the glow to 0 and removes the atmosphere entirely, so any
  // effect built on the bloom must still read with it off (DESIGN.shared.md,
  // "The Flat-Theme Rule").
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)
  const effectiveStrength = strength ?? s.glow

  // Peak opacity from strength: 60 -> ~0.34, clamped so it stays a tint.
  const peak = Math.max(0, Math.min(0.6, (effectiveStrength / 100) * 0.56))

  const pulse = useSharedValue(1)
  useEffect(() => {
    if (!breathe) {
      pulse.value = 1
      return
    }
    pulse.value = withRepeat(
      withTiming(0.72, { duration: PULSE_MS, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    )
  }, [breathe, pulse])
  const breathing = useAnimatedStyle(() => ({ opacity: pulse.value }))

  // `mode='image'` falls back to gradient until the blurred-PNG asset exists.
  return (
    <View pointerEvents="none" style={[styles.wrap, { height }, style]}>
      <Animated.View style={[StyleSheet.absoluteFill, breathing]}>
        <LinearGradient
          colors={[withAlpha(hue, peak), withAlpha(hue, peak * 0.4), 'transparent']}
          locations={[0, 0.4, 1]}
          start={{ x: 0.5, y: 0 }}
          end={{ x: 0.5, y: 1 }}
          style={StyleSheet.absoluteFill}
        />
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0 },
})
