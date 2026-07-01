/**
 * Library. Merges the old library-picker + paginated browse screens into one,
 * matching the prototype: a search bar, a Books/Series/Narrators/Authors view
 * selector, and (Books view) the paginated grid + A-Z rail. Search results
 * override the browse body while a query is active.
 *
 * Series/Narrators/Authors are real ABS data (getLibrarySeries/Authors/
 * Narrators in @/api/abs) - not stubs. Filter chips, sort, and the view-options
 * sheet land in a follow-up pass on this same screen (plan section 4).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Pressable, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import type { ABSLibrary, ABSLibraryItem, ABSLibraryAuthor, ABSNarrator, ABSSeries } from '@hearthshelf/core'
import { letterOf, coverHue } from '@hearthshelf/core'
import {
  getLibraries,
  getLibraryAuthors,
  getLibraryItemsPage,
  getLibraryNarrators,
  getLibrarySeries,
  itemTitle,
  searchLibrary,
} from '@/api/abs'
import { AppText, Centered, Cover, IconButton, Loading, Screen, icons } from '@/ui/primitives'
import { BookTile } from '@/ui/BookTile'
import { AzRail } from '@/ui/AzRail'
import { colors, radius, spacing } from '@/ui/theme'

const PAGE_SIZE = 50
const COLS = 3
const GUTTER = spacing.lg

type ViewMode = 'books' | 'series' | 'narrators' | 'authors'
const VIEW_MODES: { key: ViewMode; label: string }[] = [
  { key: 'books', label: 'Books' },
  { key: 'series', label: 'Series' },
  { key: 'narrators', label: 'Narrators' },
  { key: 'authors', label: 'Authors' },
]

export default function LibraryScreen() {
  const router = useRouter()
  const { width } = useWindowDimensions()

  // ---- library resolution (auto-pick the primary book library; switcher for
  // multi-library servers) ----
  const [libraries, setLibraries] = useState<ABSLibrary[]>([])
  const [libraryId, setLibraryId] = useState<string | null>(null)
  const [libError, setLibError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const libs = await getLibraries()
        if (cancelled) return
        setLibraries(libs)
        const primary = libs.find((l) => l.mediaType === 'book') ?? libs[0]
        setLibraryId(primary?.id ?? null)
      } catch (e) {
        if (!cancelled) setLibError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // ---- search ----
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ABSLibraryItem[]>([])
  const [searching, setSearching] = useState(false)
  const [searched, setSearched] = useState(false)
  const hasQuery = query.trim().length > 0

  const runSearch = useCallback(
    async (q: string) => {
      const trimmed = q.trim()
      if (!trimmed || !libraryId) {
        setResults([])
        setSearched(false)
        return
      }
      setSearching(true)
      try {
        setResults(await searchLibrary(libraryId, trimmed))
      } catch {
        setResults([])
      } finally {
        setSearched(true)
        setSearching(false)
      }
    },
    [libraryId]
  )

  useEffect(() => {
    const handle = setTimeout(() => void runSearch(query), 350)
    return () => clearTimeout(handle)
  }, [query, runSearch])

  // ---- view selector ----
  const [viewMode, setViewMode] = useState<ViewMode>('books')

  const tileWidth = (width - GUTTER * 2 - GUTTER * (COLS - 1)) / COLS

  if (libError) {
    return (
      <Screen>
        <Centered>
          <AppText variant="meta" color={colors.destructive}>
            {libError}
          </AppText>
        </Centered>
      </Screen>
    )
  }

  return (
    <Screen>
      <View style={styles.header}>
        <AppText variant="hero">Library</AppText>
        {libraries.length > 1 && (
          <LibrarySwitcher
            libraries={libraries}
            activeId={libraryId}
            onSelect={setLibraryId}
          />
        )}
      </View>

      <View style={styles.searchBox}>
        <IconButton name={icons.search} size={20} color={colors.textMuted} />
        <TextInput
          style={styles.input}
          value={query}
          onChangeText={setQuery}
          placeholder="Search this library"
          placeholderTextColor={colors.textFaint}
          autoCorrect={false}
          autoCapitalize="none"
        />
        {hasQuery && (
          <IconButton
            name={icons.close}
            size={20}
            color={colors.textMuted}
            onPress={() => setQuery('')}
          />
        )}
      </View>

      {!hasQuery && (
        <View style={styles.viewSelector}>
          {VIEW_MODES.map((v) => (
            <Pressable
              key={v.key}
              onPress={() => setViewMode(v.key)}
              style={[styles.viewChip, viewMode === v.key && styles.viewChipActive]}
            >
              <AppText
                variant="label"
                color={viewMode === v.key ? colors.onAccent : colors.textMuted}
              >
                {v.label}
              </AppText>
            </Pressable>
          ))}
        </View>
      )}

      {hasQuery ? (
        <SearchResults
          query={query}
          searching={searching}
          searched={searched}
          results={results}
          tileWidth={tileWidth}
        />
      ) : !libraryId ? (
        <Loading />
      ) : viewMode === 'books' ? (
        <BooksView libraryId={libraryId} tileWidth={tileWidth} />
      ) : (
        <GroupsView libraryId={libraryId} mode={viewMode} />
      )}
    </Screen>
  )
}

function LibrarySwitcher({
  libraries,
  activeId,
  onSelect,
}: {
  libraries: ABSLibrary[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  // Simple cycle-through control for the uncommon multi-library case; a full
  // picker sheet can replace this if servers with >2 book libraries show up.
  const idx = libraries.findIndex((l) => l.id === activeId)
  const active = libraries[idx] ?? libraries[0]
  return (
    <Pressable
      onPress={() => onSelect(libraries[(idx + 1) % libraries.length].id)}
      style={styles.libSwitcher}
    >
      <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
        {active?.name}
      </AppText>
      <IconButton name={icons.chevronRight} size={16} color={colors.textMuted} />
    </Pressable>
  )
}

function SearchResults({
  query,
  searching,
  searched,
  results,
  tileWidth,
}: {
  query: string
  searching: boolean
  searched: boolean
  results: ABSLibraryItem[]
  tileWidth: number
}) {
  if (searching) return <Loading />
  if (searched && results.length === 0) {
    return (
      <Centered>
        <AppText variant="meta" color={colors.textMuted}>
          No matches for "{query.trim()}".
        </AppText>
      </Centered>
    )
  }
  return (
    <FlatList
      data={results}
      keyExtractor={(it) => it.id}
      numColumns={COLS}
      columnWrapperStyle={{ gap: GUTTER }}
      contentContainerStyle={{ padding: GUTTER, paddingBottom: 140, gap: spacing.xs }}
      keyboardShouldPersistTaps="handled"
      renderItem={({ item }) => <BookTile item={item} width={tileWidth} />}
    />
  )
}

function BooksView({ libraryId, tileWidth }: { libraryId: string; tileWidth: number }) {
  const [items, setItems] = useState<ABSLibraryItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const listRef = useRef<FlatList<ABSLibraryItem>>(null)
  const nextPageRef = useRef(0)
  const loadingRef = useRef(false)

  // Reset pagination when the library changes.
  useEffect(() => {
    setItems([])
    setTotal(0)
    setLoading(true)
    nextPageRef.current = 0
    loadingRef.current = false
  }, [libraryId])

  const loadMore = useCallback(async () => {
    if (!libraryId || loadingRef.current) return
    loadingRef.current = true
    try {
      const page = await getLibraryItemsPage(libraryId, nextPageRef.current, PAGE_SIZE)
      setItems((prev) => [...prev, ...page.results])
      setTotal(page.total)
      nextPageRef.current += 1
    } catch (e) {
      setError((e as Error).message)
    } finally {
      loadingRef.current = false
      setLoading(false)
    }
  }, [libraryId])

  useEffect(() => {
    void loadMore()
    // Only re-trigger the initial page when the library changes (loadMore's
    // libraryId dependency already captures that).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryId])

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
      listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0 })
    },
    [letterIndex]
  )

  if (loading && items.length === 0) return <Loading />
  if (error && items.length === 0) {
    return (
      <Centered>
        <AppText variant="meta" color={colors.destructive}>
          {error}
        </AppText>
      </Centered>
    )
  }

  return (
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
          listRef.current?.scrollToOffset({
            offset: Math.floor(index / COLS) * (tileWidth * 1.5 + spacing.md),
            animated: true,
          })
        }}
        renderItem={({ item }) => <BookTile item={item} width={tileWidth} />}
      />
      <AzRail available={available} onJump={onJump} />
    </View>
  )
}

interface GroupRow {
  key: string
  name: string
  sub: string
  covers: ABSLibraryItem[]
}

function GroupsView({ libraryId, mode }: { libraryId: string; mode: ViewMode }) {
  const router = useRouter()
  const [groups, setGroups] = useState<GroupRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setGroups(null)
    setError(null)
    void (async () => {
      try {
        if (mode === 'series') {
          const series = await getLibrarySeries(libraryId)
          if (cancelled) return
          setGroups(series.map((s: ABSSeries) => seriesToRow(s)))
        } else if (mode === 'authors') {
          const authors = await getLibraryAuthors(libraryId)
          if (cancelled) return
          setGroups(authors.map((a: ABSLibraryAuthor) => authorToRow(a)))
        } else {
          const narrators = await getLibraryNarrators(libraryId)
          if (cancelled) return
          setGroups(narrators.map((n: ABSNarrator) => narratorToRow(n)))
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [libraryId, mode])

  if (error) {
    return (
      <Centered>
        <AppText variant="meta" color={colors.destructive}>
          {error}
        </AppText>
      </Centered>
    )
  }
  if (!groups) return <Loading />
  if (groups.length === 0) {
    return (
      <Centered>
        <AppText variant="meta" color={colors.textMuted}>
          Nothing here yet.
        </AppText>
      </Centered>
    )
  }

  return (
    <FlatList
      data={groups}
      keyExtractor={(g) => g.key}
      contentContainerStyle={{ padding: spacing.md, paddingBottom: 140 }}
      renderItem={({ item }) => (
        <Pressable
          style={styles.groupRow}
          onPress={() =>
            router.push(
              `/group/${mode}/${encodeURIComponent(item.key)}?libraryId=${encodeURIComponent(libraryId)}&name=${encodeURIComponent(item.name)}`
            )
          }
        >
          <View style={styles.groupCovers}>
            {item.covers.slice(0, 3).map((book, i) => (
              <Cover
                key={book.id}
                size={48}
                radius={radius.tile}
                style={{ position: 'absolute', left: i * 15, zIndex: 3 - i }}
                fallback={{ hue: coverHue(book.id), initial: itemTitle(book).charAt(0).toUpperCase() }}
              />
            ))}
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="label" numberOfLines={1}>
              {item.name}
            </AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {item.sub}
            </AppText>
          </View>
          <IconButton name={icons.chevronRight} color={colors.textMuted} />
        </Pressable>
      )}
    />
  )
}

function seriesToRow(s: ABSSeries): GroupRow {
  const count = s.books.length
  return {
    key: s.id,
    name: s.name,
    sub: `${count} ${count === 1 ? 'book' : 'books'}`,
    covers: s.books,
  }
}

function authorToRow(a: ABSLibraryAuthor): GroupRow {
  return {
    key: a.id,
    name: a.name,
    sub: `${a.numBooks} ${a.numBooks === 1 ? 'title' : 'titles'}`,
    covers: [],
  }
}

function narratorToRow(n: ABSNarrator): GroupRow {
  return {
    key: n.id,
    name: n.name,
    sub: `${n.numBooks} ${n.numBooks === 1 ? 'title' : 'titles'}`,
    covers: [],
  }
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  libSwitcher: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    maxWidth: 160,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.fill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  input: { flex: 1, paddingVertical: spacing.md, color: colors.text, fontSize: 16 },
  viewSelector: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  viewChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: colors.fill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  viewChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.row,
  },
  groupCovers: { width: 74, height: 54 },
})
