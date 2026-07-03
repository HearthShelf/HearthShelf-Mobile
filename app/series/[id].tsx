/**
 * Series detail, ported from the web app's `series/:id` page. A hue-glow hero
 * (title, author, stat strip), a segmented series-progress widget, a Continue
 * CTA that resumes the next unfinished book, series-wide mark-finished, and the
 * reading-order book list with a selection mode for bulk mark-finished.
 *
 * The web page's admin-only bulk metadata edit (BatchEditModal) is intentionally
 * left out - it's an admin surface with no mobile equivalent yet; selection here
 * drives mark-finished, the primary action people reach for on a series.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { ABSLibraryItem, ABSMediaProgress, ABSSeries } from '@hearthshelf/core'
import { coverHue } from '@hearthshelf/core'
import { coverUrl, getLibrarySeries, itemAuthor, itemNarrator, itemTitle } from '@/api/abs'
import { catalogSeriesById } from '@/player/offlineCatalog'
import {
  getProgressState,
  subscribeProgress,
  refreshProgress,
  markItemsFinished,
} from '@/store/progress'
import { requestSeek } from '@/player/store'
import { playItemById } from '@/player/playback'
import {
  AppText,
  Centered,
  Cover,
  IconButton,
  Loading,
  PrimaryButton,
  ProgressBar,
  Screen,
  Touchable,
  icons,
} from '@/ui/primitives'
import { AppTabBar } from '@/ui/AppTabBar'
import { CoverGlow } from '@/ui/CoverGlow'
import { BookSelectionToolbar } from '@/ui/BookSelectionToolbar'
import { useBookSelection } from '@/ui/useBookSelection'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useMiniPlayerInset } from '@/ui/useContentInset'
import { useColors } from '@/ui/ThemeProvider'

/** ABS stores a book's sequence in the denormalized seriesName ("Foundation #2").
 *  Parse the trailing "#<n>" and sort ascending; unsequenced books sort first. */
