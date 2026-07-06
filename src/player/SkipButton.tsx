/**
 * Rewind / forward transport button whose numeral matches the user's chosen skip
 * amount (any value the settings slider allows, not a stuck "10" / "30"). A plain
 * circular-arrow glyph is mirrored for the forward direction, with the exact
 * seconds centered inside the ring. Three-digit amounts (100+) shrink the numeral
 * so they still fit.
 *
 * Used on the full player and the mini-player, sized via the `size` prop.
 */
import { StyleSheet, Text, View } from 'react-native'
import { Icon, icons } from '@/ui/icons'
import { SpringPressable } from '@/ui/motion'

export function SkipButton({
  dir,
  seconds,
  size = 34,
  color,
  onPress,
}: {
  dir: -1 | 1
  seconds: number
  size?: number
  color: string
  onPress: () => void
}) {
  const label = String(seconds)
  // Numeral scales with the icon; a touch smaller for three digits to fit the ring.
  const fontSize = Math.round(size * (label.length >= 3 ? 0.3 : 0.36))
  // Square footprint sized off the icon so buttons space evenly in a transport row.
  const box = Math.round(size * 1.6)
  // The replay glyph's arrowhead notches the top of the ring, so drop the numeral
  // slightly (scaled with the icon) to sit centered in the ring below it.
  const nudge = size * 0.09
  return (
    <SpringPressable
      onPress={onPress}
      hitSlop={10}
      style={[styles.btn, { width: box, height: box }]}
      scaleTo={0.85}
    >
      <Icon name={icons.replay} size={size} color={color} style={dir > 0 ? styles.mirror : undefined} />
      <View pointerEvents="none" style={[styles.numeralWrap, { paddingTop: nudge }]}>
        <Text allowFontScaling={false} style={[styles.numeral, { color, fontSize }]}>
          {label}
        </Text>
      </View>
    </SpringPressable>
  )
}

const styles = StyleSheet.create({
  btn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  mirror: {
    transform: [{ scaleX: -1 }],
  },
  numeralWrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  numeral: {
    fontWeight: '800',
  },
})
