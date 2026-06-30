import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { getLibraries, searchLibrary } from '@/api/abs'
import { AppText, Centered, IconButton, Loading, Screen, icons } from '@/ui/primitives'
import { BookTile } from '@/ui/BookTile'
import { colors, radius, spacing } from '@/ui/theme'

const COLS = 3
const GUTTER = spacing.lg

export default function SearchScreen() {
  const router = useRouter()
  const { width } = useWindowDimensions()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ABSLibraryItem[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)

  const tileWidth = (width - GUTTER * 2 - GUTTER * (COLS - 1)) / COLS

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
      setResults(await searchLibrary(libraryId, trimmed))
    } catch {
      setResults([])
    } finally {
      setSearched(true)
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const handle = setTimeout(() => void runSearch(query), 350)
    return () => clearTimeout(handle)
  }, [query, runSearch])

  return (
    <Screen>
      <View style={styles.header}>
        <IconButton name={icons.back} onPress={() => router.back()} />
        <View style={styles.searchBox}>
          <IconButton name={icons.search} size={20} color={colors.textMuted} />
          <TextInput
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            placeholder="Search books"
            placeholderTextColor={colors.textFaint}
            autoCorrect={false}
            autoCapitalize="none"
            autoFocus
          />
        </View>
      </View>

      {loading ? (
        <Loading />
      ) : searched && results.length === 0 ? (
        <Centered>
          <AppText variant="meta" color={colors.textMuted}>
            No results
          </AppText>
        </Centered>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(it) => it.id}
          numColumns={COLS}
          columnWrapperStyle={{ gap: GUTTER }}
          contentContainerStyle={{ padding: GUTTER, paddingBottom: 140, gap: spacing.xs }}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => <BookTile item={item} width={tileWidth} />}
        />
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
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.fill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  input: { flex: 1, paddingVertical: spacing.md, color: colors.text, fontSize: 16 },
})
