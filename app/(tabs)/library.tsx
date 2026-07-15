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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, { FadeIn, runOnJS } from 'react-native-reanimated'
import type {
  ABSLibrary,
  ABSLibraryItem,
  ABSLibraryAuthor,
  ABSNarrator,
  ABSSeries,
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
  itemAuthor,
  itemTitle,
  narratorImageUrl,
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
import { DUR } from '@/ui/motion'
import { haptics } from '@/ui/haptics'
import { onTabReselect } from '@/ui/tabReselect'
import { BookTile } from '@/ui/BookTile'
import { EmptyState, SkeletonTile } from '@/ui/states'
import { playItemById } from '@/player/playback'
import { useConnection } from '@/api/ConnectionProvider'
import { BookSelectionToolbar } from '@/ui/BookSelectionToolbar'
import { getProgressState, subscribeProgress, refreshProgress } from '@/store/progress'
import {
  catalogAsLibraryItems,
  catalogLibraryId,
  catalogSeries,
  catalogAuthors,
  catalogNarrators,
  subscribeCatalog,
  getCatalogState,
} from '@/player/offlineCatalog'
import { useContentInset, useMiniPlayerInset } from '@/ui/useContentInset'
import { useBackHandler, useSheetBackHandler } from '@/ui/useBackHandler'
import { useBookSelection } from '@/ui/useBookSelection'
import { AzRail, AZ_RAIL_WIDTH } from '@/ui/AzRail'
import { ScrollTopButton } from '@/ui/ScrollTopButton'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { adaptiveGridColumns, adaptiveGridTileWidth, adaptiveLibraryColumns } from '@/ui/responsive'

const GUTTER = spacing.lg
// Reveal the scroll-to-top button once the list is roughly 1.5 screens deep.
const SCROLL_TOP_THRESHOLD = 900
// One-time grid "Pinch to resize" hint (device-local).
const PINCH_HINT_KEY = 'hs.libraryPinchHint'

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
  const colors = useColors()
  const styles = useStyles()

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
          if (cancelled) return
          // Offline: use the downloaded books' library so the list still mounts
          // and BooksView falls back to the catalog. Only a genuine error (no
          // downloads to show) surfaces the message.
          const offlineLib = catalogLibraryId()
          if (offlineLib) {
            setLibError(null)
            setLibraryId(offlineLib)
          } else {
            setLibError((e as Error).message)
          }
        }
      })()
      return () => {
        cancelled = true
      }
    }, [libraryId, libError]),
  )

  // ---- view selector ----
  const [viewMode, setViewMode] = useState<ViewMode>('books')

  // A deep-link preset always lands on the Books view so the preset is visible.
  useEffect(() => {
    if (preset) setViewMode('books')
  }, [preset])

  // Hardware back: a non-default view (Series/Authors/Narrators) steps back to
  // Books; only from the plain Books view does back fall through to Home.
  useBackHandler(
    useCallback(() => {
      if (viewMode !== 'books') {
        setViewMode('books')
        return true
      }
      router.replace('/(tabs)')
      return true
    }, [viewMode, router]),
  )
  // Close any open sheet (book actions, view options) before the view/home
  // back logic above. Registered after it so it fires first.
  useSheetBackHandler()

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

      {/* Search routes to the ONE unified search screen (D-SEARCH); the view
          chips below are purely for browsing and never disappear. */}
      <Touchable onPress={() => router.push('/search?from=library')} style={styles.searchBox}>
        <IconButton name={icons.search} size={20} color={colors.textMuted} />
        <AppText variant="meta" color={colors.textFaint} style={{ flex: 1 }}>
          Search books, series, people…
        </AppText>
      </Touchable>

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

      {!libraryId ? (
        <Loading />
      ) : viewMode === 'books' ? (
        <BooksView libraryId={libraryId} width={width} preset={preset} />
      ) : (
        <GroupsView libraryId={libraryId} mode={viewMode} />
      )}
    </Screen>
  )
}

