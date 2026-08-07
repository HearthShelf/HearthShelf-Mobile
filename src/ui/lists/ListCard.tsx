/**
 * A browse tile for one list: a 2x2 stack of the first four covers, the name,
 * and the item count.
 *
 * Covers keep their real proportions via `Cover`'s aspectRatio - book art is
 * roughly 2:3, and squashing it into a square is instantly recognisable as
 * wrong. That makes the stack taller than it is wide, which the tile height
 * accounts for rather than fighting.
 *
 * Missing slots get a muted placeholder so a one-book list still reads as a
 * tile rather than a lone cover floating in a corner.
 */
import { memo } from 'react'
import { StyleSheet, View } from 'react-native'
import { coverHue, coverInitial } from '@hearthshelf/core'
import { coverUrl } from '@/api/abs'
import type { ListSummary } from '@/ui/lists/kind'
import { AppText, Cover, Touchable } from '@/ui/primitives'
import { Icon, type IconName } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

const STACK_SLOTS = 4

export const ListCard = memo(function ListCard({
  list,
  width,
  icon,
  itemNoun,
  onPress,
  onLongPress,
}: {
  list: ListSummary
  width: number
  icon: IconName
  /** "book" or "item" - collections hold books, playlists hold items. */
  itemNoun: string
  onPress: () => void
  onLongPress?: () => void
}) {
  const colors = useColors()
  const s = makeStyles(colors)
  const cell = (width - spacing.xs) / 2
  // Book art is ~2:3, so a row of two covers is 1.5 cells tall.
  const cellH = cell * 1.5
  const slots = Array.from({ length: STACK_SLOTS }, (_, i) => list.coverIds[i])
  // The count the tile is NOT showing art for.
  const extra = list.count - list.coverIds.length

  return (
    <Touchable
      onPress={onPress}
      onLongPress={onLongPress}
      style={[s.card, { width }]}
      accessibilityRole="button"
      accessibilityLabel={`${list.name}, ${list.count} ${list.count === 1 ? itemNoun : itemNoun + 's'}`}
    >
      <View style={[s.stack, { width, height: cellH * 2 + spacing.xs }]}>
        {slots.map((id, i) =>
          id ? (
            <Cover
              key={id + i}
              uri={coverUrl(id)}
              width={cell}
              aspectRatio={2 / 3}
              radius={0}
              fallback={{ hue: coverHue(id), initial: coverInitial(list.name) }}
            />
          ) : (
            <View key={'empty' + i} style={[s.empty, { width: cell, height: cellH }]}>
              {i === 0 ? <Icon name={icon} size={20} color={colors.textFaint} /> : null}
            </View>
          ),
        )}
        {extra > 0 ? (
          <View style={s.more}>
            <AppText variant="caption" color={colors.onAccent}>
              {`+${extra}`}
            </AppText>
          </View>
        ) : null}
      </View>
      <AppText variant="label" numberOfLines={1}>
        {list.name}
      </AppText>
      <AppText variant="caption" color={colors.textMuted}>
        {`${list.count} ${list.count === 1 ? itemNoun : itemNoun + 's'}`}
      </AppText>
    </Touchable>
  )
})

function makeStyles(c: Palette) {
  return StyleSheet.create({
    card: { gap: 2 },
    stack: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.xs,
      borderRadius: radius.tile,
      overflow: 'hidden',
      backgroundColor: c.fill,
      marginBottom: spacing.xs,
    },
    empty: { backgroundColor: c.fill, alignItems: 'center', justifyContent: 'center' },
    more: {
      position: 'absolute',
      right: spacing.xs,
      bottom: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: 2,
      borderRadius: radius.pill,
      backgroundColor: c.accent,
    },
  })
}
