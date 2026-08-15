/**
 * An AI-shelf tile on Discover: the standard BookTile plus the reason the shelf
 * picked this book and its current feedback state. The feedback drives next
 * month's generation and the ranking of every other Discover row, so it's worth
 * the extra height on this one shelf.
 *
 * The stars and vote glyphs here are DISPLAY ONLY. A tile is roughly 150px wide,
 * so five inline stars land at ~15px each - far under the 44pt minimum touch
 * target, and mis-taps were the norm. The whole strip is one button that opens
 * DiscoverFeedbackSheet, where the same controls get real hit areas.
 */
import { StyleSheet, View } from 'react-native'
import type { ABSLibraryItem } from '@hearthshelf/core'
import type { DiscoverFeedbackEntry } from '@/api/discover'
import { AppText, Touchable } from '@/ui/primitives'
import { BookTile } from '@/ui/BookTile'
import { Icon, icons } from '@/ui/icons'
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

const VOTE_ICON = {
  like: icons.thumbUp,
  dislike: icons.thumbDown,
  not_interested: icons.notInterested,
} as const

export function DiscoverAiTile({
  item,
  reason,
  width,
  from,
  progress,
  finished,
  feedback,
  rating: ratingProp,
  onOpenFeedback,
  onQuickPlay,
  onLongPress,
}: {
  item: ABSLibraryItem
  reason?: string
  width: number
  from?: string
  progress?: number
  finished?: boolean
  feedback?: DiscoverFeedbackEntry
  /** The user's own star rating. Separate from feedback: a rating is about the
   *  BOOK, a Discover vote is about the RECOMMENDATION. */
  rating?: number
  /** Opens the feedback tray for this pick. */
  onOpenFeedback: () => void
  onQuickPlay?: () => void
  onLongPress?: () => void
}) {
  const colors = useColors()
  const styles = makeStyles(colors)
  const fb = feedback ?? {}
  const rating = ratingProp ?? 0
  const voted = fb.vote ? VOTE_ICON[fb.vote] : null

  return (
    <View style={{ width }}>
      <BookTile
        item={item}
        width={width}
        from={from}
        progress={progress}
        finished={finished}
        onQuickPlay={onQuickPlay}
        onLongPress={onLongPress}
      />
      {reason ? (
        <AppText variant="caption" color={colors.textMuted} numberOfLines={2} style={styles.why}>
          {reason}
        </AppText>
      ) : null}

      <Touchable
        onPress={onOpenFeedback}
        style={styles.bar}
        accessibilityRole="button"
        accessibilityLabel={
          rating > 0
            ? `Rated ${rating} of 5. Rate or vote on this pick`
            : 'Rate or vote on this pick'
        }
      >
        <View style={styles.stars}>
          {[1, 2, 3, 4, 5].map((n) => (
            <Icon
              key={n}
              name={n <= rating ? icons.star : icons.starOutline}
              size={15}
              color={n <= rating ? colors.brandHearth : colors.textFaint}
            />
          ))}
        </View>
        {voted ? <Icon name={voted} size={14} color={colors.accent} /> : null}
        <Icon name={icons.chevronRight} size={14} color={colors.textFaint} />
      </Touchable>
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    why: { marginTop: 2 },
    // The whole strip is the tap target for the feedback tray, so it carries a
    // full-height row rather than the 2px padding the old inline glyphs had.
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      minHeight: 44,
      marginTop: spacing.xs,
      paddingTop: spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
    },
    stars: { flexDirection: 'row', alignItems: 'center', gap: 1, flex: 1 },
  })
