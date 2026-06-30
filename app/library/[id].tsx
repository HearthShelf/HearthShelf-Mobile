import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, StyleSheet, View, useWindowDimensions } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { letterOf } from '@hearthshelf/core'
import { getLibraryItemsPage, itemTitle } from '@/api/abs'
import { AppText, Centered, IconButton, Loading, Screen, icons } from '@/ui/primitives'
import { BookTile } from '@/ui/BookTile'
import { AzRail } from '@/ui/AzRail'
import { colors, spacing } from '@/ui/theme'

const PAGE_SIZE = 50
const COLS = 3
const GUTTER = spacing.lg

export default function LibraryBrowseScreen() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const { width } = useWindowDimensions()

  const [items, setItems] = useState<ABSLibraryItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const listRef = useRef<FlatList<ABSLibraryItem>>(null)
  const nextPageRef = useRef(0)
  const loadingRef = useRef(false)

  // Tile width: full width minus side gutters and inter-column gaps, / COLS.
  const tileWidth = (width - GUTTER * 2 - GUTTER * (COLS - 1)) / COLS

  const loadMore = useCallback(async () => {
    if (!id || loadingRef.current) return
    loadingRef.current = true
    try {
      const page = await getLibraryItemsPage(id, nextPageRef.current, PAGE_SIZE)
      setItems((prev) => [...prev, ...page.results])
      setTotal(page.total)
      nextPageRef.current += 1
    } catch (e) {
      setError((e as Error).message)
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    void loadMore()
  }, [loadMore])

  // First loaded-item index per letter bucket, for the A-Z rail.
  const letterIndex = useMemo(() => {
    const map = new Map<string, number>()
    items.forEach((it, i) => {
      const l = letterOf(itemTitle(it))
      if (!map.has(l)) map.set(l, i)
    })
    return map
  }, [items])

  const available = useMemo(() => new Set(letterIndex.keys()), [letterIndex])

  const onJump = useCallback(
    (letter: string) => {
      const idx = letterIndex.get(letter)
      if (idx == null) return
      // FlatList numColumns indexes by item; scroll to the row containing it.
      listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0 })
    },
    [letterIndex]
  )

  return (
    <Screen>
      <View style={styles.header}>
        <IconButton name={icons.back} onPress={() => router.back()} />
        <AppText variant="hero">Library</AppText>
      </View>

      {loading && items.length === 0 ? (
        <Loading />
      ) : error && items.length === 0 ? (
        <Centered>
          <AppText variant="meta" color={colors.destructive}>
            {error}
          </AppText>
        </Centered>
      ) : (
        <View style={{ flex: 1 }}>
          <FlatList
            ref={listRef}
            data={items}
            keyExtractor={(it) => it.id}
            numColumns={COLS}
            columnWrapperStyle={{ gap: GUTTER }}
            contentContainerStyle={{ padding: GUTTER, paddingBottom: 140, gap: spacing.xs }}
            onEndReached={() => {
              if (items.length < total) void loadMore()
            }}
            onEndReachedThreshold={0.6}
            onScrollToIndexFailed={({ index }) => {
              // Item not yet measured: nudge near it, then retry once laid out.
              listRef.current?.scrollToOffset({
                offset: Math.floor(index / COLS) * (tileWidth * 1.5 + spacing.md),
                animated: true,
              })
            }}
            renderItem={({ item }) => <BookTile item={item} width={tileWidth} />}
          />
          <AzRail available={available} onJump={onJump} />
        </View>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
})
