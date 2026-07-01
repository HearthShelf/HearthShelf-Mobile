/**
 * Series / Author / Narrator drilldown: a 2-col grid of that group's books with
 * a back header, opened from the Library screen's Series/Narrators/Authors view
 * (plan section 4, "group drilldown").
 *
 * Series and Authors have direct ABS reads (series carries its books; the
 * author-detail endpoint includes libraryItems). Narrators have no "books by
 * narrator" endpoint - ABS derives narrators from item metadata - so this
 * fetches the whole library and filters by narrator credit client-side.
 */
import { useEffect, useState } from 'react'
import { FlatList, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { coverHue } from '@hearthshelf/core'
import {
  coverUrl,
  getAuthorDetail,
  getLibraryItemsPage,
  getLibrarySeries,
  itemNarrator,
  itemTitle,
} from '@/api/abs'
import { AppText, Centered, Cover, IconButton, Loading, Screen, icons } from '@/ui/primitives'
import { colors, radius, spacing } from '@/ui/theme'

type GroupType = 'series' | 'authors' | 'narrators'

const KIND_LABEL: Record<GroupType, string> = {
  series: 'Series',
  authors: 'Author',
  narrators: 'Narrated by',
}

export default function GroupDrilldown() {
  const router = useRouter()
  const { type, key, libraryId, name } = useLocalSearchParams<{
    type: GroupType
    key: string
    libraryId: string
    name: string
  }>()

  const [books, setBooks] = useState<ABSLibraryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setBooks(null)
    setError(null)
    void (async () => {
      try {
        let result: ABSLibraryItem[] = []
        if (type === 'series') {
          const series = await getLibrarySeries(libraryId)
          result = series.find((s) => s.id === key)?.books ?? []
        } else if (type === 'authors') {
          const detail = await getAuthorDetail(key)
          result = detail.libraryItems ?? []
        } else {
          // Narrators: fetch every item in the library (limit=0 via a single
          // large page) and filter by narrator credit substring match, since
          // ABS stores narrators as a free-text comma-joined field.
          const page = await getLibraryItemsPage(libraryId, 0, 0)
          const target = decodeURIComponent(name).toLowerCase()
          result = page.results.filter((it) => itemNarrator(it).toLowerCase().includes(target))
        }
        if (!cancelled) setBooks(result)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [type, key, libraryId, name])

  return (
    <Screen>
      <View style={styles.header}>
        <IconButton name={icons.back} onPress={() => router.back()} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="caption" color={colors.textMuted}>
            {KIND_LABEL[type]?.toUpperCase()}
          </AppText>
          <AppText variant="hero" numberOfLines={1}>
            {decodeURIComponent(name ?? '')}
          </AppText>
        </View>
      </View>

      {error ? (
        <Centered>
          <AppText variant="meta" color={colors.destructive}>
            {error}
          </AppText>
        </Centered>
      ) : !books ? (
        <Loading />
      ) : (
        <>
          <AppText variant="meta" color={colors.textMuted} style={styles.sub}>
            {books.length} {books.length === 1 ? 'title' : 'titles'}
          </AppText>
          <GroupGrid books={books} />
        </>
      )}
    </Screen>
  )
}

function GroupGrid({ books }: { books: ABSLibraryItem[] }) {
  const { width } = useWindowDimensions()
  const cardWidth = (width - spacing.lg * 2 - spacing.md) / 2

  return (
    <FlatList
      data={books}
      keyExtractor={(b) => b.id}
      numColumns={2}
      columnWrapperStyle={{ gap: spacing.md }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140, gap: spacing.lg }}
      renderItem={({ item }) => <GroupBookCard item={item} width={cardWidth} />}
    />
  )
}

function GroupBookCard({ item, width }: { item: ABSLibraryItem; width: number }) {
  const router = useRouter()
  const title = itemTitle(item)
  return (
    <Pressable style={{ width }} onPress={() => router.push(`/item/${item.id}`)}>
      <Cover
        uri={coverUrl(item.id)}
        width={width}
        aspectRatio={1}
        radius={radius.card}
        fallback={{ hue: coverHue(item.id), initial: title.charAt(0).toUpperCase(), title }}
      />
      <AppText variant="label" numberOfLines={1} style={{ marginTop: spacing.sm }}>
        {title}
      </AppText>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  sub: { paddingHorizontal: spacing.lg },
})
