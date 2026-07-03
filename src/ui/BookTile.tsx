/**
 * Compact book tile for the 4-column library grid and search results. 2:3 cover
 * with title/author below, tap opens the item detail. Matches the web mobile
 * `.lib-grid .book` treatment.
 *
 * When a selection is active (long-press to begin), the tile shows a corner
 * checkbox and tapping toggles selection instead of opening the book.
 */
import { useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { coverHue, coverInitial } from '@hearthshelf/core'
import { coverUrl, itemAuthor, itemTitle } from '@/api/abs'
import { getSettingsState, subscribeSettings, COVER_ASPECT_RATIO } from '@/store/settings'
import { AppText, Cover } from './primitives'
import { SpringPressable } from './motion'
import { Icon, icons } from './icons'
import { radius, spacing } from './theme'
import { useColors } from './ThemeProvider'

export function BookTile({
  item,
  width,
  selecting = false,
  selected = false,
  onLongPress,
  onToggle,
}: {
  item: ABSLibraryItem
  width: number
  selecting?: boolean
  selected?: boolean
  onLongPress?: () => void
  onToggle?: () => void
}) {
  const router = useRouter()
  const colors = useColors()
  const { coverAspect } = useSyncExternalStore(subscribeSettings, getSettingsState)
  const title = itemTitle(item)
  return (
    <SpringPressable
      style={[styles.tile, { width }]}
      onPress={() => (selecting ? onToggle?.() : router.push(`/item/${item.id}`))}
      onLongPress={onLongPress}
      delayLongPress={300}
    >
      <View>
        <Cover
          uri={coverUrl(item.id)}
          itemId={item.id}
          width={width}
          aspectRatio={COVER_ASPECT_RATIO[coverAspect]}
          fallback={{ hue: coverHue(item.id), initial: coverInitial(title), title }}
        />
        {selecting ? (
          <View
            style={[
              styles.check,
              { borderColor: colors.text, backgroundColor: colors.scrim },
              selected && { backgroundColor: colors.accent, borderColor: colors.accent },
            ]}
          >
            {selected ? <Icon name={icons.check} size={16} color={colors.onAccent} /> : null}
          </View>
        ) : null}
        {selected ? (
          <View style={[styles.selOverlay, { borderColor: colors.accent }]} pointerEvents="none" />
        ) : null}
      </View>
      <View style={styles.meta}>
        <AppText variant="caption" numberOfLines={2}>
          {title}
        </AppText>
        <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
          {itemAuthor(item)}
        </AppText>
      </View>
    </SpringPressable>
  )
}

const styles = StyleSheet.create({
  tile: { marginBottom: spacing.md },
  meta: { marginTop: spacing.xs, gap: 1 },
  check: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: radius.tile,
    borderWidth: 2,
  },
})
