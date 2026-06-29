import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { coverUrl, getLibraryItemsPage, itemAuthor, itemTitle } from '@/api/abs'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { playItemById } from '@/player/playback'

const PAGE_SIZE = 50

export default function LibraryBrowseScreen() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()

  const [items, setItems] = useState<ABSLibraryItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Guard against overlapping page loads while a fetch is in flight.
  const nextPageRef = useRef(0)
  const loadingRef = useRef(false)

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

  const onEndReached = () => {
    if (items.length < total) void loadMore()
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.back}>{'< Back'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Library</Text>
      </View>
      {total > 0 || items.length > 0 ? (
        <Text style={styles.section}>
          {items.length} of {total} loaded
        </Text>
      ) : null}
      {loading && items.length === 0 ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : error && items.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(it) => it.id}
          contentContainerStyle={{ padding: 16 }}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            items.length < total ? (
              <View style={styles.footer}>
                <ActivityIndicator />
              </View>
            ) : null
          }
          renderItem={({ item }) => (
            <TouchableOpacity style={styles.row} onPress={() => playItemById(item.id)}>
              <Image source={{ uri: coverUrl(item.id) }} style={styles.cover} />
              <View style={styles.meta}>
                <Text style={styles.bookTitle} numberOfLines={2}>
                  {itemTitle(item)}
                </Text>
                <Text style={styles.bookAuthor} numberOfLines={1}>
                  {itemAuthor(item)}
                </Text>
              </View>
            </TouchableOpacity>
          )}
        />
      )}
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#14110f' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  back: { color: '#c4633a', fontSize: 15, fontWeight: '600' },
  title: { color: '#f3e9dd', fontSize: 22, fontWeight: '700' },
  section: { color: '#a99', fontSize: 13, paddingHorizontal: 16, paddingTop: 4 },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 8, alignItems: 'center' },
  cover: { width: 56, height: 56, borderRadius: 6, backgroundColor: '#332b25' },
  meta: { flex: 1 },
  bookTitle: { color: '#f3e9dd', fontSize: 16, fontWeight: '600' },
  bookAuthor: { color: '#a99', fontSize: 13, marginTop: 2 },
  footer: { paddingVertical: 16 },
  error: { color: '#e88', textAlign: 'center', paddingHorizontal: 24 },
})
