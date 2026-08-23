/**
 * The answer-in-place controls on a "how was it?" notification row.
 *
 * The prompt is answered where it appears rather than by routing to the book:
 * a rating you have to navigate away to give is a rating most people abandon.
 * Five stars, Skip, and (behind the Skip) a way to turn the whole category off.
 *
 * The row auto-dismisses once a star lands: the question is answered, so
 * leaving it sitting in the tray would just be one more thing to clear. The
 * brief confirmation before it goes is what makes the disappearance read as
 * "saved" rather than "lost".
 */
import { useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { RATING_PROMPT_VALUES, ratingStarLabel, ratingSavedMessage } from '@hearthshelf/core'
import { AppText, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { haptics } from '@/ui/haptics'
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export interface RatingPromptActionsProps {
  /** Title, for screen-reader labels that would otherwise read "4 stars" with
   *  no indication of what is being rated. */
  bookTitle: string
  /** Persist the rating. Resolves false when the write failed, which keeps the
   *  row on screen instead of dismissing a rating that never saved. */
  onRate: (rating: number) => Promise<boolean>
  onSkip: () => void
  onStopAsking: () => void
}

export function RatingPromptActions({
  bookTitle,
  onRate,
  onSkip,
  onStopAsking,
}: RatingPromptActionsProps) {
  const colors = useColors()
  const s = makeStyles(colors)
  // The star currently being written, so it can fill immediately while the
  // request is in flight - an optimistic fill is the whole feedback signal on a
  // control that is about to vanish.
  const [pending, setPending] = useState(0)
  const [saved, setSaved] = useState(0)
  const [busy, setBusy] = useState(false)
  const [confirmingStop, setConfirmingStop] = useState(false)

  const rate = async (value: number) => {
    if (busy) return
    setBusy(true)
    setPending(value)
    haptics.select()
    const ok = await onRate(value)
    if (ok) {
      setSaved(value)
      return // Row is being dismissed by the parent; leave the fill in place.
    }
    // Failed: drop the optimistic fill so the row does not claim a score the
    // server never stored.
    setPending(0)
    setBusy(false)
  }

  const filled = saved || pending

  if (saved) {
    return (
      <View style={s.savedRow} accessibilityLiveRegion="polite">
        <Icon name={icons.star} size={18} color={colors.brandHearth} />
        <AppText variant="label" color={colors.brandHearth}>
          {ratingSavedMessage(saved)}
        </AppText>
      </View>
    )
  }

  return (
    <View style={s.wrap}>
      <View style={s.stars}>
        {RATING_PROMPT_VALUES.map((n) => (
          <Touchable
            key={n}
            onPress={() => void rate(n)}
            disabled={busy}
            style={s.star}
            hitSlop={4}
            accessibilityRole="button"
            accessibilityLabel={`Rate ${bookTitle} ${ratingStarLabel(n)}`}
          >
            <Icon
              name={n <= filled ? icons.star : icons.starOutline}
              size={30}
              color={n <= filled ? colors.brandHearth : colors.textFaint}
            />
          </Touchable>
        ))}
      </View>

      {confirmingStop ? (
        <View style={s.stopRow}>
          <AppText variant="caption" color={colors.textMuted} style={s.stopText}>
            Stop asking after you finish a book?
          </AppText>
          <View style={s.stopButtons}>
            <Touchable
              style={s.stopConfirm}
              onPress={onStopAsking}
              accessibilityRole="button"
              accessibilityLabel="Stop asking me to rate books"
            >
              <AppText variant="label" color={colors.onAccent}>
                Stop asking
              </AppText>
            </Touchable>
            <Touchable
              style={s.stopCancel}
              onPress={() => setConfirmingStop(false)}
              accessibilityRole="button"
              accessibilityLabel="Keep rating prompts"
            >
              <AppText variant="label">Keep</AppText>
            </Touchable>
          </View>
        </View>
      ) : (
        <View style={s.skipRow}>
          <Touchable
            style={s.skip}
            onPress={onSkip}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={`Skip rating ${bookTitle}`}
          >
            <AppText variant="label" color={colors.textMuted}>
              Skip rating
            </AppText>
          </Touchable>
          <Touchable
            style={s.skip}
            onPress={() => setConfirmingStop(true)}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel="Stop asking me to rate books"
          >
            <AppText variant="label" color={colors.textMuted}>
              Don’t ask again
            </AppText>
          </Touchable>
        </View>
      )}
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    wrap: { marginTop: spacing.sm, gap: spacing.xs },
    stars: { flexDirection: 'row', gap: spacing.xs, marginLeft: -4 },
    star: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
    skipRow: { flexDirection: 'row', gap: spacing.md, flexWrap: 'wrap' },
    skip: { minHeight: 44, justifyContent: 'center', paddingRight: spacing.sm },
    savedRow: {
      marginTop: spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      minHeight: 44,
    },
    stopRow: { gap: spacing.xs },
    stopText: { lineHeight: 18 },
    stopButtons: { flexDirection: 'row', gap: spacing.sm },
    stopConfirm: {
      minHeight: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      backgroundColor: colors.accent,
    },
    stopCancel: {
      minHeight: 44,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      borderWidth: 1,
      borderColor: colors.border,
    },
  })
