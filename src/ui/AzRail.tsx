/**
 * Vertical A-Z jump rail, pinned to the right edge (mobile-only affordance from
 * the web library). Tap or drag a letter to jump the list to the first item in
 * that letter bucket. Letters with no items are dimmed and non-interactive.
 */
import { useRef } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, radius } from './theme'

const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')]

export function AzRail({
  available,
  onJump,
}: {
  /** Set of letters that have at least one item. */
  available: Set<string>
  /** Called with the chosen letter when the finger lands on / drags over it. */
  onJump: (letter: string) => void
}) {
  const railHeight = useRef(0)
  const lastLetter = useRef<string | null>(null)

  // locationY is relative to the rail view, so map it directly onto the letters.
  const pick = (locationY: number) => {
    const height = railHeight.current
    if (height <= 0) return
    const rel = Math.max(0, Math.min(height, locationY))
    const idx = Math.min(LETTERS.length - 1, Math.floor((rel / height) * LETTERS.length))
    const letter = LETTERS[idx]
    if (letter === lastLetter.current) return
    lastLetter.current = letter
    if (available.has(letter)) onJump(letter)
  }

  return (
    <View
      style={styles.rail}
      onLayout={(e) => {
        railHeight.current = e.nativeEvent.layout.height
      }}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={(e) => {
        lastLetter.current = null
        pick(e.nativeEvent.locationY)
      }}
      onResponderMove={(e) => pick(e.nativeEvent.locationY)}
      onResponderRelease={() => {
        lastLetter.current = null
      }}
    >
      {LETTERS.map((l) => (
        <Text
          key={l}
          style={[styles.letter, !available.has(l) && styles.letterEmpty]}
        >
          {l}
        </Text>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  rail: {
    position: 'absolute',
    right: 2,
    top: '50%',
    transform: [{ translateY: -220 }],
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.fillStrong,
    alignItems: 'center',
  },
  letter: {
    fontSize: 10,
    lineHeight: 15,
    fontWeight: '700',
    color: colors.text,
  },
  letterEmpty: { color: colors.textFaint, opacity: 0.4 },
})
