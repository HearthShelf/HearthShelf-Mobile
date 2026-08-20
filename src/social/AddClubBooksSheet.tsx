/**
 * Add books to a club's up-next queue without leaving the club room.
 *
 * Two ways in, because a club runs on both: search the library for one book, or
 * pick a series and queue the whole run in sequence order (a 12-book series is
 * one tap, not twelve trips to the library). Both feed the same enqueueClubBook
 * call; the server no-ops a book the club already has, so re-adding is safe and
 * the sheet just reports what actually landed.
 *
 * Series books come from the search response itself (ABS embeds them in each
 * series hit), so picking a series costs no second request.
 */
import { forwardRef, useCallback, useEffect, useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { BottomSheetScrollView, BottomSheetTextInput } from '@gorhom/bottom-sheet'
import type { ABSLibraryItem, HSClubBook } from '@hearthshelf/core'
import { coverHue, seriesSeqFromName } from '@hearthshelf/core'
import { coverUrl, searchLibraryAll } from '@/api/abs'
import { enqueueClubBook } from '@/api/clubs'
import { AppText, Centered, Cover, Loading, Sheet, type SheetRef, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

/** Typing fires a search per keystroke without this. */
const DEBOUNCE_MS = 300
const SEARCH_LIMIT = 24

/** Series books in reading order, so "#2" precedes "#10" (a string sort would
 *  not). Books with no parsable sequence keep their original order at the back. */
function bySeriesSequence(books: ABSLibraryItem[]): ABSLibraryItem[] {
  return books
    .map((b, i) => {
      const raw = seriesSeqFromName(b.media.metadata.seriesName)
      const n = raw ? Number.parseFloat(raw) : Number.NaN
      return { b, i, n: Number.isNaN(n) ? Number.POSITIVE_INFINITY : n }
    })
    .sort((a, b) => (a.n !== b.n ? a.n - b.n : a.i - b.i))
    .map((x) => x.b)
}

interface SeriesHit {
  id: string
  name: string
  books: ABSLibraryItem[]
}

export interface AddClubBooksSheetProps {
  clubId: string
  clubName: string
  libraryId: string | null
  /** Books already in the club (queue + history), so the sheet can say so. */
  existing: HSClubBook[]
  /** Called after at least one book actually landed, so the room can reload. */
  onAdded: () => void
  /** Surface a message on the opener's toast - this sheet has no toast of its own. */
  onMessage: (text: string) => void
}

/**
 * Presented with `ref.current?.present()`. Mounted by the club room alongside its
 * other sheets.
 */
export const AddClubBooksSheet = forwardRef<SheetRef, AddClubBooksSheetProps>(
  function AddClubBooksSheet({ clubId, clubName, libraryId, existing, onAdded, onMessage }, ref) {
    const colors = useColors()
    const styles = useMemo(() => makeStyles(colors), [colors])

    const [term, setTerm] = useState('')
    const [query, setQuery] = useState('')
    const [books, setBooks] = useState<ABSLibraryItem[]>([])
    const [seriesHits, setSeriesHits] = useState<SeriesHit[]>([])
    const [searching, setSearching] = useState(false)
    const [failed, setFailed] = useState(false)
    const [series, setSeries] = useState<SeriesHit | null>(null)
    const [busy, setBusy] = useState(false)

    const inClub = useMemo(() => new Set(existing.map((b) => b.libraryItemId)), [existing])

    useEffect(() => {
      const t = setTimeout(() => setQuery(term.trim()), DEBOUNCE_MS)
      return () => clearTimeout(t)
    }, [term])

    // Search on the debounced term. A stale response can outrun a newer one, so
    // the cancelled flag keeps the last query's results from being overwritten.
    useEffect(() => {
      if (!query || !libraryId) {
        setBooks([])
        setSeriesHits([])
        setFailed(false)
        return
      }
      let cancelled = false
      setSearching(true)
      setFailed(false)
      void (async () => {
        try {
          const res = await searchLibraryAll(libraryId, query, SEARCH_LIMIT)
          if (cancelled) return
          setBooks((res.book ?? []).map((b) => b.libraryItem))
          setSeriesHits(
            (res.series ?? []).map((s) => ({
              id: s.series.id,
              name: s.series.name,
              books: s.books ?? [],
            })),
          )
        } catch {
          if (!cancelled) setFailed(true)
        } finally {
          if (!cancelled) setSearching(false)
        }
      })()
      return () => {
        cancelled = true
      }
    }, [query, libraryId])

    const reset = useCallback(() => {
      setTerm('')
      setQuery('')
      setBooks([])
      setSeriesHits([])
      setSeries(null)
      setFailed(false)
    }, [])

    /**
     * Enqueue sequentially, never in parallel: the queue's sort order is assigned
     * per insert from the current max, so concurrent adds would race for a slot
     * and scramble a series' reading order.
     */
    const addMany = useCallback(
      async (ids: string[]) => {
        if (busy) return
        const fresh = ids.filter((id) => !inClub.has(id))
        if (fresh.length === 0) {
          onMessage('Already in this club')
          return
        }
        setBusy(true)
        let added = 0
        for (const id of fresh) {
          const ok = await enqueueClubBook(clubId, id)
          if (ok) added++
        }
        setBusy(false)
        if (added === 0) {
          onMessage('Could not add to the queue')
          return
        }
        haptics.mode()
        onMessage(added === 1 ? 'Added to up next' : `Added ${added} books to up next`)
        onAdded()
      },
      [busy, inClub, clubId, onAdded, onMessage],
    )

    const seriesBooks = series ? bySeriesSequence(series.books) : []
    const seriesFresh = seriesBooks.filter((b) => !inClub.has(b.id))

    return (
      <Sheet
        ref={ref}
        kicker={clubName}
        title={series ? series.name : 'Add books'}
        snapPoints={['85%']}
        onDismiss={reset}
      >
        {series ? (
          <>
            <Touchable style={styles.backRow} onPress={() => setSeries(null)}>
              <Icon name={icons.chevronLeft} size={16} color={colors.textMuted} />
              <AppText variant="caption" color={colors.textMuted}>
                Back to search
              </AppText>
            </Touchable>
            <View style={styles.seriesHead}>
              <AppText variant="caption" color={colors.textMuted}>
                {seriesBooks.length} {seriesBooks.length === 1 ? 'book' : 'books'} ·{' '}
                {seriesFresh.length} not in this club
              </AppText>
              {seriesFresh.length > 0 ? (
                <Touchable
                  style={styles.addAllBtn}
                  disabled={busy}
                  onPress={() => void addMany(seriesFresh.map((b) => b.id))}
                  accessibilityRole="button"
                  accessibilityLabel={`Add all ${seriesFresh.length} books to up next`}
                >
                  <AppText variant="caption" color={colors.onAccent}>
                    {busy ? 'Adding…' : `Add all ${seriesFresh.length}`}
                  </AppText>
                </Touchable>
              ) : null}
            </View>
            <BottomSheetScrollView contentContainerStyle={styles.listPad}>
              {seriesBooks.map((b, i) => (
                <ResultRow
                  key={b.id}
                  item={b}
                  index={i + 1}
                  already={inClub.has(b.id)}
                  busy={busy}
                  onAdd={() => void addMany([b.id])}
                />
              ))}
            </BottomSheetScrollView>
          </>
        ) : (
          <>
            <View style={styles.searchWrap}>
              <Icon name={icons.search} size={16} color={colors.textMuted} />
              <BottomSheetTextInput
                value={term}
                onChangeText={setTerm}
                placeholder="Search for a book or series"
                placeholderTextColor={colors.textFaint}
                autoCorrect={false}
                returnKeyType="search"
                style={styles.searchInput}
                accessibilityLabel="Search the library"
              />
            </View>
            <BottomSheetScrollView
              contentContainerStyle={styles.listPad}
              keyboardShouldPersistTaps="handled"
            >
              {!libraryId ? (
                <Centered>
                  <AppText variant="meta" color={colors.textMuted}>
                    No library available.
                  </AppText>
                </Centered>
              ) : !query ? (
                <Centered>
                  <Icon name={icons.search} size={26} color={colors.textFaint} />
                  <AppText variant="meta" color={colors.textMuted} style={styles.centerText}>
                    Search by title, author, or series name.
                  </AppText>
                </Centered>
              ) : searching ? (
                <Loading label="Searching…" />
              ) : failed ? (
                <Centered>
                  <AppText variant="meta" color={colors.textMuted}>
                    Could not reach this library.
                  </AppText>
                </Centered>
              ) : (
                <>
                  {seriesHits.length > 0 ? (
                    <>
                      <AppText variant="eyebrow" color={colors.textMuted} style={styles.groupLabel}>
                        Series
                      </AppText>
                      {seriesHits.map((s) => (
                        <Touchable
                          key={s.id}
                          style={styles.seriesRow}
                          onPress={() => setSeries(s)}
                          accessibilityRole="button"
                          accessibilityLabel={`Open series ${s.name}`}
                        >
                          <Icon name={icons.collections} size={20} color={colors.textMuted} />
                          <View style={styles.rowText}>
                            <AppText variant="meta" numberOfLines={1}>
                              {s.name}
                            </AppText>
                            <AppText variant="caption" color={colors.textMuted}>
                              Queue the whole series in order
                            </AppText>
                          </View>
                          <Icon name={icons.chevronRight} size={18} color={colors.textMuted} />
                        </Touchable>
                      ))}
                    </>
                  ) : null}
                  <AppText variant="eyebrow" color={colors.textMuted} style={styles.groupLabel}>
                    Books
                  </AppText>
                  {books.length === 0 ? (
                    <AppText variant="meta" color={colors.textMuted} style={styles.centerText}>
                      No books matched that search.
                    </AppText>
                  ) : (
                    books.map((b) => (
                      <ResultRow
                        key={b.id}
                        item={b}
                        already={inClub.has(b.id)}
                        busy={busy}
                        onAdd={() => void addMany([b.id])}
                      />
                    ))
                  )}
                </>
              )}
            </BottomSheetScrollView>
          </>
        )}
      </Sheet>
    )
  },
)

function ResultRow({
  item,
  index,
  already,
  busy,
  onAdd,
}: {
  item: ABSLibraryItem
  index?: number
  already: boolean
  busy: boolean
  onAdd: () => void
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const title = item.media.metadata.title || 'Untitled'
  const author = item.media.metadata.authorName
  return (
    <View style={styles.resultRow}>
      {index != null ? (
        <AppText variant="caption" color={colors.textFaint} style={styles.indexBadge}>
          {index}
        </AppText>
      ) : null}
      <Cover
        uri={coverUrl(item.id)}
        itemId={item.id}
        size={44}
        radius={radius.tile}
        fallback={{ hue: coverHue(item.id), initial: title.charAt(0) }}
      />
      <View style={styles.rowText}>
        <AppText variant="meta" numberOfLines={1}>
          {title}
        </AppText>
        {author ? (
          <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
            {author}
          </AppText>
        ) : null}
      </View>
      {already ? (
        <View style={styles.inClubTag}>
          <Icon name={icons.check} size={14} color={colors.textMuted} />
          <AppText variant="caption" color={colors.textMuted}>
            In club
          </AppText>
        </View>
      ) : (
        <Touchable
          style={styles.addBtn}
          disabled={busy}
          onPress={onAdd}
          accessibilityRole="button"
          accessibilityLabel={`Add ${title} to up next`}
        >
          <AppText variant="caption" color={colors.onAccent}>
            Add
          </AppText>
        </Touchable>
      )}
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    searchWrap: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginHorizontal: spacing.lg,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
    },
    searchInput: { flex: 1, paddingVertical: spacing.sm, color: colors.text },
    listPad: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl },
    groupLabel: { marginTop: spacing.md, marginBottom: spacing.xs },
    centerText: { textAlign: 'center', paddingVertical: spacing.lg },
    backRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
    },
    seriesHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
    },
    seriesRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    resultRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    rowText: { flex: 1, minWidth: 0 },
    indexBadge: { width: 18, textAlign: 'center' },
    addBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    addAllBtn: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    inClubTag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  })
