/**
 * Author / Narrator drill-in: a hero (avatar + eyebrow + name + counts), a sort
 * chip (Title / Series / Year, tap flips direction), series-aware grouping (books
 * group under tappable series subheads when the author has series), and the same
 * tile grammar as the rest of the app (user-aspect covers, progress, finished
 * badges, quick-play). Skeleton + empty states included.
 *
 * Series and Authors have direct ABS reads (series carries its books; the
 * author-detail endpoint includes libraryItems). Narrators have no "books by
 * narrator" endpoint - ABS derives narrators from item metadata - so this
 * fetches the whole library and filters by narrator credit client-side.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { seriesSeqFromName } from '@hearthshelf/core'
import {
  getAuthorDetail,
  getLibraryAuthors,
  getLibraryItemsPage,
  getLibrarySeries,
  itemNarrator,
  itemTitle,
} from '@/api/abs'
import { getProgressState, subscribeProgress } from '@/store/progress'
import { playItemById } from '@/player/playback'
import {
  AppText,
  Avatar,
  Centered,
  IconButton,
  Screen,
  Touchable,
  icons,
} from '@/ui/primitives'
import { BookTile } from '@/ui/BookTile'
import { EmptyState, Skeleton, SkeletonTile } from '@/ui/states'
import { Icon } from '@/ui/icons'
import { AppTabBar, tabFromParam } from '@/ui/AppTabBar'
import { haptics } from '@/ui/haptics'
import { spacing } from '@/ui/theme'
import { useContentInset } from '@/ui/useContentInset'
import { useColors } from '@/ui/ThemeProvider'
import { adaptiveShelfTileWidth } from '@/ui/responsive'

type GroupType = 'series' | 'authors' | 'narrators'
type GroupSort = 'title' | 'series' | 'year'

const KIND_EYEBROW: Record<GroupType, string> = {
  series: 'Series',
  authors: 'Author',
  narrators: 'Narrated by',
}

const SORTS: { v: GroupSort; label: string }[] = [
  { v: 'title', label: 'Title' },
  { v: 'series', label: 'Series' },
  { v: 'year', label: 'Year' },
]

/** A group of books under one series subhead (or the standalone bucket). */
interface BookGroup {
  seriesName: string | null
  seriesId: string | null
  books: ABSLibraryItem[]
}