/**
 * Library switcher: a chip showing the current library that opens a picker
 * sheet listing every library with its book count and a checkmark on the
 * active one - replacing the old blind cycle-through. Counts are fetched lazily
 * (the items endpoint's `total`) and cached per id.
 */
function LibrarySwitcher({
  libraries,
  activeId,
  onSelect,
}: {
  libraries: ABSLibrary[]
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const colors = useColors()
  const styles = useStyles()
  const sheetRef = useRef<SheetRef>(null)
  const active = libraries.find((l) => l.id === activeId) ?? libraries[0]
  const [counts, setCounts] = useState<Record<string, number>>({})

  // Fetch each library's book count once, when the picker opens.
  const loadCounts = useCallback(() => {
    for (const lib of libraries) {
      if (counts[lib.id] !== undefined) continue
      void getLibraryItemsPage(lib.id, 0, 1)
        .then((page) => setCounts((c) => ({ ...c, [lib.id]: page.total })))
        .catch(() => {})
    }
  }, [libraries, counts])

  return (
    <>
      <Touchable
        onPress={() => {
          loadCounts()
          sheetRef.current?.present()
        }}
        style={styles.libSwitcher}
      >
        <Icon name={icons.library} size={15} color={colors.brandHearth} />
        <AppText variant="caption" numberOfLines={1}>
          {active?.name}
        </AppText>
        {counts[active?.id ?? ''] !== undefined ? (
          <AppText variant="caption" color={colors.textMuted}>
            · {counts[active.id]}
          </AppText>
        ) : null}
        <Icon name={icons.unfold} size={15} color={colors.textMuted} />
      </Touchable>

      <Sheet ref={sheetRef} title="Choose a library">
        <View style={{ paddingBottom: spacing.md }}>
          {libraries.map((lib) => {
            const isActive = lib.id === (active?.id ?? activeId)
            return (
              <Touchable
                key={lib.id}
                style={styles.libPickRow}
                onPress={() => {
                  onSelect(lib.id)
                  sheetRef.current?.dismiss()
                }}
              >
                <Icon
                  name={icons.library}
                  size={20}
                  color={isActive ? colors.accent : colors.textMuted}
                />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <AppText variant="body" color={isActive ? colors.accent : colors.text} numberOfLines={1}>
                    {lib.name}
                  </AppText>
                  {counts[lib.id] !== undefined ? (
                    <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 1 }}>
                      {counts[lib.id]} {counts[lib.id] === 1 ? 'book' : 'books'}
                    </AppText>
                  ) : null}
                </View>
                {isActive ? (
                  <Icon name={icons.checkCircle} size={20} color={colors.accent} />
                ) : null}
              </Touchable>
            )
          })}
        </View>
      </Sheet>
    </>
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
  const colors = useColors()
  const styles = useStyles()
  const router = useRouter()
  const contentInset = useContentInset()
  const { status } = useConnection()
  const offline = status.phase === 'offline'
  const [items, setItems] = useState<ABSLibraryItem[] | null>(null)
  // Shared per-item progress; mark-finished anywhere updates this view live.
  const progress = useSyncExternalStore(subscribeProgress, getProgressState).byId
  // Re-run the load when the offline catalog changes (a book finishes
  // downloading), so an offline library picks up new downloads live.
  const catalogVersion = useSyncExternalStore(subscribeCatalog, getCatalogState)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const selection = useBookSelection()

  const [filter, setFilter] = useState<string>('all')
  const [sort, setSort] = useState<LibrarySort>('Title')
  const [desc, setDesc] = useState(false)
  const [display, setDisplay] = useState<DisplayMode>('grid')
  const [size, setSize] = useState<CoverSize>('comfortable')
  const defaultGridCols = useMemo(() => adaptiveLibraryColumns(width, size), [width, size])
  const maxGridCols = size === 'compact' ? 7 : 6
  // Grid column count, adjustable by pinch. Foldables get wider defaults; pinch
  // overrides them live until the user changes the cover-size setting.
  const [gridCols, setGridCols] = useState(defaultGridCols)
  const manualGridCols = useRef(false)
  const sheetRef = useRef<SheetRef>(null)
  const [sheetTab, setSheetTab] = useState<'display' | 'sort' | 'filter'>('sort')
  // When drilling into a filter group's values (e.g. Genre -> pick one).
  const [openGroup, setOpenGroup] = useState<string | null>(null)

  const listRef = useRef<FlatList<ABSLibraryItem>>(null)
  const railInset = useMiniPlayerInset()
  // Drives the scroll-to-top button: true once we've scrolled past ~1.5 screens.
  const [scrolledDeep, setScrolledDeep] = useState(false)
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    setScrolledDeep(e.nativeEvent.contentOffset.y > SCROLL_TOP_THRESHOLD)
  }, [])
  const scrollToTop = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true })
  }, [])
  // Re-tapping the Library tab while already on it scrolls back to the top.
  useEffect(() => onTabReselect('library', scrollToTop), [scrollToTop])

  // Apply an incoming deep-link preset (from Home's shelf headers).
  useEffect(() => {
    if (!preset) return
    if (preset.sort) setSort(preset.sort)
    setDesc(preset.desc)
    if (preset.filter) setFilter(preset.filter)
  }, [preset])

  // Fetch the whole library + refresh progress. `blank` clears the grid first
  // (initial load / library switch); a pull-to-refresh leaves the current books
  // in place and just refetches under the pull spinner.
  const load = useCallback(
    async (opts?: { blank?: boolean; signal?: () => boolean }) => {
      const cancelled = opts?.signal ?? (() => false)
      if (opts?.blank) setItems(null)
      setError(null)
      try {
        const [page] = await Promise.all([
          getLibraryItemsPage(libraryId, 0, 0),
          refreshProgress().catch(() => null),
        ])
        if (cancelled()) return
        setItems(page.results)
      } catch (e) {
        if (cancelled()) return
        // Offline (or the server is unreachable): show downloaded books from the
        // local catalog instead of a bare error, so the library stays browseable.
        const offline = catalogAsLibraryItems()
        if (offline.length > 0) setItems(offline)
        else setError((e as Error).message)
      }
    },
    [libraryId],
  )

  useEffect(() => {
    let cancelled = false
    void load({ blank: true, signal: () => cancelled })
    return () => {
      cancelled = true
    }
  }, [load, catalogVersion])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await load()
    } finally {
      setRefreshing(false)
    }
  }, [load])

  const progressOf = useCallback<ProgressOf>(
    (id) => {
      const p = progress.get(id)
      return p ? { progress: p.progress, isFinished: p.isFinished } : undefined
    },
    [progress],
  )

  const quickPlay = useCallback(
    async (id: string) => {
      haptics.transport()
      try {
        await playItemById(id)
        router.push('/player')
      } catch {
        router.push(`/item/${id}?from=library`)
      }
    },
    [router],
  )

  // One-time "Pinch to resize" hint over the grid (device-local; shown until
  // dismissed once). Only relevant in grid view.
  const [showPinchHint, setShowPinchHint] = useState(false)
  useEffect(() => {
    void AsyncStorage.getItem(PINCH_HINT_KEY).then((seen) => {
      if (!seen) setShowPinchHint(true)
    })
  }, [])
  const dismissPinchHint = useCallback(() => {
    setShowPinchHint(false)
    void AsyncStorage.setItem(PINCH_HINT_KEY, '1')
  }, [])

  const filtered = useMemo(
    () => (items ? applyLibraryFilter(items, filter, progressOf) : []),
    [items, filter, progressOf],
  )
  const sorted = useMemo(
    () => sortItems(filtered, sort, desc, progressOf),
    [filtered, sort, desc, progressOf],
  )

  useEffect(() => {
    if (manualGridCols.current) {
      setGridCols((prev) => Math.max(2, Math.min(maxGridCols, prev)))
    } else {
      setGridCols(defaultGridCols)
    }
  }, [defaultGridCols, maxGridCols])

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
  const applyPinch = useCallback(
    (scale: number) => {
      manualGridCols.current = true
      const next = Math.max(2, Math.min(maxGridCols, Math.round(pinchBase.current / scale)))
      setGridCols((prev) => (prev === next ? prev : next))
    },
    [maxGridCols],
  )
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
  // FINAL: the A-Z rail is LIST-view only, on alphabetical (Title/Author)
  // sorts - so grid covers get the full row width. It works in either
  // direction (letterIndex is built from the already-sorted list, so a desc
  // sort just gives Z-first buckets).
  const alphabetical = sort === 'Title' || sort === 'Author'
  const showAzRail = alphabetical && display === 'list'

  // Tiles fill the row exactly; when the rail reserves space on the right, shrink
  // them so the last column isn't pushed under the rail.
  const railReserve = showAzRail ? AZ_RAIL_WIDTH : 0
  const tileWidth = adaptiveGridTileWidth({
    width,
    cols,
    gutter: GUTTER,
    reserved: railReserve,
  })

  const letterIndex = useMemo(() => {
    const map = new Map<string, number>()
    sorted.forEach((it, i) => {
      // Bucket by the same key the active comparator sorts on so the rail's
      // letters line up with the visual order: title (ignoring "The"/"A"
      // prefixes) for Title sort, author surname for Author sort.
      const key =
        sort === 'Author' ? itemAuthor(it) : it.media.metadata.titleIgnorePrefix || itemTitle(it)
      const l = letterOf(key)
      if (!map.has(l)) map.set(l, i)
    })
    return map
  }, [sorted, sort])
  const available = useMemo(() => new Set(letterIndex.keys()), [letterIndex])

  const onJump = useCallback(
    (letter: string) => {
      const idx = letterIndex.get(letter)
      if (idx == null) return
      // Rail is list-view only now, so the item index is the row index.
      listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0 })
    },
    [letterIndex],
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

  if (!items && !error) return <LibrarySkeleton width={width} cols={defaultGridCols} />
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

  const refreshControl = (
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={colors.accent}
      colors={[colors.accent]}
    />
  )

  return (
    <Animated.View entering={FadeIn.duration(DUR.base)} style={{ flex: 1 }}>
      {selection.selecting ? (
        <BookSelectionToolbar selection={selection} books={sorted} libraryId={libraryId} />
      ) : (
        // Persistent control bar: sort chip (tap flips direction, chevron opens
        // the sheet), filter chip with an active-count badge, and grid/list +
        // Select buttons. The full Display/Sort/Filter sheet stays behind these.
        <View style={[styles.controlBar, showAzRail && { paddingRight: 28 }]}>
          <Touchable style={styles.ctrlChip} onPress={() => chooseSort(sort)}>
            <Icon
              name={desc ? icons.arrowDownward : icons.arrowUpward}
              size={15}
              color={colors.accent}
            />
            <AppText variant="caption">{sort}</AppText>
            <Touchable onPress={() => openSheet('sort')} hitSlop={8}>
              <Icon name={icons.collapse} size={15} color={colors.textMuted} />
            </Touchable>
          </Touchable>
          <Touchable style={styles.ctrlChip} onPress={() => openSheet('filter')}>
            <Icon name={icons.filter} size={15} color={colors.text} />
            <AppText variant="caption">Filters</AppText>
            {filter !== 'all' ? (
              <View style={styles.ctrlBadge}>
                <AppText variant="caption" color={colors.onAccent} style={styles.ctrlBadgeText}>
                  1
                </AppText>
              </View>
            ) : null}
          </Touchable>
          <View style={{ flex: 1 }} />
          <Touchable
            style={styles.ctrlIconBtn}
            onPress={() => setDisplay((d) => (d === 'grid' ? 'list' : 'grid'))}
          >
            <Icon
              name={display === 'grid' ? icons.viewList : icons.viewGrid}
              size={19}
              color={colors.text}
            />
          </Touchable>
          <Touchable style={styles.ctrlIconBtn} onPress={() => selection.begin()}>
            <Icon name={icons.checklist} size={19} color={colors.text} />
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

      {offline && (
        <View style={styles.offlineChip}>
          <Icon name={icons.cloudOff} size={14} color={colors.brandHearth} />
          <AppText variant="caption" color={colors.textMuted}>
            Offline · downloaded books only
          </AppText>
        </View>
      )}

      {sorted.length === 0 ? (
        <EmptyState
          icon={icons.library}
          iconColor={colors.textMuted}
          title={filter !== 'all' ? 'No books match these filters' : 'No books in this library yet'}
          body={
            filter !== 'all'
              ? 'Try clearing a filter to see more of your library.'
              : 'Switch to another library or add books on your server.'
          }
          cta={filter !== 'all' ? 'Clear filters' : undefined}
          onCta={filter !== 'all' ? () => setFilter('all') : undefined}
        />
      ) : display === 'grid' ? (
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
              paddingBottom: contentInset,
              gap: spacing.xs,
            }}
            onScroll={onScroll}
            scrollEventThrottle={16}
            refreshControl={refreshControl}
            onScrollToIndexFailed={({ index }) => {
              listRef.current?.scrollToOffset({
                offset: Math.floor(index / cols) * (tileWidth * 1.5 + spacing.md),
                animated: true,
              })
            }}
            renderItem={({ item }) => {
              const p = progressOf(item.id)
              return (
                <BookTile
                  item={item}
                  width={tileWidth}
                  from="library"
                  progress={p?.progress}
                  finished={p?.isFinished === true}
                  onQuickPlay={() => void quickPlay(item.id)}
                  selecting={selection.selecting}
                  selected={selection.isSelected(item.id)}
                  onLongPress={() => selection.begin(item.id)}
                  onToggle={() => selection.toggle(item.id)}
                />
              )
            }}
          />
        </GestureDetector>
      ) : (
        <FlatList
          ref={listRef}
          data={sorted}
          keyExtractor={(it) => it.id}
          contentContainerStyle={{
            padding: GUTTER,
            paddingRight: showAzRail ? GUTTER + AZ_RAIL_WIDTH : GUTTER,
            paddingBottom: contentInset,
            gap: spacing.sm,
          }}
          onScroll={onScroll}
          scrollEventThrottle={16}
          refreshControl={refreshControl}
          onScrollToIndexFailed={({ index, averageItemLength }) => {
            listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: true })
          }}
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
      {showAzRail && sorted.length > 0 && (
        <AzRail available={available} onJump={onJump} reversed={desc} />
      )}

      {/* One-time discoverability hint for pinch-to-resize (grid only). */}
      {showPinchHint && display === 'grid' && sorted.length > 0 && !selection.selecting && (
        <View style={styles.pinchHint}>
          <Icon name={icons.tune} size={15} color={colors.brandHearth} />
          <AppText variant="caption" color={colors.brandHearth}>
            Pinch to resize
          </AppText>
          <Touchable onPress={dismissPinchHint} hitSlop={8}>
            <AppText variant="caption" color={colors.brandShelf} style={{ fontWeight: '700' }}>
              Got it
            </AppText>
          </Touchable>
        </View>
      )}

      {/* Scroll-to-top: only when the A-Z rail isn't already handling navigation,
          and never over the selection toolbar. */}
      <ScrollTopButton
        visible={scrolledDeep && !showAzRail && !selection.selecting}
        onPress={scrollToTop}
        bottom={railInset}
      />

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
                manualGridCols.current = false
                setSize(s)
                setGridCols(adaptiveLibraryColumns(width, s))
              }}
            />
          </View>
        )}

        {sheetTab === 'sort' && (
          <ScrollView style={styles.sheetScroll}>
            <Touchable
              onPress={() => {
                sheetRef.current?.dismiss()
                selection.begin()
              }}
              style={styles.sheetRow}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Icon name={icons.checklist} size={18} color={colors.text} />
                <AppText variant="body">Select books</AppText>
              </View>
            </Touchable>
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
    </Animated.View>
  )
}