function orderBooks(books: ABSLibraryItem[]): ABSLibraryItem[] {
  const seqOf = (item: ABSLibraryItem) => {
    const match = item.media.metadata.seriesName?.match(/#?([\d.]+)\s*$/)
    return Number(match?.[1] ?? 0)
  }
  return [...books].sort((a, b) => seqOf(a) - seqOf(b))
}

export default function SeriesDetailScreen() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { id, libraryId } = useLocalSearchParams<{ id: string; libraryId: string }>()
  const [series, setSeries] = useState<ABSSeries | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [marking, setMarking] = useState(false)
  const selection = useBookSelection()
  const miniInset = useMiniPlayerInset()
  // Shared per-item progress; mutations anywhere in the app update this page live.
  const progressById = useSyncExternalStore(subscribeProgress, getProgressState).byId

  useEffect(() => {
    if (!id || !libraryId) return
    let cancelled = false
    void (async () => {
      try {
        const all = await getLibrarySeries(libraryId)
        if (cancelled) return
        const found = all.find((s) => s.id === id)
        if (!found) throw new Error('Series not found')
        setSeries(found)
        // Progress is best-effort - a failure shouldn't block the page.
        void refreshProgress().catch(() => {})
      } catch (e) {
        if (cancelled) return
        // Offline: show this series' downloaded books from the local catalog.
        const local = catalogSeriesById(id)
        if (local && local.books.length > 0) setSeries(local)
        else setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id, libraryId])

  if (error) {
    return (
      <Screen>
        <Header onBack={() => router.back()} />
        <Centered>
          <AppText variant="meta" color={colors.destructive}>
            {error}
          </AppText>
        </Centered>
      </Screen>
    )
  }

  if (!series) {
    return (
      <Screen>
        <Header onBack={() => router.back()} />
        <Loading label="Loading series..." />
      </Screen>
    )
  }

  const books = orderBooks(series.books ?? [])
  const author = books[0] ? itemAuthor(books[0]) : ''
  const hue = coverHue(books[0]?.id ?? series.id)

  // Per-book progress, finished count, totals. A finished book counts as 1.0.
  let done = 0
  let sum = 0
  let totalHours = 0
  for (const b of books) {
    const p = progressById.get(b.id)
    if (p?.isFinished) done++
    sum += p?.isFinished ? 1 : (p?.progress ?? 0)
    totalHours += (b.media.duration ?? 0) / 3600
  }
  const pct = books.length ? sum / books.length : 0
  const listenedHours = totalHours * pct

  // Next up = first unfinished in reading order, else the first book (to replay).
  const nextUpIdx = books.findIndex((b) => !progressById.get(b.id)?.isFinished)
  const nextUp = nextUpIdx === -1 ? books[0] : books[nextUpIdx]
  const nextUpNum = (nextUpIdx === -1 ? 0 : nextUpIdx) + 1

  const allSeriesFinished =
    books.length > 0 && books.every((b) => progressById.get(b.id)?.isFinished)

  // Mark the whole series finished/unfinished through the shared progress
  // store: optimistic flip, serial writes, and refresh protection so the UI
  // can't blink back to stale state.
  const markSeries = async () => {
    if (!books.length || marking) return
    const next = !allSeriesFinished
    setMarking(true)
    try {
      await markItemsFinished(
        books.map((b) => ({ id: b.id, duration: b.media.duration ?? 0 })),
        next,
      )
    } catch {
      // Store rolled the optimistic state back.
    } finally {
      setMarking(false)
    }
  }

  // Pushed above the tabs navigator, so it renders its own copy of the bar
  // (see player.tsx / item/[id].tsx) rather than inheriting the tabs layout's.
  const goToTab = (name: string) => {
    router.dismissAll?.()
    router.replace(name === 'index' ? '/(tabs)' : `/(tabs)/${name}`)
  }

  const play = async (bookId: string) => {
    const p = progressById.get(bookId)
    await playItemById(bookId)
    const start = p?.isFinished ? 0 : (p?.currentTime ?? 0)
    if (start > 0) requestSeek(start)
    router.push('/player')
  }

  return (
    <Screen>
      <View style={StyleSheet.absoluteFill}>
        <CoverGlow hue={hue} height={340} />
      </View>

      <Header onBack={() => router.back()} />
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: miniInset }}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <HeroCovers books={books} />
          <AppText variant="eyebrow" color={colors.textMuted} style={{ marginTop: spacing.lg }}>
            Series
          </AppText>
          <AppText variant="hero" style={styles.title}>
            {series.name}
          </AppText>
          {author ? (
            <AppText variant="label" color={colors.textMuted}>
              {author}
            </AppText>
          ) : null}

          <View style={styles.statStrip}>
            <StatCell value={String(books.length)} label={books.length === 1 ? 'book' : 'books'} />
            <View style={styles.statDivider} />
            <StatCell value={`${totalHours.toFixed(0)}h`} label="total" />
            <View style={styles.statDivider} />
            <StatCell value={`${done}/${books.length}`} label="finished" />
          </View>
        </View>

        {/* Progress widget */}
        <View style={styles.progCard}>
          <View style={styles.progTop}>
            <AppText variant="hero" color={colors.accent}>
              {Math.round(pct * 100)}%
            </AppText>
            <AppText variant="meta" color={colors.textMuted} style={{ flex: 1 }}>
              {done} of {books.length} finished · {listenedHours.toFixed(0)}h of{' '}
              {totalHours.toFixed(0)}h
            </AppText>
          </View>
          <SegmentTrack books={books} progressById={progressById} />
        </View>

        {/* Series actions */}
        <View style={styles.actions}>
          {nextUp ? (
            <PrimaryButton
              label={`Continue · Book ${nextUpNum}`}
              icon={icons.play}
              onPress={() => play(nextUp.id)}
              style={{ flex: 1 }}
            />
          ) : null}
        </View>
        <Touchable onPress={markSeries} disabled={marking} style={styles.markSeriesBtn}>
          <IconButton
            name={allSeriesFinished ? icons.removeDone : icons.doneAll}
            size={18}
            color={colors.text}
          />
          <AppText variant="label">
            {allSeriesFinished ? 'Mark series unfinished' : 'Mark series finished'}
          </AppText>
        </Touchable>

        {/* List head / selection toolbar. Long-press a book to start selecting. */}
        {selection.selecting ? (
          <BookSelectionToolbar selection={selection} books={books} libraryId={libraryId} />
        ) : (
          <View style={styles.listHead}>
            <View style={styles.listHeadTitle}>
              <IconButton name={icons.listNumbered} size={20} color={colors.accent} />
              <AppText variant="title">In reading order</AppText>
            </View>
          </View>
        )}

        {/* Book list */}
        <View style={styles.list}>
          {books.map((b, i) => (
            <BookRow
              key={b.id}
              book={b}
              index={i}
              progress={progressById.get(b.id) ?? null}
              selecting={selection.selecting}
              selected={selection.isSelected(b.id)}
              onPress={() =>
                selection.selecting ? selection.toggle(b.id) : router.push(`/item/${b.id}`)
              }
              onLongPress={() => selection.begin(b.id)}
              onToggle={() => selection.toggle(b.id)}
              onPlay={() => play(b.id)}
            />
          ))}
        </View>
      </ScrollView>

      <AppTabBar activeName={null} onPressTab={goToTab} />
    </Screen>
  )
}

/** Count-aware cover cluster: 1 solo, 2 overlapped, 3+ a fanned trio with a "+N"
 *  overflow chip. A compact take on the web hero's solo/duo/tri/square layouts. */
function HeroCovers({ books }: { books: ABSLibraryItem[] }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const shown = books.slice(0, 3)
  if (shown.length === 0) return null
  if (shown.length === 1) {
    return (
      <Cover
        uri={coverUrl(shown[0].id)}
        size={160}
        radius={radius.card}
        fallback={{
          hue: coverHue(shown[0].id),
          initial: itemTitle(shown[0]).charAt(0).toUpperCase(),
          title: itemTitle(shown[0]),
        }}
      />
    )
  }
  const overflow = books.length - shown.length
  return (
    <View style={{ height: 150, width: 150 + (shown.length - 1) * 34, justifyContent: 'center' }}>
      {shown.map((b, i) => (
        <Cover
          key={b.id}
          uri={coverUrl(b.id)}
          size={132}
          radius={radius.card}
          style={{ position: 'absolute', left: i * 34, top: 9, zIndex: shown.length - i }}
          fallback={{ hue: coverHue(b.id), initial: itemTitle(b).charAt(0).toUpperCase() }}
        />
      ))}
      {overflow > 0 ? (
        <View style={[styles.overflowChip, { left: (shown.length - 1) * 34 + 100 }]}>
          <AppText variant="caption" color={colors.text}>
            +{overflow}
          </AppText>
        </View>
      ) : null}
    </View>
  )
}

/** The segmented series-progress bar: one cell per book, filled for finished,
 *  partially filled for in-progress, empty otherwise. */
function SegmentTrack({
  books,
  progressById,
}: {
  books: ABSLibraryItem[]
  progressById: ReadonlyMap<string, ABSMediaProgress>
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.segTrack}>
      {books.map((b) => {
        const p = progressById.get(b.id)
        const fin = p?.isFinished
        const frac = fin ? 1 : (p?.progress ?? 0)
        return (
          <View key={b.id} style={styles.seg}>
            {frac > 0 ? (
              <View style={[styles.segFill, { width: `${Math.round(frac * 100)}%` }]} />
            ) : null}
          </View>
        )
      })}
    </View>
  )
}

