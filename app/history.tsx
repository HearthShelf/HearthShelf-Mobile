/**
 * History: what you have been listening to, newest first.
 *
 * THE APP'S FIRST PAGINATED LIST. Every other list here either loads one page or
 * fetches everything with `limit=0`, so the loading / error / end-of-list states
 * below are new ground rather than a copy of an existing pattern - they are
 * likely to get copied, so they are deliberate:
 *   - the first load owns the screen (skeleton), later loads own only the footer
 *   - a failed page keeps what is already on screen and offers a retry, because
 *     throwing away twenty loaded sessions to show an error banner is worse
 *   - the end of the list says so once, rather than spinning forever
 *
 * Day grouping comes from core's groupByDay, shared with both web apps.
 *
 * Session counts: only `total` is honest, because the server reports it. Any
 * figure derived from rows is necessarily "of what has loaded so far" and is
 * labelled that way - a tile reading "38h" that grows as you scroll is a lie.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Alert, SectionList, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import {
  classifyDevice,
  coverHue,
  coverInitial,
  fmtSessDate,
  formatTimestamp,
  groupByDay,
} from '@hearthshelf/core'
import {
  coverUrl,
  deleteListeningSession,
  getMe,
  getSessionsPage,
  type SessionRow,
} from '@/api/abs'
import { AppText, Cover, Screen, Touchable } from '@/ui/primitives'
import { DeviceKindIcon } from '@/ui/DeviceKindIcon'
import { EmptyState, ErrorState, SkeletonRow } from '@/ui/states'
import { Icon } from '@/ui/icons'
import { useContentInset } from '@/ui/useContentInset'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { haptics } from '@/ui/haptics'
import { Toast, useToast } from '@/ui/Toast'

const PAGE_SIZE = 25

export default function HistoryScreen() {
  const router = useRouter()
  const colors = useColors()
  const s = makeStyles(colors)
  const inset = useContentInset()
  const { message: toastMsg, show: showToast } = useToast()

  const [rows, setRows] = useState<SessionRow[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [numPages, setNumPages] = useState(1)
  const [firstLoad, setFirstLoad] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [canDelete, setCanDelete] = useState(false)

  // Guards a re-entrant onEndReached: SectionList fires it repeatedly while the
  // user keeps scrolling, and without this the same page loads several times and
  // rows duplicate.
  const inFlight = useRef(false)
  /** Rows currently held. Mirrors `rows.length` in a ref so loadPage can read it
   *  without being rebuilt (and re-triggering onEndReached) on every append. */
  const loadedCount = useRef(0)

  const loadPage = useCallback(async (next: number, replace = false) => {
    if (inFlight.current) return
    inFlight.current = true
    if (next > 0) setLoadingMore(true)
    try {
      // ABS pages by index with no raw-offset parameter, so the page to ask for
      // is derived from how many rows we HOLD, not from a page counter.
      //
      // This is what makes deleting safe. Removing a row shifts every later row
      // one place toward page 0, so a page counter would step straight over the
      // row that crossed the boundary - silently, and the de-dupe cannot recover
      // something that was never served. Anchoring on `loaded` re-requests the
      // page the next unfetched row actually sits in; it overlaps what we hold,
      // and the de-dupe drops the overlap.
      const wanted = replace ? 0 : Math.floor(loadedCount.current / PAGE_SIZE)
      const res = await getSessionsPage(wanted, PAGE_SIZE)
      setTotal(res.total)
      setNumPages(res.numPages)
      setPage(wanted)
      setRows((prev) => {
        const merged =
          replace || next === 0
            ? res.rows
            : (() => {
                const seen = new Set(prev.map((r) => r.id))
                return [...prev, ...res.rows.filter((r) => !seen.has(r.id))]
              })()
        loadedCount.current = merged.length
        return merged
      })
      setError(null)
    } catch {
      setError('Could not load your history.')
    } finally {
      inFlight.current = false
      setLoadingMore(false)
      setFirstLoad(false)
    }
  }, [])

  useEffect(() => {
    void loadPage(0, true)
    // Delete is permission-gated server-side; hide the affordance when the
    // account lacks it rather than offering an action that always 403s. Admins
    // bypass the flag, matching how the web apps gate this. The 403 is still
    // handled - an out-of-date permission read must not corrupt the list.
    void getMe()
      .then((me) => {
        const admin = me.type === 'admin' || me.type === 'root'
        setCanDelete(admin || me.permissions?.delete === true)
      })
      .catch(() => setCanDelete(false))
  }, [loadPage])

  // Done when we hold every row the server still has. Derived from the list
  // rather than the page counter: a delete decrements `total` and drops a row,
  // so both sides stay in step, whereas the page index would not.
  const atEnd = rows.length >= total

  const onEndReached = useCallback(() => {
    if (firstLoad || loadingMore || atEnd || error) return
    void loadPage(page + 1)
  }, [firstLoad, loadingMore, atEnd, error, page, loadPage])

  const sections = useMemo(() => groupByDay(rows, (r) => r.startedAt), [rows])

  // Derived from loaded rows only - hence the "so far" labelling below.
  const loadedSeconds = useMemo(() => rows.reduce((a, r) => a + r.seconds, 0), [rows])

  const confirmDelete = (row: SessionRow) => {
    Alert.alert(
      'Delete this session?',
      `${row.title} - ${formatTimestamp(row.seconds)} on ${fmtSessDate(row.startedAt).day}. This cannot be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => void doDelete(row) },
      ],
    )
  }

  /** Optimistic: drop the row now, restore it if the server refuses. */
  const doDelete = async (row: SessionRow) => {
    haptics.select()
    const snapshot = rows
    const snapshotTotal = total
    setRows((prev) => {
      const next = prev.filter((r) => r.id !== row.id)
      // Keep the paging anchor honest - the next page index is derived from it.
      loadedCount.current = next.length
      return next
    })
    setTotal((t) => Math.max(0, t - 1))
    try {
      await deleteListeningSession(row.id)
      showToast('Session deleted')
    } catch {
      // Includes a 403 from an account whose delete permission changed under us.
      setRows(snapshot)
      loadedCount.current = snapshot.length
      setTotal(snapshotTotal)
      showToast('Could not delete that session')
    }
  }

  return (
    <Screen>
      <View style={s.head}>
        <Touchable
          onPress={() => router.back()}
          style={s.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Icon name="arrow-back" size={20} color={colors.text} />
        </Touchable>
        <View style={s.headText}>
          <AppText variant="eyebrow" color={colors.accent}>
            Insights
          </AppText>
          <AppText variant="title">Listening history</AppText>
        </View>
        <View style={s.iconBtn} />
      </View>

      {firstLoad ? (
        <View style={s.body}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : error && rows.length === 0 ? (
        <ErrorState message={error} onRetry={() => void loadPage(0, true)} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon="history"
          title="No listening yet"
          body="Your sessions will appear here as you listen."
        />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(r) => r.id}
          contentContainerStyle={[s.body, { paddingBottom: inset + spacing.xl }]}
          stickySectionHeadersEnabled={false}
          onEndReached={onEndReached}
          onEndReachedThreshold={0.4}
          ListHeaderComponent={
            <View style={s.tiles}>
              <View style={s.tile}>
                <AppText variant="title">{String(total)}</AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  Sessions
                </AppText>
              </View>
              <View style={s.tile}>
                <AppText variant="title">{`${Math.round(loadedSeconds / 3600)}h`}</AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  Loaded so far
                </AppText>
              </View>
              <View style={s.tile}>
                <AppText variant="title">{String(rows.length)}</AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  Shown
                </AppText>
              </View>
            </View>
          }
          renderSectionHeader={({ section }) => (
            <AppText variant="label" color={colors.textMuted} style={s.dayHead}>
              {section.title}
            </AppText>
          )}
          renderItem={({ item }) => (
            <SessionRowView
              row={item}
              canDelete={canDelete}
              onOpen={() => router.push(`/item/${item.itemId}`)}
              onDelete={() => confirmDelete(item)}
            />
          )}
          ListFooterComponent={
            <View style={s.footer}>
              {loadingMore ? (
                <ActivityIndicator color={colors.accent} />
              ) : error ? (
                <Touchable
                  onPress={() => void loadPage(page + 1)}
                  style={s.retry}
                  accessibilityRole="button"
                  accessibilityLabel="Retry loading more"
                >
                  <Icon name="refresh" size={16} color={colors.accent} />
                  <AppText variant="label" color={colors.accent}>
                    Couldn't load more - retry
                  </AppText>
                </Touchable>
              ) : atEnd ? (
                <AppText variant="caption" color={colors.textFaint}>
                  {`That's all ${total} ${total === 1 ? 'session' : 'sessions'}.`}
                </AppText>
              ) : null}
            </View>
          }
        />
      )}
      <Toast message={toastMsg} />
    </Screen>
  )
}

