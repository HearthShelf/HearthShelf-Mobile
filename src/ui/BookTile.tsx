/**
 * Compact book tile for the 4-column library grid and search results. 2:3 cover
 * with title/author below, tap opens the item detail. Matches the web mobile
 * `.lib-grid .book` treatment.
 */
import { useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { coverHue, coverInitial } from '@hearthshelf/core'
import { coverUrl, itemAuthor, itemTitle } from '@/api/abs'
import { getSettingsState, subscribeSettings, COVER_ASPECT_RATIO } from '@/store/settings'
import { AppText, Cover } from './primitives'
import { colors, spacing } from './theme'

export function BookTile({ item, width }: { item: ABSLibraryItem; width: number }) {
  const router = useRouter()
  const { coverAspect } = useSyncExternalStore(subscribeSettings, getSettingsState)
  const title = itemTitle(item)
  return (
    <Pressable
      style={[styles.tile, { width }]}
      onPress={() => router.push(`/item/${item.id}`)}
    >
      <Cover
        uri={coverUrl(item.id)}
        width={width}
        aspectRatio={COVER_ASPECT_RATIO[coverAspect]}
        fallback={{ hue: coverHue(item.id), initial: coverInitial(title), title }}
      />
      <View style={styles.meta}>
        <AppText variant="caption" numberOfLines={2}>
          {title}
        </AppText>
        <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
          {itemAuthor(item)}
        </AppText>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  tile: { marginBottom: spacing.md },
  meta: { marginTop: spacing.xs, gap: 1 },
})
