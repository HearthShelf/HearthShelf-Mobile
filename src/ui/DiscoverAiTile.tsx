/**
 * An AI-shelf tile on Discover: the standard BookTile plus the reason the shelf
 * picked this book and a compact feedback bar (thumb up/down, 1-5 stars, not
 * interested). The feedback drives next month's generation and the ranking of
 * every other Discover row, so it's worth the extra height on this one shelf.
 */
import { StyleSheet, View } from 'react-native'
import type { ABSLibraryItem } from '@hearthshelf/core'
import type { DiscoverFeedbackEntry, DiscoverVote } from '@/api/discover'
import { AppText, Touchable } from '@/ui/primitives'
import { BookTile } from '@/ui/BookTile'
import { Icon, icons } from '@/ui/icons'
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export function DiscoverAiTile({
  item,
  reason,
  width,
  from,
  progress,
  finished,
  feedback,
  onVote,
  onRate,
  onNotInterested,
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
  onVote: (vote: DiscoverVote) => void
  onRate: (rating: number) => void
  onNotInterested: () => void
  onQuickPlay?: () => void
  onLongPress?: () => void
}) {
  const colors = useColors()
  const styles = makeStyles(colors)
  const fb = feedback ?? {}
  const rating = fb.rating ?? 0

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

      <View style={styles.bar}>
        <Touchable onPress={() => onVote('like')} hitSlop={6} style={styles.btn}>
          <Icon
            name={icons.thumbUp}
            size={16}
            color={fb.vote === 'like' ? colors.accent : colors.textFaint}
          />
        </Touchable>
        <Touchable onPress={() => onVote('dislike')} hitSlop={6} style={styles.btn}>
          <Icon
            name={icons.thumbDown}
            size={16}
            color={fb.vote === 'dislike' ? colors.accent : colors.textFaint}
          />
        </Touchable>
        <Touchable onPress={onNotInterested} hitSlop={6} style={styles.btn}>
          <Icon
            name={icons.notInterested}
            size={16}
            color={fb.vote === 'not_interested' ? colors.accent : colors.textFaint}
          />
        </Touchable>
      </View>

      <View style={styles.stars}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Touchable key={n} onPress={() => onRate(n)} hitSlop={4}>
            <Icon
              name={n <= rating ? icons.star : icons.starOutline}
              size={15}
              color={n <= rating ? colors.brandHearth : colors.textFaint}
            />
          </Touchable>
        ))}
      </View>
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    why: { marginTop: 2 },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.xs,
      paddingTop: spacing.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
    },
    btn: { paddingVertical: 2 },
    stars: { flexDirection: 'row', alignItems: 'center', gap: 1, marginTop: 2 },
  })
