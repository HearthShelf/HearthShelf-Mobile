/**
 * Vertical A-Z jump rail, pinned to the right edge (mobile-only affordance from
 * the web library). Press or drag anywhere in the rail column to jump the list to
 * the first item in that letter's bucket; a floating bubble previews the current
 * letter while the finger is down so you can drag up and down the alphabet.
 * Letters with no items are dimmed and skipped.
 */
import { useRef, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { colors, fonts, radius, spacing } from './theme'

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
  // The letter currently under the finger (drives the preview bubble + highlight).
  const [active, setActive] = useState<string | null>(null)
  // Y of the finger within the rail, so the bubble sits beside it (not centered).
  const [bubbleY, setBubbleY] = useState(0)
  const BUBBLE = 64

  // locationY is relative to the rail view, so map it directly onto the letters.
  const pick = (locationY: number) => {
    const height = railHeight.current
    if (height <= 0) return
    // Ignore stray out-of-range samples (fast drags / finger leaving the column)
    // instead of clamping - clamping to 0 was yanking the list to "#" mid-scroll.
    if (locationY < 0 || locationY > height) return
    const idx = Math.min(LETTERS.length - 1, Math.floor((locationY / height) * LETTERS.length))
    const letter = LETTERS[idx]
    // Keep the bubble tracking the finger even when the letter doesn't change.
    setBubbleY(Math.max(BUBBLE / 2, Math.min(height - BUBBLE / 2, locationY)))
    if (letter === lastLetter.current) return
    lastLetter.current = letter
    setActive(letter)
    if (available.has(letter)) onJump(letter)
  }

  const end = () => {
    lastLetter.current = null
    setActive(null)
  }

  return (
    <View style={styles.zone} pointerEvents="box-none">
      {active ? (
        <View style={[styles.bubble, { top: bubbleY - BUBBLE / 2 }]} pointerEvents="none">
          <Text style={styles.bubbleText}>{active}</Text>
        </View>
      ) : null}
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
        onResponderRelease={end}
        onResponderTerminate={end}
      >
        {LETTERS.map((l) => (
          <Text
            key={l}
            style={[
              styles.letter,
              !available.has(l) && styles.letterEmpty,
              active === l && available.has(l) && styles.letterActive,
            ]}
          >
            {l}
          </Text>
        ))}
      </View>
    </View>
  )
}

/** Width the rail reserves on the right edge; the grid pads by this so covers
 *  never sit under the letters. */
export const AZ_RAIL_WIDTH = 28

const styles = StyleSheet.create({
  // Anchored strip down the right edge (top/bottom insets, not a magic offset).
  zone: {
    position: 'absolute',
    right: 0,
    top: 8,
    bottom: 8,
    width: AZ_RAIL_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // The touch target: a full-height column wide enough to hit comfortably.
  rail: {
    flex: 1,
    width: AZ_RAIL_WIDTH,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.fillStrong,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  letter: {
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '700',
    fontFamily: fonts.mono,
    color: colors.textMuted,
  },
  letterEmpty: { color: colors.textFaint, opacity: 0.35 },
  letterActive: { color: colors.accent, fontWeight: '800' },
  // Big preview to the left of the rail; `top` is set inline to track the finger.
  bubble: {
    position: 'absolute',
    right: AZ_RAIL_WIDTH + spacing.sm,
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  bubbleText: {
    fontSize: 30,
    fontWeight: '800',
    fontFamily: fonts.mono,
    color: colors.onAccent,
  },
})