/** Skeleton grid shown while the library's first page loads, mirroring the
 *  real grid so content lands without reflow. */
function LibrarySkeleton({ width, cols }: { width: number; cols: number }) {
  const contentInset = useContentInset()
  const tileWidth = adaptiveGridTileWidth({ width, cols, gutter: GUTTER })
  const rows = Array.from({ length: cols * 4 })
  return (
    <View style={{ flex: 1 }}>
      <View style={{ height: 54 }} />
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          gap: GUTTER,
          padding: GUTTER,
          paddingBottom: contentInset,
        }}
      >
        {rows.map((_, i) => (
          <SkeletonTile key={i} width={tileWidth} />
        ))}
      </View>
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
  const colors = useColors()
  const styles = useStyles()
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
  const colors = useColors()
  const styles = useStyles()
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
  const colors = useColors()
  const styles = useStyles()
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
  const colors = useColors()
  const styles = useStyles()
  return (
    <Touchable
      style={[styles.listRow, selected && styles.listRowSelected]}
      onPress={() => (selecting ? onToggle?.() : router.push(`/item/${item.id}?from=library`))}
      onLongPress={onLongPress}
    >
      {selecting ? (
        <View style={[styles.rowCheck, selected && styles.rowCheckOn]}>
          {selected ? <Icon name={icons.check} size={15} color={colors.onAccent} /> : null}
        </View>
      ) : null}
      <Cover
        uri={coverUrl(item.id)}
        itemId={item.id}
        size={46}
        radius={radius.tile}
        fallback={{ hue: coverHue(item.id), initial: itemTitle(item).charAt(0).toUpperCase() }}
        showDownloadBadge
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
  /** Number of books/titles in the group; drives the "# of books" sort. */
  count: number
  covers: ABSLibraryItem[]
  /** Single avatar image (authors/narrators); series use stacked covers instead. */
  avatarUri?: string
}

