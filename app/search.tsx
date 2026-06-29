import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  FlatList,
  Image,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { coverUrl, getLibraries, itemAuthor, itemTitle, searchLibrary } from '@/api/abs'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { playItemById } from '@/player/playback'

export default function SearchScreen() {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ABSLibraryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)

  // The search endpoint is per-library; resolve the first book library once.
  const libraryIdRef = useRef<string | null>(null)
  async function resolveLibraryId(): Promise<string | null> {
    if (libraryIdRef.current) return libraryIdRef.current
    const libs = await getLibraries()
    const lib = libs.find((l) => l.mediaType === 'book') ?? libs[0]
    libraryIdRef.current = lib?.id ?? null
    return libraryIdRef.current
  }

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) {
      setResults([])
      setSearched(false)
      setLoading(false)
      return
    }
    setLoading(true)
    try {
      const libraryId = await resolveLibraryId()
      if (!libraryId) {
        setResults([])
        return
      }
      const list = await searchLibrary(libraryId, trimmed)
      setResults(list)
    } catch {
      setResults([])
    } finally {
      setSearched(true)
      setLoading(false)
    }
  }, [])

  // Debounce input ~350ms so we don't fire a request per keystroke.
  useEffect(() => {
    const handle = setTimeout(() => void runSearch(query), 350)
    return () => clearTimeout(handle)
  }, [query, runSearch])

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.back}>{'< Back'}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Search</Text>
      </View>
      <TextInput
        style={styles.input}
        value={query}
        onChangeText={setQuery}
        placeholder="Search books"
        placeholderTextColor="#a99"
        autoCorrect={false}
        autoCapitalize="none"
        autoFocus
      />
      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : searched && results.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.dim}>No results</Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(it) => it.id}
          contentContainerStyle={{ padding: 16 }}
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
  input: {
    margin: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: '#221d19',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: '#3a322c',
    color: '#f3e9dd',
    fontSize: 16,
  },
  row: { flexDirection: 'row', gap: 12, paddingVertical: 8, alignItems: 'center' },
  cover: { width: 56, height: 56, borderRadius: 6, backgroundColor: '#332b25' },
  meta: { flex: 1 },
  bookTitle: { color: '#f3e9dd', fontSize: 16, fontWeight: '600' },
  bookAuthor: { color: '#a99', fontSize: 13, marginTop: 2 },
  dim: { color: '#a99' },
})
