/**
 * Compact book tile for the 4-column library grid and search results. 2:3 cover
 * with title/author below, tap opens the item detail. Matches the web mobile
 * `.lib-grid .book` treatment.
 *
 * When a selection is active (long-press to begin), the tile shows a corner
 * checkbox and tapping toggles selection instead of opening the book.
 */
import { useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
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
  progress,
  finished = false,
  onQuickPlay,
  onLongPress,
  onToggle,
}: {
  item: ABSLibraryItem
  width: number
  selecting?: boolean
  selected?: boolean
  /** Listening progress 0..1. When 0<p<1, a thin bar shows under the cover. */
  progress?: number
  /** Marks the book done: an accent check badge sits top-right of the cover. */
  finished?: boolean
  /** When set AND the book is in progress, a play chip appears bottom-right of
   *  the cover. Tapping it plays without opening detail. */
  onQuickPlay?: () => void
  onLongPress?: () => void
  onToggle?: () => void
}) {
  const router = useRouter()
  const colors = useColors()
  const { coverAspect } = useSyncExternalStore(subscribeSettings, getSettingsState)
  const title = itemTitle(item)
  const inProgress = progress != null && progress > 0 && progress < 1
  const showChip = !selecting && !!onQuickPlay && inProgress
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
          showDownloadBadge
        />
        {finished && !selecting ? (
          <View style={[styles.finBadge, { backgroundColor: colors.accent }]} pointerEvents="none">
            <Icon name={icons.check} size={13} color={colors.onAccent} />
          </View>
        ) : null}
        {showChip ? (
          <Pressable
            onPress={(e) => {
              e.stopPropagation()
              onQuickPlay?.()
            }}
            hitSlop={6}
            style={({ pressed }) => [
              styles.playChip,
              { backgroundColor: colors.scrim, borderColor: colors.hairline },
              pressed && styles.playChipPressed,
            ]}
          >
            <Icon name={icons.play} size={18} color="#fff" />
          </Pressable>
        ) : null}
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
      {inProgress ? (
        <View style={[styles.track, { backgroundColor: colors.fillStrong }]}>
          <View
            style={[styles.trackFill, { width: `${progress! * 100}%`, backgroundColor: colors.accent }]}
          />
        </View>
      ) : null}
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
  // Progress bar under the cover (Continue shelf treatment: 3px .track).
  track: {
    marginTop: 7,
    height: 3,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  trackFill: { height: '100%', borderRadius: radius.pill },
  // Circular quick-play chip, bottom-right of the cover (the web .playchip).
  playChip: {
    position: 'absolute',
    right: 7,
    bottom: 7,
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playChipPressed: { opacity: 0.7 },
  // Finished badge: accent circle + check, top-right of the cover.
  finBadge: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
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