type GroupSort = 'name' | 'count'

function GroupsView({ libraryId, mode }: { libraryId: string; mode: ViewMode }) {
  const router = useRouter()
  const colors = useColors()
  const styles = useStyles()
  const contentInset = useContentInset()
  const [groups, setGroups] = useState<GroupRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // Re-run the load when the offline catalog changes (hydrate finishing, a new
  // download), so offline groups appear once the catalog is populated.
  const catalogVersion = useSyncExternalStore(subscribeCatalog, getCatalogState)
  // Sort name-ascending by default; tapping the active sort flips its direction.
  const [sort, setSort] = useState<GroupSort>('name')
  const [desc, setDesc] = useState(false)
  const listRef = useRef<FlatList<GroupRow>>(null)

  const toggleSort = (next: GroupSort) => {
    if (next === sort) {
      setDesc((d) => !d)
    } else {
      setSort(next)
      // Counts read most naturally high-to-low; names low-to-high.
      setDesc(next === 'count')
    }
  }

  const sorted = useMemo(() => {
    if (!groups) return groups
    const rows = [...groups]
    rows.sort((a, b) => (sort === 'count' ? a.count - b.count : a.name.localeCompare(b.name)))
    if (desc) rows.reverse()
    return rows
  }, [groups, sort, desc])

  // The rail rides the name-sorted list (either direction); buckets by the
  // group's first letter, matching the localeCompare order.
  const showAzRail = sort === 'name'
  const letterIndex = useMemo(() => {
    const map = new Map<string, number>()
    ;(sorted ?? []).forEach((g, i) => {
      const l = letterOf(g.name)
      if (!map.has(l)) map.set(l, i)
    })
    return map
  }, [sorted])
  const available = useMemo(() => new Set(letterIndex.keys()), [letterIndex])
  const onJump = useCallback(
    (letter: string) => {
      const idx = letterIndex.get(letter)
      if (idx == null) return
      listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0 })
    },
    [letterIndex],
  )

  // `blank` clears the list first (initial load / mode switch); a pull-to-refresh
  // leaves the current rows in place and just refetches under the pull spinner.
  const load = useCallback(
    async (opts?: { blank?: boolean; signal?: () => boolean }) => {
      const cancelled = opts?.signal ?? (() => false)
      if (opts?.blank) setGroups(null)
      setError(null)
      try {
        if (mode === 'series') {
          const series = await getLibrarySeries(libraryId)
          if (cancelled()) return
          setGroups(series.map((s: ABSSeries) => seriesToRow(s)))
        } else if (mode === 'authors') {
          const authors = await getLibraryAuthors(libraryId)
          if (cancelled()) return
          setGroups(authors.map((a: ABSLibraryAuthor) => authorToRow(a)))
        } else {
          const narrators = await getLibraryNarrators(libraryId)
          if (cancelled()) return
          setGroups(narrators.map((n: ABSNarrator) => narratorToRow(n)))
        }
      } catch (e) {
        if (cancelled()) return
        // Offline: build the groups from downloaded books instead of erroring.
        const offline = offlineGroups(mode)
        if (offline.length > 0) setGroups(offline)
        else setError((e as Error).message)
      }
    },
    [libraryId, mode],
  )

  useEffect(() => {
    let cancelled = false
    void load({ blank: true, signal: () => cancelled })
    return () => {
      cancelled = true
    }
  }, [load, catalogVersion])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await load()
    } finally {
      setRefreshing(false)
    }
  }, [load])

  if (error) {
    return (
      <Centered>
        <AppText variant="meta" color={colors.destructive}>
          {error}
        </AppText>
      </Centered>
    )
  }
  if (!sorted) return <Loading />
  if (sorted.length === 0) {
    return (
      <Centered>
        <AppText variant="meta" color={colors.textMuted}>
          Nothing here yet.
        </AppText>
      </Centered>
    )
  }

  const countLabel = mode === 'series' ? 'Books' : 'Titles'

  return (
    <Animated.View entering={FadeIn.duration(DUR.base)} style={{ flex: 1 }}>
      <View style={[styles.groupControlRow, showAzRail && { paddingRight: 30 }]}>
        <AppText variant="caption" color={colors.textMuted}>
          {sorted.length} {mode === 'series' ? 'series' : mode}
        </AppText>
        <View style={styles.groupSorts}>
          <GroupSortBtn
            label="Name"
            active={sort === 'name'}
            desc={desc}
            onPress={() => toggleSort('name')}
          />
          <GroupSortBtn
            label={countLabel}
            active={sort === 'count'}
            desc={desc}
            onPress={() => toggleSort('count')}
          />
        </View>
      </View>
      <FlatList
        ref={listRef}
        data={sorted}
        keyExtractor={(g) => g.key}
        contentContainerStyle={{
          padding: spacing.md,
          paddingRight: showAzRail ? spacing.md + AZ_RAIL_WIDTH : spacing.md,
          paddingBottom: contentInset,
        }}
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: true })
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
            colors={[colors.accent]}
          />
        }
        renderItem={({ item }) => (
          <Touchable
            style={styles.groupRow}
            onPress={() =>
              router.push(
                mode === 'series'
                  ? `/series/${encodeURIComponent(item.key)}?libraryId=${encodeURIComponent(libraryId)}&from=library`
                  : `/group/${mode}/${encodeURIComponent(item.key)}?libraryId=${encodeURIComponent(libraryId)}&name=${encodeURIComponent(item.name)}&from=library`,
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
      {showAzRail && <AzRail available={available} onJump={onJump} reversed={desc} />}
    </Animated.View>
  )
}

function GroupSortBtn({
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
  const colors = useColors()
  const styles = useStyles()
  return (
    <Touchable style={[styles.groupSortBtn, active && styles.groupSortBtnActive]} onPress={onPress}>
      <AppText variant="caption" color={active ? colors.text : colors.textMuted}>
        {label}
      </AppText>
      {active && <Icon name={desc ? icons.collapse : icons.expand} size={16} color={colors.text} />}
    </Touchable>
  )
}

function seriesToRow(s: ABSSeries): GroupRow {
  const count = s.books.length
  return {
    key: s.id,
    name: s.name,
    sub: `${count} ${count === 1 ? 'book' : 'books'}`,
    count,
    covers: s.books,
  }
}

/** Build group rows from downloaded books when offline (series/authors/narrators).
 *  Series use the same stacked-cover row as online; authors/narrators show counts
 *  (their avatar art needs the server, so it falls back to initials offline). */
function offlineGroups(mode: ViewMode): GroupRow[] {
  if (mode === 'series') {
    return catalogSeries().map((s) => ({
      key: s.id,
      name: s.name,
      sub: `${s.books.length} ${s.books.length === 1 ? 'book' : 'books'}`,
      count: s.books.length,
      covers: s.books,
    }))
  }
  const groups = mode === 'authors' ? catalogAuthors() : catalogNarrators()
  return groups.map((g) => ({
    key: g.name,
    name: g.name,
    sub: `${g.count} ${g.count === 1 ? 'title' : 'titles'}`,
    count: g.count,
    covers: [],
  }))
}

function authorToRow(a: ABSLibraryAuthor): GroupRow {
  return {
    key: a.id,
    name: a.name,
    sub: `${a.numBooks} ${a.numBooks === 1 ? 'title' : 'titles'}`,
    count: a.numBooks,
    covers: [],
    avatarUri: authorImageUrl(a.id),
  }
}

function narratorToRow(n: ABSNarrator): GroupRow {
  return {
    key: n.id,
    name: n.name,
    sub: `${n.numBooks} ${n.numBooks === 1 ? 'title' : 'titles'}`,
    count: n.numBooks,
    covers: [],
    // HearthShelf's custom narrator photo, keyed by name; falls back to initials.
    avatarUri: narratorImageUrl(n.name),
  }
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
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
      gap: 5,
      maxWidth: 200,
      paddingHorizontal: spacing.md - 2,
      paddingVertical: 7,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    libPickRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
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
    // GroupsView's own Name/count sort row.
    groupControlRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    // Persistent control bar: sort/filter chips + layout & select icon buttons.
    controlBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
    },
    ctrlChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingLeft: spacing.md - 2,
      paddingRight: spacing.md - 2,
      paddingVertical: 7,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    ctrlBadge: {
      minWidth: 17,
      height: 17,
      paddingHorizontal: 4,
      borderRadius: 9,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    ctrlBadgeText: { fontSize: 10, fontWeight: '700', lineHeight: 14 },
    offlineChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      marginLeft: spacing.md,
      marginBottom: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    pinchHint: {
      position: 'absolute',
      alignSelf: 'center',
      bottom: 112,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingLeft: spacing.md,
      paddingRight: spacing.md,
      paddingVertical: 10,
      borderRadius: radius.pill,
      // Solid elevated surface with an accent border so the pill is clearly
      // visible in every theme (the old accent-wash bg read as transparent).
      backgroundColor: colors.elevated,
      borderWidth: 1,
      borderColor: colors.accent,
      // Lift above the grid: on Android draw order follows elevation, not
      // zIndex, so the FlatList tiles would otherwise paint over the pill.
      zIndex: 50,
      elevation: 12,
    },
    ctrlIconBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    groupSorts: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    groupSortBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
      paddingLeft: spacing.sm,
      paddingRight: 5,
      paddingVertical: 5,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'transparent',
    },
    groupSortBtnActive: {
      backgroundColor: colors.fill,
      borderColor: colors.hairline,
    },
    filterChips: {
      flexDirection: 'row',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
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

// Hook: the memoized stylesheet for the active palette.
function useStyles() {
  const colors = useColors()
  return useMemo(() => makeStyles(colors), [colors])
}
