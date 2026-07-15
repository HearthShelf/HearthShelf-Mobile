/**
 * Unified search (D-SEARCH): the ONE search surface, pushed from the Home and
 * Library headers. Scope chips cover Everything / Books / Series / Authors /
 * Narrators; recent searches persist; the "Beyond your library" Audible section
 * keeps discovery in the same flow; and the search-external toggle lives in the
 * header gear instead of a dead-end settings screen. All four states are
 * designed: typing skeleton, no-results (+ beyond-library suggestion), error
 * with retry, and offline searching downloads only.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ScrollView, StyleSheet, TextInput, View } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { BottomSheetModal } from '@gorhom/bottom-sheet'
import Animated, { FadeIn } from 'react-native-reanimated'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type {
  ABSLibraryItem,
  ABSSearchResponse,
  HSAudibleSearchResult,
} from '@hearthshelf/core'
import { coverHue } from '@hearthshelf/core'
import { getLibraries, searchLibraryAll, itemAuthor, itemTitle, coverUrl } from '@/api/abs'
import { searchAudible } from '@/api/absAudible'
import { getRmabEnabled } from '@/api/absRmab'
import { getSettingsState, subscribeSettings, setSetting } from '@/store/settings'
import { getProgressState, subscribeProgress } from '@/store/progress'
import { playItemById } from '@/player/playback'
import { catalogAsLibraryItems, catalogLibraryId } from '@/player/offlineCatalog'
import { useConnection } from '@/api/ConnectionProvider'
import {
  AppText,
  Avatar,
  Cover,
  Chip,
  IconButton,
  Screen,
  Sheet,
  type SheetRef,
  Touchable,
  icons,
} from '@/ui/primitives'
import { EmptyState, ErrorState, Skeleton, SkeletonRow } from '@/ui/states'
import { SettingsToggle } from '@/ui/settingsControls'
import {
  BookActionsSheet,
  type BookActionsHandle,
} from '@/ui/BookActionsSheet'
import { NotOwnedSheet } from '@/ui/NotOwnedSheet'
import { useSheetBackHandler } from '@/ui/useBackHandler'
import { AppTabBar, tabFromParam } from '@/ui/AppTabBar'
import { Icon } from '@/ui/icons'
import { DUR } from '@/ui/motion'
import { haptics } from '@/ui/haptics'
import { showToast } from '@/ui/Toast'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useContentInset } from '@/ui/useContentInset'
import { useColors } from '@/ui/ThemeProvider'

type Scope = 'everything' | 'books' | 'series' | 'authors' | 'narrators'

const SCOPES: { v: Scope; label: string }[] = [
  { v: 'everything', label: 'Everything' },
  { v: 'books', label: 'Books' },
  { v: 'series', label: 'Series' },
  { v: 'authors', label: 'Authors' },
  { v: 'narrators', label: 'Narrators' },
]

const SCOPE_PLACEHOLDER: Record<Scope, string> = {
  everything: 'Search everything…',
  books: 'Search books…',
  series: 'Search series…',
  authors: 'Search authors…',
  narrators: 'Search narrators…',
}

const RECENTS_KEY = 'hs.recentSearches'
const RECENTS_MAX = 8

export default function SearchScreen() {
  const router = useRouter()
  // Hardware back closes an open sheet first; only with none open does it pop
  // the route (dismiss() returns false, letting the default back proceed).
  useSheetBackHandler()
  const { from } = useLocalSearchParams<{ from?: string }>()
  const active = tabFromParam(from, 'library')
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const contentInset = useContentInset()
  const { status } = useConnection()
  const offline = status.phase === 'offline'

  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>('everything')
  const [results, setResults] = useState<ABSSearchResponse | null>(null)
  const [external, setExternal] = useState<HSAudibleSearchResult[]>([])
  const [rmabEnabled, setRmabEnabled] = useState(false)
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [searchError, setSearchError] = useState(false)
  const [recents, setRecents] = useState<string[]>([])

  const externalOn = useSyncExternalStore(
    subscribeSettings,
    () => getSettingsState().searchExternalSources,
  )
  const progressById = useSyncExternalStore(subscribeProgress, getProgressState).byId
  const notOwnedRef = useRef<BottomSheetModal>(null)
  const gearRef = useRef<SheetRef>(null)
  const actionsRef = useRef<BookActionsHandle>(null)
  const inputRef = useRef<TextInput>(null)
  const [selected, setSelected] = useState<HSAudibleSearchResult | null>(null)

  const goToTab = (name: string) => {
    router.dismissAll?.()
    router.replace(name === 'index' ? '/(tabs)' : `/(tabs)/${name}`)
  }

  // ---- recents (persisted, last 8) ----
  useEffect(() => {
    void AsyncStorage.getItem(RECENTS_KEY).then((raw) => {
      if (!raw) return
      try {
        const list = JSON.parse(raw) as string[]
        if (Array.isArray(list)) setRecents(list.filter((s) => typeof s === 'string'))
      } catch {
        // Corrupt history is disposable.
      }
    })
  }, [])
  const saveRecents = useCallback((next: string[]) => {
    setRecents(next)
    void AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  }, [])
  const rememberQuery = useCallback(
    (q: string) => {
      const trimmed = q.trim()
      if (!trimmed) return
      setRecents((cur) => {
        const next = [trimmed, ...cur.filter((r) => r.toLowerCase() !== trimmed.toLowerCase())]
        const capped = next.slice(0, RECENTS_MAX)
        void AsyncStorage.setItem(RECENTS_KEY, JSON.stringify(capped))
        return capped
      })
    },
    [],
  )

  // ---- library resolution ----
  const libraryIdRef = useRef<string | null>(null)
  const resolveLibraryId = useCallback(async (): Promise<string | null> => {
    if (libraryIdRef.current) return libraryIdRef.current
    if (offline) {
      libraryIdRef.current = catalogLibraryId()
      return libraryIdRef.current
    }
    const libs = await getLibraries()
    const lib = libs.find((l) => l.mediaType === 'book') ?? libs[0]
    libraryIdRef.current = lib?.id ?? null
    return libraryIdRef.current
  }, [offline])

  // ---- search ----
  const runSearch = useCallback(
    async (q: string) => {
      const trimmed = q.trim()
      if (!trimmed) {
        setResults(null)
        setExternal([])
        setSearched(false)
        setSearchError(false)
        setLoading(false)
        return
      }
      setLoading(true)
      setSearchError(false)

      if (offline) {
        // Offline: search the downloaded catalog only (titles + authors).
        const needle = trimmed.toLowerCase()
        const matches = catalogAsLibraryItems().filter(
          (it) =>
            itemTitle(it).toLowerCase().includes(needle) ||
            itemAuthor(it).toLowerCase().includes(needle),
        )
        setResults({ book: matches.map((libraryItem) => ({ libraryItem })), series: [], authors: [], narrators: [] })
        setExternal([])
        setSearched(true)
        setLoading(false)
        return
      }

      try {
        const libraryId = await resolveLibraryId()
        if (!libraryId) {
          setResults(null)
          setSearched(true)
          setLoading(false)
          return
        }
        const data = await searchLibraryAll(libraryId, trimmed)
        setResults(data)
        setSearched(true)
        rememberQuery(trimmed)
      } catch {
        setResults(null)
        setSearchError(true)
        setSearched(true)
        setLoading(false)
        return
      } finally {
        setLoading(false)
      }

      // External (Audible) discovery. Best-effort and gated by the synced
      // setting; read live so it reflects a mid-session toggle. Deduped against
      // owned results so a book you already have never shows twice.
      if (!getSettingsState().searchExternalSources) {
        setExternal([])
        return
      }
      try {
        const [res, rmab] = await Promise.all([searchAudible(trimmed), getRmabEnabled()])
        setRmabEnabled(rmab)
        setExternal(res.results)
      } catch {
        setExternal([])
      }
    },
    [offline, resolveLibraryId, rememberQuery],
  )

  useEffect(() => {
    const handle = setTimeout(() => void runSearch(query), 300)
    return () => clearTimeout(handle)
  }, [query, runSearch])

  // ---- derived result sets ----
  const ownedBooks = useMemo(() => (results?.book ?? []).map((b) => b.libraryItem), [results])
  const ownedKeys = useMemo(
    () => new Set(ownedBooks.map((it) => (itemTitle(it) + '|' + itemAuthor(it)).toLowerCase())),
    [ownedBooks],
  )
  const externalDeduped = useMemo(
    () => external.filter((r) => !ownedKeys.has((r.title + '|' + r.author).toLowerCase())),
    [external, ownedKeys],
  )
  const series = results?.series ?? []
  const authors = results?.authors ?? []
  const narrators = results?.narrators ?? []
  const showBooks = scope === 'everything' || scope === 'books'
  const showSeries = scope === 'everything' || scope === 'series'
  const showAuthors = scope === 'everything' || scope === 'authors'
  const showNarrators = scope === 'everything' || scope === 'narrators'
  const visibleCount =
    (showBooks ? ownedBooks.length : 0) +
    (showSeries ? series.length : 0) +
    (showAuthors ? authors.length : 0) +
    (showNarrators ? narrators.length : 0) +
    (showBooks && externalOn ? externalDeduped.length : 0)

  const quickPlay = useCallback(
    async (id: string) => {
      haptics.transport()
      try {
        await playItemById(id)
        router.push('/player')
      } catch {
        router.push(`/item/${id}?from=${active}`)
      }
    },
    [router, active],
  )

  const pushGroup = useCallback(
    async (kind: 'authors' | 'narrators' | 'series', key: string, name: string) => {
      const libraryId = (await resolveLibraryId()) ?? ''
      if (kind === 'series') {
        router.push(
          `/series/${encodeURIComponent(key)}?libraryId=${encodeURIComponent(libraryId)}&from=${active}`,
        )
      } else {
        router.push(
          `/group/${kind}/${encodeURIComponent(key)}?libraryId=${encodeURIComponent(libraryId)}&name=${encodeURIComponent(name)}&from=${active}`,
        )
      }
    },
    [resolveLibraryId, router, active],
  )

  const trimmed = query.trim()

  return (
    <Screen>
      {/* Header: back · search pill (clear ×) · gear */}
      <View style={styles.header}>
        <IconButton name={icons.back} onPress={() => router.back()} />
        <View style={styles.searchBox}>
          <Icon name={icons.search} size={19} color={colors.accent} />
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={query}
            onChangeText={setQuery}
            placeholder={SCOPE_PLACEHOLDER[scope]}
            placeholderTextColor={colors.textFaint}
            autoCorrect={false}
            autoCapitalize="none"
            autoFocus
            returnKeyType="search"
          />
          {query.length > 0 ? (
            <IconButton
              name={icons.close}
              size={19}
              color={colors.textMuted}
              onPress={() => {
                setQuery('')
                inputRef.current?.focus()
              }}
            />
          ) : null}
        </View>
        <IconButton name={icons.tune} onPress={() => gearRef.current?.present()} />
      </View>

      {/* Scope chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0 }}
        contentContainerStyle={styles.chips}
        keyboardShouldPersistTaps="handled"
      >
        {SCOPES.map((s) => (
          <Chip
            key={s.v}
            label={s.label}
            active={scope === s.v}
            onPress={() => {
              haptics.select()
              setScope(s.v)
            }}
          />
        ))}
      </ScrollView>

      {offline ? (
        <View style={styles.offlineChip}>
          <Icon name={icons.cloudOff} size={14} color={colors.brandHearth} />
          <AppText variant="caption" color={colors.textMuted}>
            Offline · searching downloads
          </AppText>
        </View>
      ) : null}

      {!trimmed ? (
        // ---- default: recent searches + beyond-library status card ----
        <ScrollView
          contentContainerStyle={{ paddingBottom: contentInset }}
          keyboardShouldPersistTaps="handled"
        >
          {recents.length > 0 ? (
            <>
              <View style={styles.recentHead}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <Icon name={icons.recent} size={17} color={colors.textMuted} />
                  <AppText variant="label">Recent</AppText>
                </View>
                <Touchable
                  hitSlop={8}
                  onPress={() => {
                    const prev = recents
                    saveRecents([])
                    showToast('History cleared', {
                      action: { label: 'Undo', onPress: () => saveRecents(prev) },
                    })
                  }}
                >
                  <AppText variant="caption" color={colors.textMuted}>
                    Clear all
                  </AppText>
                </Touchable>
              </View>
              <View style={{ paddingHorizontal: spacing.lg }}>
                {recents.map((r) => (
                  <View key={r} style={styles.recentRow}>
                    <Icon name={icons.recent} size={19} color={colors.textFaint} />
                    <Touchable style={{ flex: 1 }} onPress={() => setQuery(r)}>
                      <AppText variant="meta">{r}</AppText>
                    </Touchable>
                    <IconButton
                      name={icons.close}
                      size={17}
                      color={colors.textFaint}
                      onPress={() => saveRecents(recents.filter((x) => x !== r))}
                    />
                  </View>
                ))}
              </View>
            </>
          ) : null}
          {!offline ? (
            <View style={styles.extCard}>
              <Icon name={icons.language} size={20} color={colors.brandHearth} />
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="label">
                  {externalOn ? 'Beyond your library is on' : 'Beyond your library is off'}
                </AppText>
                <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
                  {externalOn
                    ? 'Audible matches appear under your own results.'
                    : 'Only your own library is searched.'}
                </AppText>
              </View>
              <SettingsToggle
                on={externalOn}
                onChange={(v) => setSetting('searchExternalSources', v)}
              />
            </View>
          ) : null}
        </ScrollView>
      ) : loading ? (
        // ---- typing skeleton: row-shaped shimmer ----
        <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
          <SkeletonRow width={90} height={11} />
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={styles.skelRow}>
              <Skeleton width={40} height={60} radius={8} />
              <View style={{ flex: 1, gap: 7 }}>
                <SkeletonRow width={`${80 - i * 8}%`} height={12} />
                <SkeletonRow width={`${55 - i * 5}%`} height={9} />
              </View>
            </View>
          ))}
        </View>
      ) : searchError ? (
        // ---- error: failed requests finally say so ----
        <ErrorState
          title="Search didn't go through"
          message="The server didn't answer. Your library is fine."
          retryLabel="Retry"
          onRetry={() => void runSearch(query)}
        />
      ) : searched && visibleCount === 0 ? (
        // ---- no results (+ beyond-library suggestion when the toggle is off) ----
        <EmptyState
          icon={icons.search}
          iconColor={colors.textMuted}
          title={`No matches for "${trimmed}"`}
          body={
            offline
              ? 'Nothing in your downloads. Beyond-your-library results resume when you are back online.'
              : externalOn
                ? 'Nothing in your library or on Audible.'
                : 'Nothing in your library. Want to look further?'
          }
          cta={!offline && !externalOn ? 'Search beyond your library' : undefined}
          onCta={
            !offline && !externalOn
              ? () => {
                  setSetting('searchExternalSources', true)
                  void runSearch(query)
                }
              : undefined
          }
        />
      ) : (
        // ---- results, sectioned under scope Everything ----
        <Animated.ScrollView
          entering={FadeIn.duration(DUR.base)}
          contentContainerStyle={{ paddingBottom: contentInset }}
          keyboardShouldPersistTaps="handled"
        >
          {showBooks && ownedBooks.length > 0 ? (
            <>
              <SectionHead icon={icons.book} label={`Books · ${ownedBooks.length}`} />
              {ownedBooks.map((item) => (
                <BookRow
                  key={item.id}
                  item={item}
                  progress={progressById.get(item.id)?.progress}
                  finished={progressById.get(item.id)?.isFinished === true}
                  onPress={() => router.push(`/item/${item.id}?from=${active}`)}
                  onLongPress={() => {
                    haptics.longPress()
                    actionsRef.current?.present(
                      item,
                      progressById.get(item.id)?.isFinished === true,
                      'browse',
                    )
                  }}
                  onQuickPlay={() => void quickPlay(item.id)}
                />
              ))}
            </>
          ) : null}

          {showSeries && series.length > 0 ? (
            <>
              <SectionHead icon={icons.library} label={`Series · ${series.length}`} />
              {series.map((s) => (
                <Touchable
                  key={s.series.id}
                  style={styles.row}
                  onPress={() => void pushGroup('series', s.series.id, s.series.name)}
                >
                  <View style={styles.seriesCovers}>
                    {s.books.slice(0, 2).map((b, i) => (
                      <View key={b.id} style={[styles.seriesCover, i > 0 && styles.seriesCoverBack]}>
                        <Cover
                          uri={coverUrl(b.id)}
                          itemId={b.id}
                          width={38}
                          aspectRatio={2 / 3}
                          fallback={{
                            hue: coverHue(b.id),
                            initial: itemTitle(b).charAt(0).toUpperCase(),
                          }}
                        />
                      </View>
                    ))}
                  </View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <AppText variant="label" numberOfLines={1}>
                      {s.series.name}
                    </AppText>
                    <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
                      {s.books.length} {s.books.length === 1 ? 'book' : 'books'}
                    </AppText>
                  </View>
                  <Icon name={icons.chevronRight} size={20} color={colors.textFaint} />
                </Touchable>
              ))}
            </>
          ) : null}

          {showAuthors && authors.length > 0 ? (
            <>
              <SectionHead icon={icons.person} label={`Authors · ${authors.length}`} />
              {authors.map((a) => (
                <Touchable
                  key={a.id}
                  style={styles.row}
                  onPress={() => void pushGroup('authors', a.id, a.name)}
                >
                  <Avatar size={44} name={a.name} hue={coverHue(a.id)} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <AppText variant="label" numberOfLines={1}>
                      {a.name}
                    </AppText>
                    <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
                      {a.numBooks} {a.numBooks === 1 ? 'book' : 'books'}
                    </AppText>
                  </View>
                  <Icon name={icons.chevronRight} size={20} color={colors.textFaint} />
                </Touchable>
              ))}
            </>
          ) : null}

          {showNarrators && narrators.length > 0 ? (
            <>
              <SectionHead icon={icons.voice} label={`Narrators · ${narrators.length}`} />
              {narrators.map((n) => (
                <Touchable
                  key={n.name}
                  style={styles.row}
                  onPress={() => void pushGroup('narrators', n.name, n.name)}
                >
                  <Avatar size={44} name={n.name} hue={coverHue(n.name)} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <AppText variant="label" numberOfLines={1}>
                      {n.name}
                    </AppText>
                    <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
                      {n.numBooks} {n.numBooks === 1 ? 'book' : 'books'}
                    </AppText>
                  </View>
                  <Icon name={icons.chevronRight} size={20} color={colors.textFaint} />
                </Touchable>
              ))}
            </>
          ) : null}

          {showBooks && externalOn && externalDeduped.length > 0 ? (
            <>
              <SectionHead
                icon={icons.language}
                iconColor={colors.brandHearth}
                label={`Beyond your library · ${externalDeduped.length}`}
              />
              {externalDeduped.map((b) => (
                <ExternalRow
                  key={b.asin}
                  book={b}
                  rmabEnabled={rmabEnabled}
                  onPress={() => {
                    setSelected(b)
                    notOwnedRef.current?.present()
                  }}
                />
              ))}
            </>
          ) : null}
        </Animated.ScrollView>
      )}

      {/* Gear: inline search settings (the relocated beyond-library toggle). */}
      <Sheet ref={gearRef} title="Search settings">
        <View style={styles.gearRow}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="label">Search beyond your library</AppText>
            <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
              Show Audible matches under your own results, with a request or buy
              link.
            </AppText>
          </View>
          <SettingsToggle
            on={externalOn}
            onChange={(v) => setSetting('searchExternalSources', v)}
          />
        </View>
      </Sheet>

      <NotOwnedSheet
        ref={notOwnedRef}
        book={selected}
        rmabEnabled={rmabEnabled}
        onDismiss={() => setSelected(null)}
      />
      <BookActionsSheet ref={actionsRef} />

      <AppTabBar activeName={active} onPressTab={goToTab} />
    </Screen>
  )
}

