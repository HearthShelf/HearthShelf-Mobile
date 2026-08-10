/**
 * Rate / vote tray for an AI-shelf pick.
 *
 * The feedback controls used to live inline on the tile as 15-16px glyphs in a
 * ~150px-wide column - five stars packed into roughly a fingertip's width, which
 * is well under the 44pt minimum touch target and made mis-taps the norm. The
 * tile now shows the same state read-only and taps through to here, where the
 * stars and vote buttons get full-width rows with real hit areas.
 *
 * One instance serves the whole shelf: the parent holds a ref and calls
 * `present(item)` from each tile, exactly like BookActionsSheet.
 */
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { itemAuthor, itemTitle } from '@/api/abs'
import type { DiscoverFeedbackEntry, DiscoverVote } from '@/api/discover'
import { AppText, Sheet, type SheetRef, Touchable } from '@/ui/primitives'
import { Icon, icons, type IconName } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export interface DiscoverFeedbackHandle {
  present: (item: ABSLibraryItem) => void
}

export const DiscoverFeedbackSheet = forwardRef<
  DiscoverFeedbackHandle,
  {
    /** Current feedback for the open item, looked up by the parent so the tray
     *  reflects optimistic writes as they land. */
    feedbackFor: (itemId: string) => DiscoverFeedbackEntry | undefined
    /** The user's own star rating for the open item. Separate from feedback:
     *  a rating is about the BOOK, a vote is about the RECOMMENDATION. */
    ratingFor: (itemId: string) => number | undefined
    onVote: (item: ABSLibraryItem, vote: DiscoverVote) => void
    onRate: (item: ABSLibraryItem, rating: number) => void
    onNotInterested: (item: ABSLibraryItem) => void
  }
>(function DiscoverFeedbackSheet(
  { feedbackFor, ratingFor, onVote, onRate, onNotInterested },
  ref,
) {
  const colors = useColors()
  const s = useMemo(() => makeStyles(colors), [colors])
  const sheetRef = useRef<SheetRef>(null)
  const [item, setItem] = useState<ABSLibraryItem | null>(null)

  useImperativeHandle(ref, () => ({
    present: (next) => {
      setItem(next)
      sheetRef.current?.present()
    },
  }))

  const fb = (item ? feedbackFor(item.id) : undefined) ?? {}
  const rating = (item ? ratingFor(item.id) : undefined) ?? 0

  return (
    <Sheet
      ref={sheetRef}
      kicker="How's this pick?"
      title={item ? itemTitle(item) : ''}
      onDismiss={() => setItem(null)}
    >
      <View style={s.body}>
        {item ? (
          <AppText variant="meta" color={colors.textMuted}>
            {itemAuthor(item)}
          </AppText>
        ) : null}

        <View style={s.group}>
          <AppText variant="caption" color={colors.textFaint}>
            YOUR RATING
          </AppText>
          <View style={s.stars}>
            {[1, 2, 3, 4, 5].map((n) => (
              <Touchable
                key={n}
                onPress={() => {
                  if (!item) return
                  onRate(item, n)
                }}
                style={s.star}
                accessibilityRole="button"
                accessibilityLabel={`${n} star${n === 1 ? '' : 's'}`}
              >
                <Icon
                  name={n <= rating ? icons.star : icons.starOutline}
                  size={34}
                  color={n <= rating ? colors.brandHearth : colors.textFaint}
                />
              </Touchable>
            ))}
          </View>
          <AppText variant="caption" color={colors.textMuted}>
            {rating > 0 ? `${rating} of 5 - tap again to clear` : 'Tap a star to rate'}
          </AppText>
        </View>

        <View style={s.group}>
          <AppText variant="caption" color={colors.textFaint}>
            THIS PICK
          </AppText>
          <VoteRow
            icon={icons.thumbUp}
            label="More like this"
            active={fb.vote === 'like'}
            onPress={() => {
              if (!item) return
              onVote(item, 'like')
            }}
          />
          <VoteRow
            icon={icons.thumbDown}
            label="Less like this"
            active={fb.vote === 'dislike'}
            onPress={() => {
              if (!item) return
              onVote(item, 'dislike')
            }}
          />
          <VoteRow
            icon={icons.notInterested}
            label="Not interested"
            hint="Hides it from this shelf"
            active={fb.vote === 'not_interested'}
            onPress={() => {
              if (!item) return
              onNotInterested(item)
              sheetRef.current?.dismiss()
            }}
          />
        </View>
      </View>
    </Sheet>
  )
})

function VoteRow({
  icon,
  label,
  hint,
  active,
  onPress,
}: {
  icon: IconName
  label: string
  hint?: string
  active: boolean
  onPress: () => void
}) {
  const colors = useColors()
  const s = useMemo(() => makeStyles(colors), [colors])
  return (
    <Touchable
      onPress={onPress}
      style={[s.voteRow, active && { borderColor: colors.accent }]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={label}
    >
      <Icon name={icon} size={22} color={active ? colors.accent : colors.textMuted} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="body" color={active ? colors.accent : colors.text}>
          {label}
        </AppText>
        {hint ? (
          <AppText variant="caption" color={colors.textFaint}>
            {hint}
          </AppText>
        ) : null}
      </View>
      {active ? <Icon name={icons.check} size={18} color={colors.accent} /> : null}
    </Touchable>
  )
}

const makeStyles = (c: Palette) =>
  StyleSheet.create({
    body: { gap: spacing.lg, padding: spacing.lg },
    group: { gap: spacing.sm },
    stars: { flexDirection: 'row', justifyContent: 'space-between' },
    // 34px glyph + 8px padding clears the 44pt minimum target on its own.
    star: { paddingVertical: spacing.sm, paddingHorizontal: spacing.sm },
    voteRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 52,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      borderRadius: radius.row,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.hairline,
      backgroundColor: c.high,
    },
  })
