/**
 * Library. Merges the old library-picker + paginated browse screens into one,
 * matching the prototype: a search bar, a Books/Series/Narrators/Authors view
 * selector, and (Books view) filter chips + sort + a view-options sheet over
 * the book grid/list, with an A-Z rail on name-sorted grids. Search results
 * override the browse body while a query is active.
 *
 * Series/Narrators/Authors are real ABS data (getLibrarySeries/Authors/
 * Narrators in @/api/abs) - not stubs. Books view fetches the whole library
 * once (ABS limit=0) and filters/sorts/displays client-side, the same pattern
 * the web app's Library page already proves out.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, Pressable, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import type {
  ABSLibrary,
  ABSLibraryItem,
  ABSLibraryAuthor,
  ABSNarrator,
  ABSSeries,
  ABSMediaProgress,
} from '@hearthshelf/core'
import { letterOf, coverHue } from '@hearthshelf/core'
import {
  coverUrl,
  getLibraries,
  getLibraryAuthors,
  getLibraryItemsPage,
  getLibraryNarrators,
  getLibrarySeries,
  getMe,
  itemAuthor,
  itemTitle,
  searchLibrary,
} from '@/api/abs'
import { AppText, Centered, Cover, IconButton, Loading, Screen, Sheet, type SheetRef, icons } from '@/ui/primitives'
import { BookTile } from '@/ui/BookTile'
import { AzRail } from '@/ui/AzRail'
import { colors, radius, spacing } from '@/ui/theme'

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

type FilterKey = 'all' | 'progress' | 'finished'
type SortKey = 'name' | 'added' | 'author' | 'duration'
type DisplayMode = 'grid' | 'list'
type CoverSize = 'comfortable' | 'compact'

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'progress', label: 'In progress' },
  { key: 'finished', label: 'Finished' },
]
const SORT_LABEL: Record<SortKey, string> = {
  name: 'A–Z',
  added: 'Recent',
  author: 'Author',
  duration: 'Longest',
}

/**
 * Books view: fetches the whole library once (ABS limit=0 - the pattern the web
 * app's Library page already proves out) plus the caller's progress map, then
 * filters/sorts/paginates-for-render entirely client-side. "Downloaded" from
 * the prototype has no ABS/app-side data source (no offline-download feature
 * exists here) so it's intentionally omitted rather than stubbed as a fake filter.
 */
