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
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import {
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  FadeIn,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import type {
  ABSLibrary,
  ABSLibraryItem,
  ABSLibraryAuthor,
  ABSMediaProgress,
  ABSNarrator,
  ABSSeries,
  LibrarySort,
} from '@hearthshelf/core'
import {
  letterOf,
  coverHue,
  applyLibraryFilters,
  filterChipLabel,
  FILTER_GROUPS,
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
import { DUR, LIFT, useReducedMotion } from '@/ui/motion'
import { haptics } from '@/ui/haptics'
import { onTabReselect } from '@/ui/tabReselect'
import { BookTile } from '@/ui/BookTile'
import { EmptyState, ErrorState, SkeletonTile } from '@/ui/states'
import { playItemById } from '@/player/playback'
import { useConnection } from '@/api/ConnectionProvider'
import { fetchSeriesGapSummaries, type SeriesGapSummary } from '@/api/absAudible'
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
import { getSettingsState, subscribeSettings, COVER_ASPECT_RATIO } from '@/store/settings'
import { useContentInset, useMiniPlayerInset } from '@/ui/useContentInset'
import { useBackHandler, useSheetBackHandler } from '@/ui/useBackHandler'
import { useBottomSheetModal } from '@gorhom/bottom-sheet'
import { useBookSelection } from '@/ui/useBookSelection'
import { AzRail, AZ_RAIL_WIDTH } from '@/ui/AzRail'
import { ScrollTopButton } from '@/ui/ScrollTopButton'
import { radius, spacing, MAX_FONT_SCALE_FIXED, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { adaptiveGridColumns, adaptiveGridTileWidth, adaptiveLibraryColumns } from '@/ui/responsive'

const GUTTER = spacing.lg
// Reveal the scroll-to-top button once the list is roughly 1.5 screens deep.
const SCROLL_TOP_THRESHOLD = 900
// Scroll depth at which the title + search band collapses. Roughly the band's
// own height, so it leaves exactly as it would have scrolled away anyway.
const HEADER_COLLAPSE_AT = 120
// The control bar's icon buttons are a 38pt box; this carries the effective
// target past the 44/48 platform minimum without growing the bar itself.
const CTRL_ICON_HITSLOP = 6
// The Groups Name/count sort buttons are small by design (they sit inline with
// a count label); expand the target rather than the pill.
const GROUP_SORT_HITSLOP = 10

/** The screen-body entrance, dropped entirely under Reduce Motion. */
function useEnterAnim() {
  const reduceMotion = useReducedMotion()
  return reduceMotion ? undefined : FadeIn.duration(DUR.base)
}
// One-time grid "Pinch to resize" hint (device-local).
const PINCH_HINT_KEY = 'hs.libraryPinchHint'
// How you browse (sort, direction, layout, cover size, filters), remembered
// device-locally. Leaving the tab and coming back used to reset all of it, so a
// large library got re-configured every single session.
const VIEW_PREFS_KEY = 'hs.libraryViewPrefs'
// A BookTile's non-cover height: two caption lines (11px at ~1.3 line height)
// plus the meta block's top margin and inter-line gap. Used only to estimate a
// grid row for A-Z jumps into unmeasured rows.
const TILE_META_HEIGHT = 34

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
    // Validate against what the TRAY can render, not against core's full list.
    // Core has 'Size' and 'Author (Last, First)'; the phone tray deliberately
    // doesn't. Accepting one of those stranded you in a sort the sheet showed
    // as inactive and offered no way to leave except picking something else.
    const sort =
      params.sort && SELECTABLE_SORTS.includes(params.sort as LibrarySort)
        ? (params.sort as LibrarySort)
        : undefined
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

  // Collapsing title + search. The child list reports when it has scrolled past
  // the header's own height; we fade and lift the band out, and give the space
  // back to the covers.
  const [collapsed, setCollapsed] = useState(false)
  const reduceMotion = useReducedMotion()
  const collapse = useSharedValue(0)
  // Measured, not hardcoded: the hero title and the search label both scale
  // with the OS font size, so a fixed height would clip at 1.6x.
  const bandHeight = useSharedValue(0)
  useEffect(() => {
    collapse.value = withTiming(collapsed ? 1 : 0, {
      duration: reduceMotion ? DUR.fast : DUR.base,
    })
  }, [collapsed, reduceMotion, collapse])
  const collapsingStyle = useAnimatedStyle(() => {
    // Before the first measurement, render at natural height so the band is
    // never invisible on mount.
    if (bandHeight.value === 0) return { opacity: 1 }
    return {
      opacity: 1 - collapse.value,
      height: bandHeight.value * (1 - collapse.value),
      // Under Reduce Motion the band still has to leave - it is a layout
      // change, not decoration - it just crossfades instead of sliding.
      transform: reduceMotion ? [] : [{ translateY: -collapse.value * LIFT.micro.distance }],
      overflow: 'hidden' as const,
    }
  })
  const onBandLayout = useCallback(
    (e: LayoutChangeEvent) => {
      const h = e.nativeEvent.layout.height
      if (h > 0 && bandHeight.value === 0) bandHeight.value = h
    },
    [bandHeight],
  )

  // Switching views resets the collapse so the search box is never stranded
  // offscreen on a list that is already at the top.
  useEffect(() => setCollapsed(false), [viewMode])

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
        {/* Clearing libError re-arms the focus effect above, which already
            retries when a prior attempt errored - so Try again just drops the
            error and lets the existing self-heal path run. */}
        <ErrorState message={libError} onRetry={() => setLibError(null)} />
      </Screen>
    )
  }

  return (
    <Screen>
      {/* Title + search collapse once you are into the shelf: five stacked
          control bands pushed the first cover ~240px down the screen, on a
          product whose whole doctrine is that covers lead. The view chips
          below are NAVIGATION and never collapse. */}
      <Animated.View style={collapsingStyle} onLayout={onBandLayout}>
        <View style={styles.header}>
          <AppText variant="hero">Library</AppText>
          {libraries.length > 1 && (
            <LibrarySwitcher libraries={libraries} activeId={libraryId} onSelect={setLibraryId} />
          )}
        </View>

        {/* Search routes to the ONE unified search screen (D-SEARCH). */}
        <Touchable
          onPress={() => router.push('/search?from=library')}
          style={styles.searchBox}
          accessibilityRole="search"
          accessibilityLabel="Search books, series and people"
        >
          <IconButton name={icons.search} size={20} color={colors.textMuted} />
          <AppText variant="meta" color={colors.textFaint} style={{ flex: 1 }}>
            Search books, series, people…
          </AppText>
        </Touchable>
      </Animated.View>

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
        <BooksView
          libraryId={libraryId}
          width={width}
          preset={preset}
          onCollapseChange={setCollapsed}
        />
      ) : (
        <GroupsView libraryId={libraryId} mode={viewMode} onCollapseChange={setCollapsed} />
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
                  <AppText
                    variant="body"
                    color={isActive ? colors.accent : colors.text}
                    numberOfLines={1}
                  >
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

/** The browse preferences persisted under VIEW_PREFS_KEY. */
type ViewPrefs = {
  sort: LibrarySort
  desc: boolean
  display: DisplayMode
  size: CoverSize
  filters: string[]
}

/** Read persisted browse prefs, discarding anything this build can no longer
 *  render (a sort removed from the tray, a filter group since retired). */
function parseViewPrefs(raw: string | null): Partial<ViewPrefs> | null {
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Partial<ViewPrefs>
    const out: Partial<ViewPrefs> = {}
    if (p.sort && SELECTABLE_SORTS.includes(p.sort)) out.sort = p.sort
    if (typeof p.desc === 'boolean') out.desc = p.desc
    if (p.display === 'grid' || p.display === 'list') out.display = p.display
    if (p.size === 'comfortable' || p.size === 'compact') out.size = p.size
    if (Array.isArray(p.filters)) {
      out.filters = p.filters.filter(
        (f) => typeof f === 'string' && CURATED_FILTER_GROUPS.includes(f.split('|')[0]),
      )
    }
    return out
  } catch {
    return null
  }
}

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
// Every sort the tray can actually show as active, and therefore the only ones
// a deep-link may put us into. The single source of truth for that question.
const SELECTABLE_SORTS: LibrarySort[] = [...CURATED_SORTS, ...MORE_SORTS]
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
  onCollapseChange,
}: {
  libraryId: string
  width: number
  preset?: BooksPreset
  /** Reports when the shelf has scrolled past the screen header's own height,
   *  so the title + search band can collapse and give the room to covers. */
  onCollapseChange?: (collapsed: boolean) => void
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
  // Back cancels a selection before it does anything else. Registered here
  // rather than in LibraryScreen because the selection state lives in this
  // component - the screen-level handler cannot see it, so back used to leave
  // for Home mid-selection and silently discard everything picked. Registered
  // after the screen's handler, and BackHandler fires the newest first.
  const { dismiss: dismissSheet } = useBottomSheetModal()
  useBackHandler(
    useCallback(() => {
      // A sheet still wins. This handler registers after the screen's sheet
      // handler (child mounts later, and BackHandler fires newest first), so it
      // would otherwise swallow the press while "add to list" or the overflow
      // sheet is open - both reachable from the selection toolbar. dismiss()
      // returns true only when a sheet was actually open.
      if (dismissSheet()) return true
      selection.clear()
      return true
    }, [selection, dismissSheet]),
    selection.selecting,
  )

  // A LIST of active filters, ANDed. One at a time was not enough on a large
  // catalog: a genre alone can still leave hundreds of books, and picking a
  // second filter silently replaced the first.
  const [filters, setFilters] = useState<string[]>([])
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
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const y = e.nativeEvent.contentOffset.y
      setScrolledDeep(y > SCROLL_TOP_THRESHOLD)
      // Hysteresis: collapse past the band, restore well before it, so a list
      // resting near the threshold cannot flicker open and shut while scrolling.
      onCollapseChange?.(y > HEADER_COLLAPSE_AT)
    },
    [onCollapseChange],
  )
  const scrollToTop = useCallback(() => {
    listRef.current?.scrollToOffset({ offset: 0, animated: true })
  }, [])
  // Re-tapping the Library tab while already on it scrolls back to the top.
  useEffect(() => onTabReselect('library', scrollToTop), [scrollToTop])

  // Restore how the user last browsed. Skipped entirely when a deep-link preset
  // is present - an explicit "show me Recently Added" must not be overwritten by
  // last session's Title sort. `prefsReady` gates the save effect so the initial
  // defaults are never written back over what's on disk.
  const [prefsReady, setPrefsReady] = useState(false)
  useEffect(() => {
    if (preset) {
      setPrefsReady(true)
      return
    }
    let cancelled = false
    void AsyncStorage.getItem(VIEW_PREFS_KEY).then((raw) => {
      if (cancelled) return
      const p = parseViewPrefs(raw)
      if (p) {
        if (p.sort) setSort(p.sort)
        if (p.desc !== undefined) setDesc(p.desc)
        if (p.display) setDisplay(p.display)
        if (p.size) setSize(p.size)
        if (p.filters) setFilters(p.filters)
      }
      setPrefsReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [preset])

  // Persist browse prefs whenever they change (after the restore has landed).
  useEffect(() => {
    if (!prefsReady) return
    const prefs: ViewPrefs = { sort, desc, display, size, filters }
    void AsyncStorage.setItem(VIEW_PREFS_KEY, JSON.stringify(prefs))
  }, [prefsReady, sort, desc, display, size, filters])

  // Apply an incoming deep-link preset (from Home's shelf headers).
  useEffect(() => {
    if (!preset) return
    if (preset.sort) setSort(preset.sort)
    setDesc(preset.desc)
    if (preset.filter) setFilters([preset.filter])
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

  // `progress` is a fresh Map on every store emission, and the store emits
  // continuously while audio plays - which this screen is designed to sit open
  // through. Depending on progressOf unconditionally re-filtered and re-sorted
  // the entire library on every tick, even on a Title sort where progress has
  // no bearing on the result. Depend on it only where it actually decides
  // something; otherwise hold a stable identity so the memos survive the tick.
  const filtersUseProgress = useMemo(
    () => filters.some((f) => f.startsWith('progress|')),
    [filters],
  )
  const usesProgress = filtersUseProgress || sort === 'Progress'
  // The dep flips identity only when progress actually matters. The ref keeps
  // the LOOKUP current regardless, so the memo body never reads a stale map on
  // the recomputes it does run.
  const progressRef = useRef(progressOf)
  progressRef.current = progressOf
  const progressDep = usesProgress ? progressOf : null

  const filtered = useMemo(
    () => (items ? applyLibraryFilters(items, filters, progressRef.current) : []),
    // progressOf is reached through progressRef; progressDep decides when a
    // progress change should force a recompute at all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, filters, progressDep],
  )
  const sorted = useMemo(
    () => sortItems(filtered, sort, desc, progressRef.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [filtered, sort, desc, progressDep],
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
  // The A-Z rail runs on any alphabetical (Title/Author) sort, in BOTH grid and
  // list. It was list-only so grid covers could keep the full row width, but
  // grid is the default view and Title the default sort - so the default state
  // of a large library had no jump navigation at all, only a scroll-to-top
  // button after ~900px. The rail costs one tile column at most (tileWidth
  // already shrinks by railReserve below), and it is the only thumb-reachable
  // control on the screen. Works in either direction: letterIndex is built from
  // the already-sorted list, so a desc sort just gives Z-first buckets.
  const alphabetical = sort === 'Title' || sort === 'Author'
  const showAzRail = alphabetical

  // Tiles fill the row exactly; when the rail reserves space on the right, shrink
  // them so the last column isn't pushed under the rail.
  const railReserve = showAzRail ? AZ_RAIL_WIDTH : 0
  const tileWidth = adaptiveGridTileWidth({
    width,
    cols,
    gutter: GUTTER,
    reserved: railReserve,
  })
  // Estimated grid row height, used to land an A-Z jump into rows FlatList
  // hasn't measured yet. Cover height follows the user's aspect setting; the
  // rest is the tile's meta block (two caption lines + gaps) and its bottom
  // margin. An estimate, not a measurement - tiles with a progress bar or a
  // two-line title run a few px taller, which the animated scroll absorbs.
  const { coverAspect } = useSyncExternalStore(subscribeSettings, getSettingsState)
  const estRowHeight = useMemo(
    () => tileWidth / COVER_ASPECT_RATIO[coverAspect] + TILE_META_HEIGHT + spacing.md,
    [tileWidth, coverAspect],
  )

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
      // In list view an item IS a row. In grid, `cols` items share a row, and
      // FlatList indexes by row - so scrolling to the raw item index would
      // overshoot by a factor of cols.
      const index = display === 'grid' ? Math.floor(idx / cols) : idx
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 })
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

  // Reduce Motion: the entrance is a layout arrival, not decoration, so the
  // surface still appears - it just does so instantly instead of fading.
  // Above the early returns: hooks must run in the same order every render.
  const enterAnim = useEnterAnim()

  if (!items && !error) return <LibrarySkeleton width={width} cols={defaultGridCols} />
  if (error) {
    return (
      // A raw exception string in destructive red was the harshest thing this
      // dark-room app could show, and there was nothing to tap - recovery meant
      // backgrounding the app. In the car that is unreadable and unactionable.
      <ErrorState message={error} onRetry={() => void load({ blank: true })} />
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
    <Animated.View entering={enterAnim} style={{ flex: 1 }}>
      {selection.selecting ? (
        <BookSelectionToolbar selection={selection} books={sorted} libraryId={libraryId} />
      ) : (
        // Persistent control bar: sort chip (tap flips direction, chevron opens
        // the sheet), filter chip with an active-count badge, and grid/list +
        // Select buttons. The full Display/Sort/Filter sheet stays behind these.
        <View style={[styles.controlBar, showAzRail && { paddingRight: 28 }]}>
          <Touchable
            style={styles.ctrlChip}
            onPress={() => chooseSort(sort)}
            accessibilityRole="button"
            accessibilityLabel={`Sort: ${sort}, ${desc ? 'descending' : 'ascending'}. Tap to reverse.`}
          >
            <Icon
              name={desc ? icons.arrowDownward : icons.arrowUpward}
              size={15}
              color={colors.accent}
            />
            <AppText variant="caption">{sort}</AppText>
            <Touchable
              onPress={() => openSheet('sort')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Change sort order"
            >
              <Icon name={icons.collapse} size={15} color={colors.textMuted} />
            </Touchable>
          </Touchable>
          <Touchable
            style={styles.ctrlChip}
            onPress={() => openSheet('filter')}
            accessibilityRole="button"
            accessibilityLabel={filters.length ? `Filters, ${filters.length} active` : 'Filters'}
          >
            <Icon name={icons.filter} size={15} color={colors.text} />
            <AppText variant="caption">Filters</AppText>
            {filters.length > 0 ? (
              <View style={styles.ctrlBadge}>
                <AppText variant="caption" color={colors.onAccent} style={styles.ctrlBadgeText}>
                  {filters.length}
                </AppText>
              </View>
            ) : null}
          </Touchable>
          <View style={{ flex: 1 }} />
          <Touchable
            style={styles.ctrlIconBtn}
            hitSlop={CTRL_ICON_HITSLOP}
            onPress={() => setDisplay((d) => (d === 'grid' ? 'list' : 'grid'))}
            accessibilityRole="button"
            accessibilityLabel={display === 'grid' ? 'Switch to list view' : 'Switch to grid view'}
          >
            <Icon
              name={display === 'grid' ? icons.viewList : icons.viewGrid}
              size={19}
              color={colors.text}
            />
          </Touchable>
          <Touchable
            style={styles.ctrlIconBtn}
            hitSlop={CTRL_ICON_HITSLOP}
            onPress={() => selection.begin()}
            accessibilityRole="button"
            accessibilityLabel="Select books"
          >
            <Icon name={icons.checklist} size={19} color={colors.text} />
          </Touchable>
        </View>
      )}

      {/* Applied filters as removable chips + a clear-all, so it's obvious what's
          active and easy to undo without opening the tray. */}
      {filters.length > 0 && (
        <View style={styles.filterChips}>
          {filters.map((f) => (
            <Touchable
              key={f}
              style={styles.filterChip}
              onPress={() => setFilters((prev) => prev.filter((x) => x !== f))}
              accessibilityLabel={`Remove filter ${filterChipLabel(f)}`}
            >
              {/* filterChipLabel, not filterLabel: a bare "Finished" could be a
                  progress state or a genre. The chip says which. */}
              <AppText variant="caption" color={colors.onAccent}>
                {filterChipLabel(f)}
              </AppText>
              <IconButton
                name={icons.close}
                size={13}
                color={colors.onAccent}
                accessibilityLabel={`Remove ${filterChipLabel(f)}`}
              />
            </Touchable>
          ))}
          {filters.length > 1 ? (
            <Touchable onPress={() => setFilters([])} hitSlop={8} style={styles.clearFilters}>
              <AppText variant="caption" color={colors.textMuted}>
                Clear all
              </AppText>
            </Touchable>
          ) : null}
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
          title={filters.length ? 'No books match these filters' : 'No books in this library yet'}
          body={
            filters.length
              ? 'Try clearing a filter to see more of your library.'
              : 'Switch to another library or add books on your server.'
          }
          cta={filters.length ? 'Clear filters' : undefined}
          onCta={filters.length ? () => setFilters([]) : undefined}
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
            // Windowing for a library that is routinely 700+ items. Rendering
            // three screens' worth keeps an A-Z fling from hitting blank space
            // without mounting the whole shelf.
            initialNumToRender={cols * 4}
            maxToRenderPerBatch={cols * 3}
            windowSize={5}
            removeClippedSubviews
            onScrollToIndexFailed={({ index }) => {
              // `index` is already a ROW index here (onJump converts, and
              // FlatList reports rows for a multi-column list), so do NOT divide
              // by cols again - that lands near the top of the library instead
              // of at the letter. Row height is the tile plus its meta lines,
              // and the cover's height follows the USER'S aspect setting - the
              // old hardcoded 1.5 (2:3) overshot by a third on the square
              // default, so an A-Z jump landed well past the letter.
              listRef.current?.scrollToOffset({
                offset: index * estRowHeight,
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
          initialNumToRender={12}
          maxToRenderPerBatch={10}
          windowSize={5}
          removeClippedSubviews
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

        {sheetTab === 'filter' &&
          (openGroup ? (
            // The drill-in owns its own scroller so its search field can stay
            // pinned above the values instead of scrolling away with them.
            <FilterValues
              group={openGroup}
              items={items ?? []}
              active={filters}
              onBack={() => setOpenGroup(null)}
              onPick={(f) => {
                // Toggle within the list rather than replacing it: picking a
                // second filter used to silently drop the first. Re-picking
                // the same value clears just that one. The drill-in deliberately
                // stays open - ticking three values should not cost three trips.
                setFilters((prev) =>
                  prev.includes(f) ? prev.filter((x) => x !== f) : [...prev, f],
                )
              }}
            />
          ) : (
            <ScrollView style={styles.sheetScroll}>
              <Touchable onPress={() => setFilters([])} style={styles.sheetRow}>
                <AppText variant="body" color={!filters.length ? colors.accent : colors.text}>
                  All titles
                </AppText>
                {!filters.length && <IconButton name={icons.checkCircle} color={colors.accent} />}
              </Touchable>
              {CURATED_FILTER_GROUPS.map((gid) => {
                const group = FILTER_GROUPS.find((g) => g.id === gid)
                if (!group) return null
                const inGroup = filters.filter((f) => f.startsWith(`${gid}|`))
                const activeInGroup = inGroup.length > 0
                return (
                  <Touchable key={gid} onPress={() => setOpenGroup(gid)} style={styles.sheetRow}>
                    <AppText variant="body" color={activeInGroup ? colors.accent : colors.text}>
                      {group.label}
                    </AppText>
                    <View style={styles.filterRowTrail}>
                      {activeInGroup && (
                        <AppText variant="caption" color={colors.accent} numberOfLines={1}>
                          {inGroup.length > 1
                            ? `${inGroup.length} selected`
                            : inGroup[0].split('|')[1]}
                        </AppText>
                      )}
                      <IconButton name={icons.chevronRight} color={colors.textMuted} />
                    </View>
                  </Touchable>
                )
              })}
            </ScrollView>
          ))}
      </Sheet>
    </Animated.View>
  )
}

/** Skeleton grid shown while the library's first page loads, mirroring the
 *  real grid so content lands without reflow. */
function LibrarySkeleton({ width, cols }: { width: number; cols: number }) {
  const contentInset = useContentInset()
  // Match the user's cover shape. SkeletonTile defaults to 2:3, but the app's
  // default cover aspect is square - so placeholders were snapping to a
  // different shape the moment real covers landed, in the one component whose
  // whole job is landing without reflow.
  const { coverAspect } = useSyncExternalStore(subscribeSettings, getSettingsState)
  const aspect = COVER_ASPECT_RATIO[coverAspect]
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
          <SkeletonTile key={i} width={tileWidth} aspectRatio={aspect} />
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

/** Below this many values a search field is more clutter than help - Progress
 *  has four options and Language usually two. */
const FILTER_SEARCH_THRESHOLD = 12

/** Drill-in list of a filter group's available values (derived from the items).
 *
 *  Search-first, not list-first: on a 715-book library the Author group is
 *  300-500 names, which is not a list anyone scrolls. The field sits outside
 *  the scroller so it never scrolls away, and picking a value does NOT close
 *  the drill-in - you tick several and leave when you're done. */
function FilterValues({
  group,
  items,
  active,
  onBack,
  onPick,
}: {
  group: string
  items: ABSLibraryItem[]
  /** Every active filter, so several values in one group can be ticked. */
  active: string[]
  onBack: () => void
  onPick: (filter: string) => void
}) {
  const colors = useColors()
  const styles = useStyles()
  const [query, setQuery] = useState('')
  const def = FILTER_GROUPS.find((g) => g.id === group)

  // Values and their counts are derived once per group, not per keystroke.
  // The count turns blind scrolling into a decision ("Sanderson - 23").
  const { values, counts } = useMemo(() => {
    const vals = def ? def.values(items) : []
    const tally = new Map<string, number>()
    if (def) {
      // Count through the group's own accessor so the number always matches
      // what the filter will actually select. One item at a time is the only
      // way to attribute a value to a book, but the per-call uniq/sort is over
      // a single item's handful of values, not the library.
      const single: ABSLibraryItem[] = [items[0]]
      for (const it of items) {
        single[0] = it
        for (const v of def.values(single)) tally.set(v, (tally.get(v) ?? 0) + 1)
      }
    }
    return { values: vals, counts: tally }
  }, [def, items])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return values
    return values.filter((v) => v.toLowerCase().includes(q))
  }, [values, query])

  const searchable = values.length >= FILTER_SEARCH_THRESHOLD
  const activeInGroup = active.filter((f) => f.startsWith(`${group}|`)).length

  return (
    <View>
      <Touchable
        onPress={onBack}
        style={styles.filterBack}
        accessibilityRole="button"
        accessibilityLabel={`Back to filter groups from ${def?.label ?? 'filter'}`}
      >
        <IconButton name={icons.back} size={18} color={colors.textMuted} />
        <AppText variant="label" color={colors.textMuted}>
          {def?.label ?? 'Filter'}
        </AppText>
        {activeInGroup > 0 && (
          <AppText variant="caption" color={colors.accent}>
            {activeInGroup} selected
          </AppText>
        )}
      </Touchable>

      {searchable && (
        <View style={styles.filterSearch}>
          <IconButton name={icons.search} size={18} color={colors.textMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={`Search ${(def?.label ?? 'values').toLowerCase()}…`}
            placeholderTextColor={colors.textFaint}
            style={styles.input}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            maxFontSizeMultiplier={MAX_FONT_SCALE_FIXED}
            accessibilityLabel={`Search ${def?.label ?? 'values'}`}
          />
          {query.length > 0 && (
            <IconButton
              name={icons.close}
              size={18}
              color={colors.textMuted}
              onPress={() => setQuery('')}
              accessibilityLabel="Clear search"
            />
          )}
        </View>
      )}

      {values.length === 0 ? (
        <AppText variant="meta" color={colors.textMuted} style={{ paddingVertical: spacing.md }}>
          Nothing to filter by here.
        </AppText>
      ) : shown.length === 0 ? (
        <AppText variant="meta" color={colors.textMuted} style={{ paddingVertical: spacing.md }}>
          No matches for “{query.trim()}”.
        </AppText>
      ) : (
        <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled">
          {shown.map((v) => {
            const f = `${group}|${v}`
            const on = active.includes(f)
            const n = counts.get(v)
            return (
              <Touchable
                key={v}
                onPress={() => onPick(f)}
                style={styles.sheetRow}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                accessibilityLabel={n ? `${v}, ${n} books` : v}
              >
                <AppText
                  variant="body"
                  color={on ? colors.accent : colors.text}
                  numberOfLines={1}
                  style={{ flex: 1 }}
                >
                  {v}
                </AppText>
                <View style={styles.filterRowTrail}>
                  {n !== undefined && (
                    <AppText variant="caption" color={colors.textFaint}>
                      {n}
                    </AppText>
                  )}
                  {on && <IconButton name={icons.checkCircle} color={colors.accent} />}
                </View>
              </Touchable>
            )
          })}
        </ScrollView>
      )}
    </View>
  )
}

type BookListRowProps = {
  item: ABSLibraryItem
  selecting?: boolean
  selected?: boolean
  onLongPress?: () => void
  onToggle?: () => void
}

function BookListRowBase({
  item,
  selecting = false,
  selected = false,
  onLongPress,
  onToggle,
}: BookListRowProps) {
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

/** The list-mode twin of BookTile's memo. Callers pass fresh inline arrows on
 *  every render, so identity comparison would defeat the memo entirely and the
 *  whole list would re-render on any parent update - compare PRESENCE instead,
 *  which is all this row's output actually depends on. */
const BookListRow = memo(
  BookListRowBase,
  (a, b) =>
    a.item === b.item &&
    a.selecting === b.selecting &&
    a.selected === b.selected &&
    Boolean(a.onLongPress) === Boolean(b.onLongPress) &&
    Boolean(a.onToggle) === Boolean(b.onToggle),
)

interface GroupRow {
  key: string
  name: string
  sub: string
  /** Number of books/titles in the group; drives the "# of books" sort. */
  count: number
  covers: ABSLibraryItem[]
  /** Every book id in the group, for counting how many are finished. Only set
   *  for series - authors/narrators show a title count, not progress. */
  bookIds?: string[]
  /** Single avatar image (authors/narrators); series use stacked covers instead. */
  avatarUri?: string
}

type GroupSort = 'name' | 'count'

function GroupsView({
  libraryId,
  mode,
  onCollapseChange,
}: {
  libraryId: string
  mode: ViewMode
  onCollapseChange?: (collapsed: boolean) => void
}) {
  const router = useRouter()
  const colors = useColors()
  const styles = useStyles()
  const contentInset = useContentInset()
  const [groups, setGroups] = useState<GroupRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Gap counts for every swept series, in ONE request rather than one per row.
  // Empty offline or when the Audible catalog is off, which just means no
  // badges - see fetchSeriesGapSummaries.
  const [gaps, setGaps] = useState<ReadonlyMap<string, SeriesGapSummary>>(new Map())
  const [refreshing, setRefreshing] = useState(false)
  const onGroupsScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      onCollapseChange?.(e.nativeEvent.contentOffset.y > HEADER_COLLAPSE_AT)
    },
    [onCollapseChange],
  )
  // Re-run the load when the offline catalog changes (hydrate finishing, a new
  // download), so offline groups appear once the catalog is populated.
  const catalogVersion = useSyncExternalStore(subscribeCatalog, getCatalogState)
  // Finished state, so a series row can show how far through it you are.
  const progress = useSyncExternalStore(subscribeProgress, getProgressState).byId
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

  useEffect(() => {
    if (mode !== 'series') return
    let cancelled = false
    void fetchSeriesGapSummaries()
      .then((list) => {
        if (cancelled) return
        setGaps(new Map(list.map((g) => [g.seriesId, g])))
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [mode, libraryId])

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

  const enterAnim = useEnterAnim()

  if (error) {
    return <ErrorState message={error} onRetry={() => void load({ blank: true })} />
  }
  if (!sorted) return <Loading />
  if (sorted.length === 0) {
    // Books view gets a designed EmptyState with an icon, a reason and a way
    // out; this branch used to get a bare centered sentence. Same screen, same
    // dead end - it deserves the same treatment.
    return (
      <EmptyState
        icon={mode === 'series' ? icons.library : icons.person}
        iconColor={colors.textMuted}
        title={`No ${mode} in this library yet`}
        body={
          mode === 'series'
            ? 'Books grouped into a series will show up here.'
            : `Books tagged with a ${mode === 'authors' ? 'author' : 'narrator'} will show up here.`
        }
      />
    )
  }

  const countLabel = mode === 'series' ? 'Books' : 'Titles'

  return (
    <Animated.View entering={enterAnim} style={{ flex: 1 }}>
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
        initialNumToRender={14}
        maxToRenderPerBatch={12}
        windowSize={5}
        removeClippedSubviews
        onScroll={onGroupsScroll}
        scrollEventThrottle={16}
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
                {/* Owned-only progress: "3 of 7 finished" counts the books in
                    YOUR library, not the full Audible roster. Deliberate - the
                    roster is only available when the Audible catalog is turned
                    on, so a roster-based number would change meaning with a
                    server setting, and would read as a smaller percentage than
                    the shelf in front of you. The series detail page still shows
                    the fuller picture including missing books. */}
                {seriesProgressLabel(item, progress) ?? item.sub}
              </AppText>
              {/* Books the library doesn't hold, on their own line so the label
                  above keeps its owned-only meaning. Absent when the roster
                  hasn't been swept - unknown must not read as complete. */}
              {gapLabel(gaps.get(item.key)) ? (
                <AppText variant="caption" color={colors.accent}>
                  {gapLabel(gaps.get(item.key))}
                </AppText>
              ) : null}
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
    <Touchable
      style={[styles.groupSortBtn, active && styles.groupSortBtnActive]}
      onPress={onPress}
      hitSlop={GROUP_SORT_HITSLOP}
      accessibilityRole="button"
      accessibilityLabel={
        active
          ? `Sorted by ${label}, ${desc ? 'descending' : 'ascending'}. Tap to reverse.`
          : `Sort by ${label}`
      }
    >
      <AppText variant="caption" color={active ? colors.text : colors.textMuted}>
        {label}
      </AppText>
      {active && <Icon name={desc ? icons.collapse : icons.expand} size={16} color={colors.text} />}
    </Touchable>
  )
}

/**
 * "3 of 7 finished" for a series row, or null when there is nothing useful to
 * say (not a series, or no book in it has been finished) - the caller then falls
 * back to the plain book count.
 *
 * Counts only books in the user's own library. See the note at the call site.
 */
function seriesProgressLabel(
  row: GroupRow,
  progress: ReadonlyMap<string, ABSMediaProgress>,
): string | null {
  const ids = row.bookIds
  if (!ids || ids.length === 0) return null
  let finished = 0
  for (const id of ids) if (progress.get(id)?.isFinished) finished += 1
  if (finished === 0) return null
  return `${finished} of ${ids.length} finished`
}

/** "3 not in library · 1 coming soon" for a series row, or null when there is
 *  nothing to say (no roster, or the library holds everything released). */
function gapLabel(gap: SeriesGapSummary | undefined): string | null {
  if (!gap) return null
  const parts: string[] = []
  if (gap.missing > 0) parts.push(`${gap.missing} not in library`)
  if (gap.upcoming > 0) parts.push(`${gap.upcoming} coming soon`)
  return parts.length ? parts.join(' · ') : null
}

function seriesToRow(s: ABSSeries): GroupRow {
  const count = s.books.length
  return {
    key: s.id,
    name: s.name,
    sub: `${count} ${count === 1 ? 'book' : 'books'}`,
    count,
    covers: s.books,
    bookIds: s.books.map((b) => b.id),
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
      bookIds: s.books.map((b) => b.id),
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
    // The control bar is ADJUSTMENT, not navigation, and must read quieter than
    // the view selector above it - both were the same fill + hairline pill, so
    // four bands of chrome carried identical weight and none of them led. No
    // ground of its own: the hairline alone defines the control, and the tap
    // target grew to clear the platform minimum (was 7pt padding = ~28 high).
    ctrlChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingLeft: spacing.md - 2,
      paddingRight: spacing.md - 2,
      paddingVertical: spacing.md - 2,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    ctrlBadge: {
      // minHeight, not height: the label inside scales with the user's text
      // size (app cap is 1.6x), and a hard 17 clipped it.
      minWidth: 18,
      minHeight: 18,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 9,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // 11 is the app's documented type floor - 10 was the one place that broke it.
    ctrlBadgeText: { fontSize: 11, fontWeight: '700' },
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
    // 38 keeps the control bar compact; CTRL_ICON_HITSLOP carries it the rest
    // of the way to the platform touch minimum without inflating the row.
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
    // Sits outside sheetScroll so it stays put while the values scroll under it.
    filterSearch: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      marginBottom: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
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
