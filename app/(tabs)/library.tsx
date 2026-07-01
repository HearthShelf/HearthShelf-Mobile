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
import {
  FlatList,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { runOnJS } from 'react-native-reanimated'
import type {
  ABSLibrary,
  ABSLibraryItem,
  ABSLibraryAuthor,
  ABSNarrator,
  ABSSeries,
  ABSMediaProgress,
  LibrarySort,
} from '@hearthshelf/core'
import {
  letterOf,
  coverHue,
  applyLibraryFilter,
  filterLabel,
  FILTER_GROUPS,
  SORT_COMMON,
  SORT_MORE,
} from '@hearthshelf/core'
import {
  authorImageUrl,
  coverUrl,
  getLibraries,
  getLibraryAuthors,
  getLibraryItemsPage,
  getLibraryNarrators,
  getLibrarySeries,
  getMe,
  itemAuthor,
  itemTitle,
  narratorImageUrl,
  searchLibrary,
} from '@/api/abs'
import {
  AppText,
  Avatar,
  Centered,
  Cover,
  IconButton,
  Loading,
  Screen,
  Sheet,
  type SheetRef,
  Touchable,
  icons,
} from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { BookTile } from '@/ui/BookTile'
import { BookSelectionToolbar } from '@/ui/BookSelectionToolbar'
import { useBookSelection } from '@/ui/useBookSelection'
import { AzRail, AZ_RAIL_WIDTH } from '@/ui/AzRail'
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

  // Home's shelf headers deep-link here with a sort/filter preset. Seed the Books
  // view from those params (a new param object each time so navigating again
  // re-applies), and force the Books view so the preset is visible.
  const params = useLocalSearchParams<{ sort?: string; desc?: string; filter?: string }>()
  const preset = useMemo<BooksPreset | undefined>(() => {
    if (!params.sort && !params.filter) return undefined
    const all = [...SORT_COMMON, ...SORT_MORE] as string[]
    const sort = params.sort && all.includes(params.sort) ? (params.sort as LibrarySort) : undefined
    return { sort, desc: params.desc === '1', filter: params.filter }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.sort, params.desc, params.filter])

  // ---- library resolution (auto-pick the primary book library; switcher for
  // multi-library servers) ----
  const [libraries, setLibraries] = useState<ABSLibrary[]>([])
  const [libraryId, setLibraryId] = useState<string | null>(null)
  const [libError, setLibError] = useState<string | null>(null)

  // Resolve libraries when the screen mounts AND each time it regains focus, so a
  // transient not_connected (e.g. right after a server switch) self-heals when you
  // return to the tab instead of leaving a stuck error.
  useFocusEffect(
    useCallback(() => {
      // Already resolved? Don't re-fetch on every tab focus - only (re)load when
      // nothing is loaded yet or a prior attempt errored (the self-heal case).
      if (libraryId && !libError) return
      let cancelled = false
      void (async () => {
        try {
          const libs = await getLibraries()
          if (cancelled) return
          setLibError(null)
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
    }, [libraryId, libError]),
  )

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
    [libraryId],
  )

  useEffect(() => {
    const handle = setTimeout(() => void runSearch(query), 350)
    return () => clearTimeout(handle)
  }, [query, runSearch])

  // ---- view selector ----
  const [viewMode, setViewMode] = useState<ViewMode>('books')

  // A deep-link preset always lands on the Books view so the preset is visible.
  useEffect(() => {
    if (preset) setViewMode('books')
  }, [preset])

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
          <LibrarySwitcher libraries={libraries} activeId={libraryId} onSelect={setLibraryId} />
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
            <Touchable
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
            </Touchable>
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
        <BooksView libraryId={libraryId} width={width} preset={preset} />
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
    <Touchable
      onPress={() => onSelect(libraries[(idx + 1) % libraries.length].id)}
      style={styles.libSwitcher}
    >
      <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
        {active?.name}
      </AppText>
      <IconButton name={icons.chevronRight} size={16} color={colors.textMuted} />
    </Touchable>
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

type DisplayMode = 'grid' | 'list'
type CoverSize = 'comfortable' | 'compact'

interface ItemProgress {
  progress: number
  isFinished: boolean
}
type ProgressOf = (id: string) => ItemProgress | undefined

// Curated sorts for the phone tray. One row per concept (no separate "Author
// (Last, First)" row - the WebApp lists it twice, we don't); tap the active row
// again to flip direction. Random lives under a "More" disclosure.
const CURATED_SORTS: LibrarySort[] = [
  'Title',
  'Author',
  'Date Added',
  'Duration',
  'Progress',
  'Published Year',
]
const MORE_SORTS: LibrarySort[] = ['Random']
// Sorts that read most naturally newest/longest-first when you first pick them.
const DESC_BY_DEFAULT = new Set<LibrarySort>(['Date Added', 'Duration', 'Progress'])

// Curated filter groups surfaced on the phone (the core model also has decade /
// language / tags / explicit - left out here to keep the tray tidy; re-adding is
// a one-line change to this list).
const CURATED_FILTER_GROUPS = ['progress', 'genres', 'authors', 'series']

const lastName = (n: string) => n.trim().split(/\s+/).pop() ?? n

/** Port of the WebApp's per-sort comparators (LibraryPage.tsx). */
function sortItems(
  items: ABSLibraryItem[],
  sort: LibrarySort,
  desc: boolean,
  progressOf: ProgressOf,
): ABSLibraryItem[] {
  const out = items.slice()
  const cmp: Record<LibrarySort, (a: ABSLibraryItem, b: ABSLibraryItem) => number> = {
    Title: (a, b) =>
      (a.media.metadata.titleIgnorePrefix || a.media.metadata.title || '').localeCompare(
        b.media.metadata.titleIgnorePrefix || b.media.metadata.title || '',
      ),
    Author: (a, b) => a.media.metadata.authorName.localeCompare(b.media.metadata.authorName),
    'Author (Last, First)': (a, b) =>
      lastName(a.media.metadata.authorName).localeCompare(lastName(b.media.metadata.authorName)),
    'Published Year': (a, b) =>
      Number(a.media.metadata.publishedYear ?? 0) - Number(b.media.metadata.publishedYear ?? 0),
    'Date Added': (a, b) => a.addedAt - b.addedAt,
    Duration: (a, b) => (a.media.duration ?? 0) - (b.media.duration ?? 0),
    Size: (a, b) => (a.media.size ?? 0) - (b.media.size ?? 0),
    Progress: (a, b) => (progressOf(a.id)?.progress ?? 0) - (progressOf(b.id)?.progress ?? 0),
    Random: () => 0,
  }
  out.sort(cmp[sort])
  if (sort === 'Random') {
    // Deterministic-per-render shuffle so the order is mixed but stable.
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor((((i * 9301 + 49297) % 233280) / 233280) * (i + 1))
      const tmp = out[i]
      out[i] = out[j]
      out[j] = tmp
    }
  }
  if (desc) out.reverse()
  return out
}

interface BooksPreset {
  sort?: LibrarySort
  desc: boolean
  filter?: string
}

/**
 * Books view: fetches the whole library once (ABS limit=0 - the pattern the web
 * app's Library page already proves out) plus the caller's progress map, then
 * filters/sorts/displays entirely client-side. Filtering + sorting use the shared
 * @hearthshelf/core model (applyLibraryFilter / the WebApp's comparators) so the
 * phone and web offer the same options and agree on results.
 */
function BooksView({
  libraryId,
  width,
  preset,
}: {
  libraryId: string
  width: number
  preset?: BooksPreset
}) {
  const [items, setItems] = useState<ABSLibraryItem[] | null>(null)
  const [progress, setProgress] = useState<Map<string, ABSMediaProgress>>(new Map())
  const [error, setError] = useState<string | null>(null)
  const selection = useBookSelection()

  const refreshProgress = useCallback(() => {
    void getMe()
      .then((me) => setProgress(new Map(me.mediaProgress.map((p) => [p.libraryItemId, p]))))
      .catch(() => {})
  }, [])

  const [filter, setFilter] = useState<string>('all')
  const [sort, setSort] = useState<LibrarySort>('Title')
  const [desc, setDesc] = useState(false)
  const [display, setDisplay] = useState<DisplayMode>('grid')
  const [size, setSize] = useState<CoverSize>('comfortable')
  // Grid column count, adjustable by pinch (2 = big covers, 5 = small). Seeded
  // from the comfortable/compact setting; pinch overrides it live.
  const [gridCols, setGridCols] = useState(COLS)
  const sheetRef = useRef<SheetRef>(null)
  const [sheetTab, setSheetTab] = useState<'display' | 'sort' | 'filter'>('sort')
  // When drilling into a filter group's values (e.g. Genre -> pick one).
  const [openGroup, setOpenGroup] = useState<string | null>(null)

  const listRef = useRef<FlatList<ABSLibraryItem>>(null)

  // Apply an incoming deep-link preset (from Home's shelf headers).
  useEffect(() => {
    if (!preset) return
    if (preset.sort) setSort(preset.sort)
    setDesc(preset.desc)
    if (preset.filter) setFilter(preset.filter)
  }, [preset])

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

  const progressOf = useCallback<ProgressOf>(
    (id) => {
      const p = progress.get(id)
      return p ? { progress: p.progress, isFinished: p.isFinished } : undefined
    },
    [progress],
  )

  const filtered = useMemo(
    () => (items ? applyLibraryFilter(items, filter, progressOf) : []),
    [items, filter, progressOf],
  )
  const sorted = useMemo(
    () => sortItems(filtered, sort, desc, progressOf),
    [filtered, sort, desc, progressOf],
  )

  const cols = gridCols
  // Pinch the grid to resize covers: spread apart = fewer/bigger columns, pinch
  // together = more/smaller. Clamped 2..5. The column count at gesture start maps
  // to scale 1; we round the live scale back to a whole column count. All the ref
  // reads happen on the JS thread (inside runOnJS callbacks) - a plain useRef is
  // not shared to the gesture's UI worklet, so we only pass e.scale across.
  const colsRef = useRef(gridCols)
  colsRef.current = gridCols
  const pinchBase = useRef(gridCols)
  const captureCols = useCallback(() => {
    pinchBase.current = colsRef.current
  }, [])
  const applyPinch = useCallback((scale: number) => {
    const next = Math.max(2, Math.min(5, Math.round(pinchBase.current / scale)))
    setGridCols((prev) => (prev === next ? prev : next))
  }, [])
  const pinchGesture = useMemo(
    () =>
      Gesture.Pinch()
        .onStart(() => {
          runOnJS(captureCols)()
        })
        .onUpdate((e) => {
          runOnJS(applyPinch)(e.scale)
        }),
    [captureCols, applyPinch],
  )
  // The rail only makes sense on the Title-sorted grid (ascending buckets).
  const showAzRail = sort === 'Title' && !desc && display === 'grid'

  // Tiles fill the row exactly; when the rail reserves space on the right, shrink
  // them so the last column isn't pushed under the rail.
  const railReserve = showAzRail ? AZ_RAIL_WIDTH : 0
  const rowWidth = width - GUTTER * 2 - railReserve
  const tileWidth = (rowWidth - GUTTER * (cols - 1)) / cols

  const letterIndex = useMemo(() => {
    const map = new Map<string, number>()
    sorted.forEach((it, i) => {
      // Bucket by the same key the Title comparator sorts on (ignoring "The"/"A"
      // prefixes) so the rail's letters line up with the visual order.
      const l = letterOf(it.media.metadata.titleIgnorePrefix || itemTitle(it))
      if (!map.has(l)) map.set(l, i)
    })
    return map
  }, [sorted])
  const available = useMemo(() => new Set(letterIndex.keys()), [letterIndex])

  const onJump = useCallback(
    (letter: string) => {
      const idx = letterIndex.get(letter)
      if (idx == null) return
      const rowIndex = display === 'grid' ? Math.floor(idx / cols) : idx
      listRef.current?.scrollToIndex({ index: rowIndex, animated: true, viewPosition: 0 })
    },
    [letterIndex, display, cols],
  )

  const openSheet = (tab: 'display' | 'sort' | 'filter') => {
    setOpenGroup(null)
    setSheetTab(tab)
    sheetRef.current?.present()
  }

  // Tapping the active sort flips direction; a new sort adopts its natural default.
  const chooseSort = (s: LibrarySort) => {
    if (s === sort) setDesc((d) => !d)
    else {
      setSort(s)
      setDesc(DESC_BY_DEFAULT.has(s))
    }
  }

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

  const gridPadRight = showAzRail ? GUTTER + AZ_RAIL_WIDTH : GUTTER

  return (
    <View style={{ flex: 1 }}>
      {selection.selecting ? (
        <BookSelectionToolbar
          selection={selection}
          books={sorted}
          libraryId={libraryId}
          progressById={progress}
          onProgressChanged={refreshProgress}
        />
      ) : (
        <View style={styles.controlsRow}>
          <AppText variant="caption" color={colors.textMuted}>
            {sorted.length} {sorted.length === 1 ? 'title' : 'titles'}
          </AppText>
          <Touchable style={styles.controlBtn} onPress={() => openSheet('sort')}>
            <IconButton name={icons.tune} size={16} color={colors.text} />
            <AppText variant="caption">Filter · Sort · View</AppText>
          </Touchable>
        </View>
      )}

      {/* Applied filters as removable chips + a clear-all, so it's obvious what's
          active and easy to undo without opening the tray. */}
      {filter !== 'all' && (
        <View style={styles.filterChips}>
          <Touchable style={styles.filterChip} onPress={() => setFilter('all')}>
            <AppText variant="caption" color={colors.onAccent}>
              {filterLabel(filter)}
            </AppText>
            <IconButton name={icons.close} size={13} color={colors.onAccent} />
          </Touchable>
          <Touchable onPress={() => setFilter('all')} hitSlop={8} style={styles.clearFilters}>
            <AppText variant="caption" color={colors.textMuted}>
              Clear
            </AppText>
          </Touchable>
        </View>
      )}

      {display === 'grid' ? (
        <GestureDetector gesture={pinchGesture}>
          <FlatList
            ref={listRef}
            data={sorted}
            key={`grid-${cols}`}
            keyExtractor={(it) => it.id}
            numColumns={cols}
            columnWrapperStyle={{ gap: GUTTER }}
            contentContainerStyle={{
              paddingTop: GUTTER,
              paddingLeft: GUTTER,
              paddingRight: gridPadRight,
              paddingBottom: 140,
              gap: spacing.xs,
            }}
            onScrollToIndexFailed={({ index }) => {
              listRef.current?.scrollToOffset({
                offset: Math.floor(index / cols) * (tileWidth * 1.5 + spacing.md),
                animated: true,
              })
            }}
            renderItem={({ item }) => (
              <BookTile
                item={item}
                width={tileWidth}
                selecting={selection.selecting}
                selected={selection.isSelected(item.id)}
                onLongPress={() => selection.begin(item.id)}
                onToggle={() => selection.toggle(item.id)}
              />
            )}
          />
        </GestureDetector>
      ) : (
        <FlatList
          ref={listRef}
          data={sorted}
          keyExtractor={(it) => it.id}
          contentContainerStyle={{ padding: GUTTER, paddingBottom: 140, gap: spacing.sm }}
          renderItem={({ item }) => (
            <BookListRow
              item={item}
              selecting={selection.selecting}
              selected={selection.isSelected(item.id)}
              onLongPress={() => selection.begin(item.id)}
              onToggle={() => selection.toggle(item.id)}
            />
          )}
        />
      )}
      {showAzRail && <AzRail available={available} onJump={onJump} />}

      <Sheet ref={sheetRef} title="View options">
        <View style={styles.sheetTabs}>
          {(['display', 'sort', 'filter'] as const).map((t) => (
            <Touchable
              key={t}
              onPress={() => {
                setOpenGroup(null)
                setSheetTab(t)
              }}
              style={[styles.sheetTab, sheetTab === t && styles.sheetTabActive]}
            >
              <AppText
                variant="label"
                color={sheetTab === t ? colors.text : colors.textMuted}
                style={{ textTransform: 'capitalize' }}
              >
                {t}
              </AppText>
            </Touchable>
          ))}
        </View>

        {sheetTab === 'display' && (
          <View style={{ gap: spacing.lg }}>
            <SegRow
              label="Layout"
              options={['list', 'grid'] as DisplayMode[]}
              value={display}
              onChange={setDisplay}
            />
            <SegRow
              label="Cover size"
              options={['comfortable', 'compact'] as CoverSize[]}
              value={size}
              onChange={(s) => {
                setSize(s)
                setGridCols(s === 'compact' ? 4 : COLS)
              }}
            />
          </View>
        )}

        {sheetTab === 'sort' && (
          <ScrollView style={styles.sheetScroll}>
            {CURATED_SORTS.map((s) => (
              <SortRow
                key={s}
                label={s}
                active={sort === s}
                desc={desc}
                onPress={() => chooseSort(s)}
              />
            ))}
            <AppText variant="eyebrow" color={colors.textMuted} style={styles.sheetGroupLabel}>
              More
            </AppText>
            {MORE_SORTS.map((s) => (
              <SortRow
                key={s}
                label={s}
                active={sort === s}
                desc={desc}
                onPress={() => chooseSort(s)}
              />
            ))}
          </ScrollView>
        )}

        {sheetTab === 'filter' && (
          <ScrollView style={styles.sheetScroll}>
            {openGroup ? (
              <FilterValues
                group={openGroup}
                items={items ?? []}
                current={filter}
                onBack={() => setOpenGroup(null)}
                onPick={(f) => {
                  setFilter(f)
                  setOpenGroup(null)
                }}
              />
            ) : (
              <>
                <Touchable onPress={() => setFilter('all')} style={styles.sheetRow}>
                  <AppText variant="body" color={filter === 'all' ? colors.accent : colors.text}>
                    All titles
                  </AppText>
                  {filter === 'all' && (
                    <IconButton name={icons.checkCircle} color={colors.accent} />
                  )}
                </Touchable>
                {CURATED_FILTER_GROUPS.map((gid) => {
                  const group = FILTER_GROUPS.find((g) => g.id === gid)
                  if (!group) return null
                  const activeInGroup = filter.startsWith(`${gid}|`)
                  return (
                    <Touchable key={gid} onPress={() => setOpenGroup(gid)} style={styles.sheetRow}>
                      <AppText variant="body" color={activeInGroup ? colors.accent : colors.text}>
                        {group.label}
                      </AppText>
                      <View style={styles.filterRowTrail}>
                        {activeInGroup && (
                          <AppText variant="caption" color={colors.accent}>
                            {filter.split('|')[1]}
                          </AppText>
                        )}
                        <IconButton name={icons.chevronRight} color={colors.textMuted} />
                      </View>
                    </Touchable>
                  )
                })}
              </>
            )}
          </ScrollView>
        )}
      </Sheet>
    </View>
  )
}

/** A labeled segmented control (Layout / Cover size) in the display tab. */
function SegRow<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: T[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <View>
      <AppText variant="eyebrow" style={{ marginBottom: spacing.sm }}>
        {label}
      </AppText>
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        {options.map((o) => (
          <Touchable
            key={o}
            onPress={() => onChange(o)}
            style={[styles.segChoice, value === o && styles.segChoiceActive]}
          >
            <AppText
              variant="label"
              color={value === o ? colors.onAccent : colors.text}
              style={{ textTransform: 'capitalize' }}
            >
              {o}
            </AppText>
          </Touchable>
        ))}
      </View>
    </View>
  )
}

/** One sort row: active row shows an up/down arrow you tap again to flip. */
function SortRow({
  label,
  active,
  desc,
  onPress,
}: {
  label: string
  active: boolean
  desc: boolean
  onPress: () => void
}) {
  return (
    <Touchable onPress={onPress} style={styles.sheetRow}>
      <AppText variant="body" color={active ? colors.accent : colors.text}>
        {label}
      </AppText>
      {active && (
        <IconButton name={desc ? icons.collapse : icons.expand} size={20} color={colors.accent} />
      )}
    </Touchable>
  )
}

/** Drill-in list of a filter group's available values (derived from the items). */
function FilterValues({
  group,
  items,
  current,
  onBack,
  onPick,
}: {
  group: string
  items: ABSLibraryItem[]
  current: string
  onBack: () => void
  onPick: (filter: string) => void
}) {
  const def = FILTER_GROUPS.find((g) => g.id === group)
  const values = def ? def.values(items) : []
  return (
    <View>
      <Touchable onPress={onBack} style={styles.filterBack}>
        <IconButton name={icons.back} size={18} color={colors.textMuted} />
        <AppText variant="label" color={colors.textMuted}>
          {def?.label ?? 'Filter'}
        </AppText>
      </Touchable>
      {values.length === 0 ? (
        <AppText variant="meta" color={colors.textMuted} style={{ paddingVertical: spacing.md }}>
          Nothing to filter by here.
        </AppText>
      ) : (
        values.map((v) => {
          const f = `${group}|${v}`
          const active = current === f
          return (
            <Touchable key={v} onPress={() => onPick(f)} style={styles.sheetRow}>
              <AppText
                variant="body"
                color={active ? colors.accent : colors.text}
                numberOfLines={1}
              >
                {v}
              </AppText>
              {active && <IconButton name={icons.checkCircle} color={colors.accent} />}
            </Touchable>
          )
        })
      )}
    </View>
  )
}

function BookListRow({
  item,
  selecting = false,
  selected = false,
  onLongPress,
  onToggle,
}: {
  item: ABSLibraryItem
  selecting?: boolean
  selected?: boolean
  onLongPress?: () => void
  onToggle?: () => void
}) {
  const router = useRouter()
  return (
    <Touchable
      style={[styles.listRow, selected && styles.listRowSelected]}
      onPress={() => (selecting ? onToggle?.() : router.push(`/item/${item.id}`))}
      onLongPress={onLongPress}
    >
      {selecting ? (
        <View style={[styles.rowCheck, selected && styles.rowCheckOn]}>
          {selected ? <Icon name={icons.check} size={15} color={colors.onAccent} /> : null}
        </View>
      ) : null}
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
      {!selecting ? <IconButton name={icons.chevronRight} color={colors.textMuted} /> : null}
    </Touchable>
  )
}

interface GroupRow {
  key: string
  name: string
  sub: string
  covers: ABSLibraryItem[]
  /** Single avatar image (authors/narrators); series use stacked covers instead. */
  avatarUri?: string
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
        <Touchable
          style={styles.groupRow}
          onPress={() =>
            router.push(
              mode === 'series'
                ? `/series/${encodeURIComponent(item.key)}?libraryId=${encodeURIComponent(libraryId)}`
                : `/group/${mode}/${encodeURIComponent(item.key)}?libraryId=${encodeURIComponent(libraryId)}&name=${encodeURIComponent(item.name)}`,
            )
          }
        >
          {item.avatarUri !== undefined ? (
            // Authors/narrators: a single round avatar, centered-initials fallback.
            <Avatar uri={item.avatarUri} size={48} name={item.name} hue={coverHue(item.key)} />
          ) : (
            <View style={styles.groupCovers}>
              {item.covers.slice(0, 3).map((book, i) => (
                <Cover
                  key={book.id}
                  uri={coverUrl(book.id)}
                  size={46}
                  radius={7}
                  style={{ position: 'absolute', left: i * 16, zIndex: 3 - i }}
                  fallback={{
                    hue: coverHue(book.id),
                    initial: itemTitle(book).charAt(0).toUpperCase(),
                  }}
                />
              ))}
            </View>
          )}
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="label" numberOfLines={1}>
              {item.name}
            </AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {item.sub}
            </AppText>
          </View>
          <IconButton name={icons.chevronRight} color={colors.textMuted} />
        </Touchable>
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
    avatarUri: authorImageUrl(a.id),
  }
}