function SectionHead({
  icon,
  iconColor,
  label,
}: {
  icon: React.ComponentProps<typeof Icon>['name']
  iconColor?: string
  label: string
}) {
  const colors = useColors()
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingHorizontal: spacing.lg,
        marginTop: spacing.lg,
        marginBottom: spacing.xs,
      }}
    >
      <Icon name={icon} size={17} color={iconColor ?? colors.textMuted} />
      <AppText variant="label">{label}</AppText>
    </View>
  )
}

/** One owned search result: 46px cover, title, author + progress, and a
 *  quick-play chip (in progress) or finished check. */
function BookRow({
  item,
  progress,
  finished,
  onPress,
  onLongPress,
  onQuickPlay,
}: {
  item: ABSLibraryItem
  progress?: number
  finished: boolean
  onPress: () => void
  onLongPress: () => void
  onQuickPlay: () => void
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const inProgress = progress != null && progress > 0 && progress < 1
  const pct = inProgress ? Math.round(progress * 100) : 0
  const sub = finished
    ? `${itemAuthor(item)} · Finished`
    : inProgress
      ? `${itemAuthor(item)} · ${pct}%`
      : itemAuthor(item)
  return (
    <Touchable style={styles.row} onPress={onPress} onLongPress={onLongPress}>
      <Cover
        uri={coverUrl(item.id)}
        itemId={item.id}
        width={46}
        aspectRatio={2 / 3}
        fallback={{ hue: coverHue(item.id), initial: itemTitle(item).charAt(0).toUpperCase() }}
        showDownloadBadge
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="label" numberOfLines={1}>
          {itemTitle(item)}
        </AppText>
        <AppText variant="caption" color={colors.textMuted} numberOfLines={1} style={{ marginTop: 2 }}>
          {sub}
        </AppText>
        {inProgress ? (
          <View style={styles.rowTrack}>
            <View style={[styles.rowTrackFill, { width: `${pct}%` }]} />
          </View>
        ) : null}
      </View>
      {finished ? (
        <Icon name={icons.checkCircle} size={20} color={colors.success} />
      ) : inProgress ? (
        <Touchable onPress={onQuickPlay} hitSlop={6} style={styles.playChip}>
          <Icon name={icons.play} size={19} color={colors.accent} />
        </Touchable>
      ) : null}
    </Touchable>
  )
}

// One Audible search result that isn't in the library. Tapping opens the shared
// request/buy sheet. Request tag when the request backend is connected,
// otherwise an Audible tag that opens the buy-on-Audible path.
function ExternalRow({
  book,
  rmabEnabled,
  onPress,
}: {
  book: HSAudibleSearchResult
  rmabEnabled: boolean
  onPress: () => void
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const sub = [book.author, book.narrator].filter(Boolean).join(' · ')
  return (
    <Touchable onPress={onPress} style={[styles.row, { opacity: 0.92 }]}>
      <Cover
        uri={book.coverArtUrl}
        width={46}
        aspectRatio={2 / 3}
        fallback={{
          hue: coverHue(book.asin),
          initial: (book.title || '?').charAt(0).toUpperCase(),
        }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="label" numberOfLines={1}>
          {book.title}
        </AppText>
        {sub ? (
          <AppText
            variant="caption"
            color={colors.textMuted}
            numberOfLines={1}
            style={{ marginTop: 2 }}
          >
            {sub}
          </AppText>
        ) : null}
      </View>
      <View style={styles.extTag}>
        <Icon
          name={rmabEnabled ? icons.send : icons.shoppingCart}
          size={13}
          color={colors.accent}
        />
        <AppText variant="caption" color={colors.accent} style={{ fontWeight: '600' }}>
          {rmabEnabled ? 'Request' : 'Audible'}
        </AppText>
      </View>
    </Touchable>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
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
      backgroundColor: colors.fillStrong,
      borderWidth: 1.5,
      borderColor: colors.accent,
    },
    input: { flex: 1, paddingVertical: spacing.md - 2, color: colors.text, fontSize: 16 },
    chips: {
      flexDirection: 'row',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xs,
    },
    offlineChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'flex-start',
      marginLeft: spacing.lg,
      marginTop: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    recentHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      marginTop: spacing.lg,
      marginBottom: spacing.xs,
    },
    recentRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    extCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginHorizontal: spacing.lg,
      marginTop: spacing.xl,
      padding: spacing.md + 1,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    skelRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginTop: spacing.md,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    rowTrack: {
      marginTop: 5,
      width: 120,
      height: 3,
      borderRadius: radius.pill,
      backgroundColor: colors.fillStrong,
      overflow: 'hidden',
    },
    rowTrackFill: { height: '100%', backgroundColor: colors.accent },
    playChip: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.accentWash,
      alignItems: 'center',
      justifyContent: 'center',
    },
    seriesCovers: { width: 56, height: 62, position: 'relative' },
    seriesCover: { position: 'absolute', left: 0, top: 2, zIndex: 2 },
    seriesCoverBack: {
      left: 16,
      top: 0,
      zIndex: 1,
      transform: [{ rotate: '5deg' }],
    },
    extTag: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.md - 1,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: colors.accentWash,
    },
    gearRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      paddingBottom: spacing.xl,
    },
  })