function BookRow({
  book,
  index,
  progress,
  selecting,
  selected,
  onPress,
  onLongPress,
  onToggle,
  onPlay,
}: {
  book: ABSLibraryItem
  index: number
  progress: ABSMediaProgress | null
  selecting: boolean
  selected: boolean
  onPress: () => void
  onLongPress: () => void
  onToggle: () => void
  onPlay: () => void
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const title = itemTitle(book)
  const fin = progress?.isFinished ?? false
  const part = !fin && (progress?.progress ?? 0) > 0
  const hours = book.media.duration ? Math.round(book.media.duration / 360) / 10 : 0
  const narrator = itemNarrator(book)
  // A skeleton sibling in an offline series: metadata only, not on this device.
  const notDownloaded = book.isMissing === true
  const sub = notDownloaded
    ? [narrator, 'Not downloaded'].filter(Boolean).join(' · ')
    : [narrator, hours > 0 && `${hours}h`].filter(Boolean).join(' · ')

  return (
    <Touchable
      onPress={onPress}
      onLongPress={onLongPress}
      style={[styles.row, selected && styles.rowSelected, notDownloaded && styles.rowDimmed]}
    >
      {selecting ? (
        <Pressable
          onPress={onToggle}
          hitSlop={8}
          style={[styles.check, selected && styles.checkOn]}
        >
          {selected ? <IconButton name={icons.check} size={16} color={colors.onAccent} /> : null}
        </Pressable>
      ) : (
        <AppText variant="title" color={colors.textMuted} style={styles.num}>
          {index + 1}
        </AppText>
      )}
      <Cover
        uri={coverUrl(book.id)}
        itemId={book.id}
        size={56}
        radius={radius.tile}
        fallback={{ hue: coverHue(book.id), initial: title.charAt(0).toUpperCase() }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
          <AppText variant="label" numberOfLines={1} style={{ flexShrink: 1 }}>
            {title}
          </AppText>
          {fin ? <IconButton name={icons.checkCircle} size={15} color={colors.textMuted} /> : null}
        </View>
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
        {part ? (
          <ProgressBar
            progress={progress?.progress ?? 0}
            style={{ marginTop: spacing.sm, maxWidth: 240 }}
          />
        ) : null}
      </View>
      {!selecting && !notDownloaded ? (
        <Pressable onPress={onPlay} hitSlop={8} style={styles.rowPlay}>
          <IconButton name={icons.play} size={20} color={colors.text} />
        </Pressable>
      ) : null}
    </Touchable>
  )
}

function StatCell({ value, label }: { value: string; label: string }) {
  const colors = useColors()
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <AppText variant="label" style={{ fontWeight: '700' }}>
        {value}
      </AppText>
      <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
        {label}
      </AppText>
    </View>
  )
}

function Header({ onBack }: { onBack: () => void }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  return (
    <View style={styles.header}>
      <IconButton name={icons.back} onPress={onBack} style={styles.headerBtn} />
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
    headerBtn: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.fill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    hero: { alignItems: 'center', paddingHorizontal: spacing.xl },
    title: { textAlign: 'center', marginTop: spacing.sm, marginBottom: spacing.xs },
    overflowChip: {
      position: 'absolute',
      top: 9,
      width: 32,
      height: 132,
      borderRadius: radius.card,
      backgroundColor: colors.elevated,
      alignItems: 'center',
      justifyContent: 'center',
    },
    statStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'stretch',
      marginTop: spacing.lg,
      padding: spacing.lg,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    statDivider: {
      width: StyleSheet.hairlineWidth,
      height: '100%',
      backgroundColor: colors.hairline,
    },
    progCard: {
      marginHorizontal: spacing.lg,
      marginTop: spacing.lg,
      padding: spacing.lg,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      gap: spacing.md,
    },
    progTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    segTrack: { flexDirection: 'row', gap: 3 },
    seg: {
      flex: 1,
      height: 8,
      borderRadius: 3,
      backgroundColor: colors.elevated,
      overflow: 'hidden',
    },
    segFill: { height: '100%', backgroundColor: colors.accent, borderRadius: 3 },
    actions: {
      flexDirection: 'row',
      gap: spacing.md,
      marginHorizontal: spacing.lg,
      marginTop: spacing.lg,
    },
    markSeriesBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      marginHorizontal: spacing.lg,
      marginTop: spacing.md,
      paddingVertical: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    listHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      marginTop: spacing.xl,
      marginBottom: spacing.sm,
    },
    listHeadTitle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    list: { paddingHorizontal: spacing.lg, gap: spacing.xs },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.sm,
      borderRadius: radius.row,
    },
    rowSelected: { backgroundColor: colors.accentWash },
    rowDimmed: { opacity: 0.45 },
    num: { width: 24, textAlign: 'center', fontWeight: '700' },
    check: {
      width: 24,
      height: 24,
      borderRadius: 7,
      borderWidth: 2,
      borderColor: colors.textFaint,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    rowPlay: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: colors.fill,
      alignItems: 'center',
      justifyContent: 'center',
    },
  })