function narratorToRow(n: ABSNarrator): GroupRow {
  return {
    key: n.id,
    name: n.name,
    sub: `${n.numBooks} ${n.numBooks === 1 ? 'title' : 'titles'}`,
    covers: [],
    // HearthShelf's custom narrator photo, keyed by name; falls back to initials.
    avatarUri: narratorImageUrl(n.name),
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
  // DS "compact rows" (.m-rows): flex row, 13 gap, 9/11 pad, 13 radius.
  groupRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 9,
    paddingHorizontal: 11,
    borderRadius: 13,
  },
  // Holds up to 3 overlapping 46px covers (46 + 2*16 = 78 wide).
  groupCovers: { width: 78, height: 46 },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  controlBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingLeft: spacing.sm,
    paddingRight: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.fill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  filterChips: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  filterChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingLeft: spacing.md,
    paddingRight: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  clearFilters: { paddingVertical: 6, paddingHorizontal: spacing.sm },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.row,
  },
  listRowSelected: { backgroundColor: colors.accentWash },
  rowCheck: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: colors.textFaint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowCheckOn: { backgroundColor: colors.accent, borderColor: colors.accent },
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
  // Cap the scrolling option lists so long genre/author lists don't push the
  // sheet past the screen.
  sheetScroll: { maxHeight: 380 },
  sheetGroupLabel: { marginTop: spacing.md, marginBottom: spacing.xs },
  filterRowTrail: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, maxWidth: 180 },
  filterBack: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    marginBottom: spacing.xs,
  },
})