export default function GroupDrilldown() {
  const router = useRouter()
  const colors = useColors()
  const { width } = useWindowDimensions()
  const contentInset = useContentInset()
  const { type, key, libraryId, name, byName, from } = useLocalSearchParams<{
    type: GroupType
    key: string
    libraryId: string
    name: string
    byName?: string
    from?: string
  }>()
  const active = tabFromParam(from, 'library')
  const displayName = decodeURIComponent(name ?? '')
  const tileWidth = adaptiveShelfTileWidth(width)

  const [books, setBooks] = useState<ABSLibraryItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<GroupSort>(type === 'authors' ? 'series' : 'title')
  const [desc, setDesc] = useState(false)
  // name -> series id, so series subheads can push the series detail.
  const [seriesIds, setSeriesIds] = useState<Record<string, string>>({})
  const progressById = useSyncExternalStore(subscribeProgress, getProgressState).byId

  const goToTab = (tabName: string) => {
    router.dismissAll?.()
    router.replace(tabName === 'index' ? '/(tabs)' : `/(tabs)/${tabName}`)
  }

  useEffect(() => {
    let cancelled = false
    setBooks(null)
    setError(null)
    void (async () => {
      try {
        let result: ABSLibraryItem[] = []
        if (type === 'series') {
          const series = await getLibrarySeries(libraryId)
          result = series.find((s) => s.id === key)?.books ?? []
        } else if (type === 'authors') {
          // Route can carry an author id (from search) or a name (from a series
          // page, which has no id). Resolve a name to its id first.
          let authorId = key
          if (byName === '1') {
            const authors = await getLibraryAuthors(libraryId)
            const target = decodeURIComponent(key).toLowerCase()
            authorId = authors.find((a) => a.name.toLowerCase() === target)?.id ?? key
          }
          const detail = await getAuthorDetail(authorId)
          result = detail.libraryItems ?? []
        } else {
          // Narrators: fetch every item in the library (limit=0 via a single
          // large page) and filter by narrator credit substring match, since
          // ABS stores narrators as a free-text comma-joined field.
          const page = await getLibraryItemsPage(libraryId, 0, 0)
          const target = decodeURIComponent(name).toLowerCase()
          result = page.results.filter((it) => itemNarrator(it).toLowerCase().includes(target))
        }
        if (!cancelled) setBooks(result)
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [type, key, libraryId, name, byName])

  // Resolve series name -> id so subheads can push series detail (best-effort).
  useEffect(() => {
    if (type === 'series' || !books) return
    let cancelled = false
    void getLibrarySeries(libraryId)
      .then((all) => {
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const s of all) map[s.name] = s.id
        setSeriesIds(map)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [type, libraryId, books])

  const seriesCount = useMemo(() => {
    if (!books) return 0
    const names = new Set<string>()
    for (const b of books) {
      const n = seriesBaseName(b)
      if (n) names.add(n)
    }
    return names.size
  }, [books])

  const finishedCount = useMemo(
    () => (books ? books.filter((b) => progressById.get(b.id)?.isFinished).length : 0),
    [books, progressById],
  )

  // Group books by series when sorting by Series and the group has any; else a
  // single flat bucket in the chosen order.
  const groups = useMemo<BookGroup[]>(() => {
    if (!books) return []
    if (sort !== 'series' || seriesCount === 0) {
      return [{ seriesName: null, seriesId: null, books: flatSort(books, sort, desc) }]
    }
    const bySeries = new Map<string, ABSLibraryItem[]>()
    const standalone: ABSLibraryItem[] = []
    for (const b of books) {
      const n = seriesBaseName(b)
      if (n) {
        const arr = bySeries.get(n) ?? []
        arr.push(b)
        bySeries.set(n, arr)
      } else standalone.push(b)
    }
    const out: BookGroup[] = [...bySeries.entries()]
      .sort((a, b) => (desc ? b[0].localeCompare(a[0]) : a[0].localeCompare(b[0])))
      .map(([seriesName, list]) => ({
        seriesName,
        seriesId: seriesIds[seriesName] ?? null,
        books: [...list].sort(
          (a, b) => seriesSeq(a) - seriesSeq(b) || itemTitle(a).localeCompare(itemTitle(b)),
        ),
      }))
    if (standalone.length) {
      out.push({ seriesName: null, seriesId: null, books: flatSort(standalone, 'title', desc) })
    }
    return out
  }, [books, sort, desc, seriesCount, seriesIds])

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

  const chooseSort = () => {
    // Cycle through the sorts on tap; flip direction handled via the chip below.
    haptics.select()
    const idx = SORTS.findIndex((s) => s.v === sort)
    setSort(SORTS[(idx + 1) % SORTS.length].v)
  }

  return (
    <Screen>
      <View style={styles.headerRow}>
        <IconButton name={icons.back} onPress={() => router.back()} />
      </View>

      {error ? (
        <Centered>
          <AppText variant="meta" color={colors.destructive}>
            {error}
          </AppText>
        </Centered>
      ) : !books ? (
        <GroupSkeleton tileWidth={tileWidth} />
      ) : books.length === 0 ? (
        <EmptyState
          icon={type === 'narrators' ? icons.voice : icons.person}
          iconColor={colors.textMuted}
          title={`Nothing by this ${type === 'narrators' ? 'narrator' : 'author'} yet`}
          body="Their books left your library or were hidden."
          cta="Back to Library"
          onCta={() => goToTab('library')}
        />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: contentInset }}
          showsVerticalScrollIndicator={false}
        >
          {/* Hero */}
          <View style={styles.hero}>
            <Avatar
              size={76}
              name={displayName}
              icon={type === 'narrators' ? icons.voice : undefined}
            />
            <AppText variant="eyebrow" color={colors.textMuted} style={{ marginTop: spacing.md }}>
              {KIND_EYEBROW[type]}
            </AppText>
            <AppText variant="hero" style={{ marginTop: 3, textAlign: 'center' }}>
              {displayName}
            </AppText>
            <AppText variant="meta" color={colors.textMuted} style={{ marginTop: 4 }}>
              {countLine(books.length, seriesCount, finishedCount)}
            </AppText>
          </View>

          {/* Sort control */}
          <View style={styles.controlRow}>
            <Touchable style={styles.sortChip} onPress={() => setDesc((d) => !d)}>
              <Icon
                name={desc ? icons.arrowDownward : icons.arrowUpward}
                size={15}
                color={colors.accent}
              />
              <AppText variant="caption">{SORTS.find((s) => s.v === sort)?.label}</AppText>
              <Touchable onPress={chooseSort} hitSlop={8}>
                <Icon name={icons.collapse} size={15} color={colors.textMuted} />
              </Touchable>
            </Touchable>
            <View style={{ flex: 1 }} />
            <AppText variant="caption" color={colors.textMuted}>
              {books.length} {books.length === 1 ? 'book' : 'books'}
            </AppText>
          </View>

          {/* Groups */}
          {groups.map((g, gi) => (
            <View key={g.seriesName ?? `flat-${gi}`} style={{ marginTop: spacing.md }}>
              {g.seriesName ? (
                <Touchable
                  style={styles.groupHead}
                  disabled={!g.seriesId}
                  onPress={() =>
                    g.seriesId &&
                    router.push(
                      `/series/${encodeURIComponent(g.seriesId)}?libraryId=${encodeURIComponent(libraryId)}&from=${active}`,
                    )
                  }
                >
                  <AppText variant="label" color={colors.brandHearth} numberOfLines={1}>
                    {g.seriesName}
                  </AppText>
                  <AppText variant="caption" color={colors.textMuted}>
                    · {g.books.length} {g.books.length === 1 ? 'book' : 'books'}
                  </AppText>
                  <View style={{ flex: 1 }} />
                  {g.seriesId ? (
                    <Icon name={icons.chevronRight} size={18} color={colors.brandHearth} />
                  ) : null}
                </Touchable>
              ) : groups.length > 1 ? (
                <View style={styles.groupHead}>
                  <AppText variant="label" color={colors.textMuted}>
                    Standalone
                  </AppText>
                  <AppText variant="caption" color={colors.textMuted}>
                    · {g.books.length} {g.books.length === 1 ? 'book' : 'books'}
                  </AppText>
                </View>
              ) : null}
              <View style={styles.grid}>
                {g.books.map((item) => {
                  const p = progressById.get(item.id)
                  return (
                    <BookTile
                      key={item.id}
                      item={item}
                      width={tileWidth}
                      from={active}
                      progress={p?.progress}
                      finished={p?.isFinished === true}
                      onQuickPlay={() => void quickPlay(item.id)}
                    />
                  )
                })}
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      <AppTabBar activeName={active} onPressTab={goToTab} />
    </Screen>
  )
}

/** The series base name ("Foundation" from "Foundation #2"), or null. */
function seriesBaseName(item: ABSLibraryItem): string | null {
  const raw = item.media.metadata.seriesName
  if (!raw) return null
  return raw.replace(/\s*#[\d.]+\s*$/, '').trim() || null
}

function seriesSeq(item: ABSLibraryItem): number {
  return Number(seriesSeqFromName(item.media.metadata.seriesName)) || 0
}

function flatSort(books: ABSLibraryItem[], sort: GroupSort, desc: boolean): ABSLibraryItem[] {
  const out = [...books]
  out.sort((a, b) => {
    if (sort === 'year') {
      const ya = Number(a.media.metadata.publishedYear ?? 0)
      const yb = Number(b.media.metadata.publishedYear ?? 0)
      return ya - yb
    }
    if (sort === 'series') return seriesSeq(a) - seriesSeq(b)
    return (a.media.metadata.titleIgnorePrefix || itemTitle(a)).localeCompare(
      b.media.metadata.titleIgnorePrefix || itemTitle(b),
    )
  })
  if (desc) out.reverse()
  return out
}

function countLine(books: number, series: number, finished: number): string {
  const parts = [`${books} ${books === 1 ? 'book' : 'books'}`]
  if (series > 0) parts.push(`${series} ${series === 1 ? 'series' : 'series'}`)
  if (finished > 0) parts.push(`${finished} finished`)
  return parts.join(' · ')
}

/** Hero + grid shimmer while the group's books resolve (narrators filter the
 *  whole library, so this pass is real). */
function GroupSkeleton({ tileWidth }: { tileWidth: number }) {
  return (
    <View style={{ paddingHorizontal: spacing.lg }}>
      <View style={{ alignItems: 'center', marginTop: spacing.sm }}>
        <Skeleton width={76} height={76} radius={38} />
        <Skeleton width={130} height={16} radius={8} style={{ marginTop: spacing.md }} />
        <Skeleton width={100} height={11} radius={6} style={{ marginTop: spacing.sm }} />
      </View>
      <View style={[styles.grid, { marginTop: spacing.xl }]}>
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonTile key={i} width={tileWidth} />
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  hero: { alignItems: 'center', paddingHorizontal: spacing.xl },
  controlRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginTop: spacing.lg,
  },
  sortChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: spacing.md - 2,
    paddingVertical: 7,
    borderRadius: 999,
  },
  groupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
})