function SessionRowView({
  row,
  canDelete,
  onOpen,
  onDelete,
}: {
  row: SessionRow
  canDelete: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  const colors = useColors()
  const s = makeStyles(colors)
  const when = fmtSessDate(row.startedAt)
  // classifyDevice's label is the human name for the surface ("Car (Web)",
  // "iPhone"), which is what task 3.3 wants alongside the icon.
  const device = classifyDevice(row.device).label

  return (
    <Touchable
      onPress={onOpen}
      onLongPress={canDelete ? onDelete : undefined}
      style={s.row}
      accessibilityRole="button"
      accessibilityLabel={`${row.title}, ${formatTimestamp(row.seconds)} at ${when.time}`}
      accessibilityHint={canDelete ? 'Long press to delete this session' : undefined}
    >
      <Cover
        uri={coverUrl(row.itemId)}
        width={44}
        aspectRatio={1}
        fallback={{
          hue: coverHue(row.itemId),
          initial: coverInitial(row.title),
          title: row.title,
        }}
      />
      <View style={s.rowMeta}>
        <AppText variant="label" numberOfLines={1}>
          {row.title}
        </AppText>
        <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
          {row.author}
        </AppText>
      </View>
      <View style={s.rowRight}>
        <AppText variant="mono" color={colors.text}>
          {formatTimestamp(row.seconds)}
        </AppText>
        <View style={s.deviceRow}>
          <DeviceKindIcon deviceInfo={row.device} size={13} color={colors.textFaint} />
          <AppText variant="caption" color={colors.textFaint} numberOfLines={1}>
            {`${device} · ${when.time}`}
          </AppText>
        </View>
      </View>
    </Touchable>
  )
}

function makeStyles(c: Palette) {
  return StyleSheet.create({
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
    },
    headText: { flex: 1, gap: 1 },
    iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    body: { paddingHorizontal: spacing.lg, gap: spacing.sm },
    tiles: { flexDirection: 'row', gap: spacing.sm, paddingBottom: spacing.md },
    tile: {
      flex: 1,
      alignItems: 'center',
      gap: 2,
      paddingVertical: spacing.md,
      borderRadius: radius.card,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.card,
    },
    dayHead: { paddingTop: spacing.md, paddingBottom: spacing.xs },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    rowMeta: { flex: 1, gap: 1 },
    rowRight: { alignItems: 'flex-end', gap: 2 },
    deviceRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    footer: { paddingVertical: spacing.lg, alignItems: 'center' },
    retry: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  })
}