function BooksView({ libraryId, tileWidth: baseTileWidth }: { libraryId: string; tileWidth: number }) {
  const [items, setItems] = useState<ABSLibraryItem[] | null>(null)
  const [progress, setProgress] = useState<Map<string, ABSMediaProgress>>(new Map())
  const [error, setError] = useState<string | null>(null)

  const [filter, setFilter] = useState<FilterKey>('all')
  const [sort, setSort] = useState<SortKey>('name')
  const [display, setDisplay] = useState<DisplayMode>('grid')
  const [size, setSize] = useState<CoverSize>('comfortable')
  const sheetRef = useRef<SheetRef>(null)
  const [sheetTab, setSheetTab] = useState<'display' | 'sort' | 'filter'>('sort')

  const listRef = useRef<FlatList<ABSLibraryItem>>(null)

  useEffect(() => {
    let cancelled = false
    setItems(null)
    setError(null)
    void (async () => {
      try {
        const [page, me] = await Promise.all([
          getLibraryItemsPage(libraryId, 0, 0),
          getMe().catch(() => null),
        ])
        if (cancelled) return
        setItems(page.results)
        if (me) {
          setProgress(new Map(me.mediaProgress.map((p) => [p.libraryItemId, p])))
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [libraryId])

  const filtered = useMemo(() => {
    if (!items) return []
    if (filter === 'all') return items
    return items.filter((it) => {
      const p = progress.get(it.id)
      if (filter === 'finished') return p?.isFinished ?? false
      return (p?.progress ?? 0) > 0 && !p?.isFinished
    })
  }, [items, progress, filter])

  const sorted = useMemo(() => {
    const out = filtered.slice()
    if (sort === 'name') out.sort((a, b) => itemTitle(a).localeCompare(itemTitle(b)))
    else if (sort === 'author') out.sort((a, b) => itemAuthor(a).localeCompare(itemAuthor(b)))
    else if (sort === 'added') out.sort((a, b) => b.addedAt - a.addedAt)
    else if (sort === 'duration') out.sort((a, b) => (b.media.duration ?? 0) - (a.media.duration ?? 0))
    return out
  }, [filtered, sort])

  const cols = size === 'compact' ? 4 : COLS
  const tileWidth = size === 'compact' ? (baseTileWidth * COLS) / 4 - spacing.xs : baseTileWidth

  const letterIndex = useMemo(() => {
    const map = new Map<string, number>()
    sorted.forEach((it, i) => {
      const l = letterOf(itemTitle(it))
      if (!map.has(l)) map.set(l, i)
    })
    return map
  }, [sorted])
  const available = useMemo(() => new Set(letterIndex.keys()), [letterIndex])
  const showAzRail = sort === 'name' && display === 'grid'

  const onJump = useCallback(
    (letter: string) => {
      const idx = letterIndex.get(letter)
      if (idx == null) return
      const rowIndex = display === 'grid' ? Math.floor(idx / cols) : idx
      listRef.current?.scrollToIndex({ index: rowIndex, animated: true, viewPosition: 0 })
    },
    [letterIndex, display, cols]
  )

  if (!items && !error) return <Loading />
  if (error) {
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
      <View style={styles.filterRow}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            onPress={() => setFilter(f.key)}
            style={[styles.filterChip, filter === f.key && styles.filterChipActive]}
          >
            <AppText variant="caption" color={filter === f.key ? colors.onAccent : colors.textMuted}>
              {f.label}
            </AppText>
          </Pressable>
        ))}
      </View>

      <View style={styles.controlsRow}>
        <AppText variant="caption" color={colors.textMuted}>
          {sorted.length} {sorted.length === 1 ? 'title' : 'titles'}
        </AppText>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Pressable
            style={styles.sortChip}
            onPress={() => {
              setSheetTab('sort')
              sheetRef.current?.present()
            }}
          >
            <IconButton name={icons.sort} size={16} color={colors.textMuted} />
            <AppText variant="caption">{SORT_LABEL[sort]}</AppText>
          </Pressable>
          <IconButton
            name={icons.tune}
            style={styles.tuneBtn}
            onPress={() => {
              setSheetTab('display')
              sheetRef.current?.present()
            }}
          />
        </View>
      </View>

      {display === 'grid' ? (
        <FlatList
          ref={listRef}
          data={sorted}
          key={`grid-${cols}`}
          keyExtractor={(it) => it.id}
          numColumns={cols}
          columnWrapperStyle={{ gap: GUTTER }}
          contentContainerStyle={{ padding: GUTTER, paddingBottom: 140, gap: spacing.xs }}
          onScrollToIndexFailed={({ index }) => {
            listRef.current?.scrollToOffset({
              offset: Math.floor(index / cols) * (tileWidth * 1.5 + spacing.md),
              animated: true,
            })
          }}
          renderItem={({ item }) => <BookTile item={item} width={tileWidth} />}
        />
      ) : (
        <FlatList
          ref={listRef}
          data={sorted}
          keyExtractor={(it) => it.id}
          contentContainerStyle={{ padding: GUTTER, paddingBottom: 140, gap: spacing.sm }}
          renderItem={({ item }) => <BookListRow item={item} />}
        />
      )}
      {showAzRail && <AzRail available={available} onJump={onJump} />}

      <Sheet ref={sheetRef} title="View options">
        <View style={styles.sheetTabs}>
          {(['display', 'sort', 'filter'] as const).map((t) => (
            <Pressable
              key={t}
              onPress={() => setSheetTab(t)}
              style={[styles.sheetTab, sheetTab === t && styles.sheetTabActive]}
            >
              <AppText
                variant="label"
                color={sheetTab === t ? colors.text : colors.textMuted}
                style={{ textTransform: 'capitalize' }}
              >
                {t}
              </AppText>
            </Pressable>
          ))}
        </View>

        {sheetTab === 'display' && (
          <View style={{ gap: spacing.lg }}>
            <View>
              <AppText variant="eyebrow" style={{ marginBottom: spacing.sm }}>
                Layout
              </AppText>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                {(['list', 'grid'] as DisplayMode[]).map((d) => (
                  <Pressable
                    key={d}
                    onPress={() => setDisplay(d)}
                    style={[styles.segChoice, display === d && styles.segChoiceActive]}
                  >
                    <AppText
                      variant="label"
                      color={display === d ? colors.onAccent : colors.text}
                      style={{ textTransform: 'capitalize' }}
                    >
                      {d}
                    </AppText>
                  </Pressable>
                ))}
              </View>
            </View>
            <View>
              <AppText variant="eyebrow" style={{ marginBottom: spacing.sm }}>
                Cover size
              </AppText>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                {(['comfortable', 'compact'] as CoverSize[]).map((s) => (
                  <Pressable
                    key={s}
                    onPress={() => setSize(s)}
                    style={[styles.segChoice, size === s && styles.segChoiceActive]}
                  >
                    <AppText
                      variant="label"
                      color={size === s ? colors.onAccent : colors.text}
                      style={{ textTransform: 'capitalize' }}
                    >
                      {s}
                    </AppText>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>
        )}

        {sheetTab === 'sort' && (
          <View>
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <Pressable key={k} onPress={() => setSort(k)} style={styles.sheetRow}>
                <AppText variant="body" color={sort === k ? colors.accent : colors.text}>
                  {k === 'name'
                    ? 'Name (A–Z)'
                    : k === 'added'
                      ? 'Date added'
                      : k === 'author'
                        ? 'Author'
                        : 'Duration'}
                </AppText>
                {sort === k && <IconButton name={icons.checkCircle} color={colors.accent} />}
              </Pressable>
            ))}
          </View>
        )}

        {sheetTab === 'filter' && (
          <View>
            {FILTERS.map((f) => (
              <Pressable key={f.key} onPress={() => setFilter(f.key)} style={styles.sheetRow}>
                <AppText variant="body" color={filter === f.key ? colors.accent : colors.text}>
                  {f.label}
                </AppText>
                {filter === f.key && <IconButton name={icons.checkCircle} color={colors.accent} />}
              </Pressable>
            ))}
          </View>
        )}
      </Sheet>
    </View>
  )
}

function BookListRow({ item }: { item: ABSLibraryItem }) {
  const router = useRouter()
  return (
    <Pressable style={styles.listRow} onPress={() => router.push(`/item/${item.id}`)}>
      <Cover
        uri={coverUrl(item.id)}
        size={46}
        radius={radius.tile}
        fallback={{ hue: coverHue(item.id), initial: itemTitle(item).charAt(0).toUpperCase() }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="label" numberOfLines={1}>
          {itemTitle(item)}
        </AppText>
        <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
          {itemAuthor(item)}
        </AppText>
      </View>
      <IconButton name={icons.chevronRight} color={colors.textMuted} />
    </Pressable>
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
  filterRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  filterChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.fill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  filterChipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  sortChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.fill,
  },
  tuneBtn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.row,
  },
  sheetTabs: {
    flexDirection: 'row',
    gap: 4,
    backgroundColor: colors.fill,
    borderRadius: radius.card,
    padding: 4,
    marginBottom: spacing.lg,
  },
  sheetTab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.row,
  },
  sheetTabActive: { backgroundColor: colors.card },
  segChoice: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: spacing.md,
    borderRadius: radius.row,
    backgroundColor: colors.fill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  segChoiceActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
})
