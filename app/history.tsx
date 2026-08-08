/**
 * History: what you have been listening to, and what you have finished.
 *
 * Two questions that need different answers, so two segments:
 *   Sessions - the listening log, grouped by day. Also the only place to fix a
 *              session that banked six hours you slept through.
 *   Books    - the completion log, grouped by month, with a re-read count.
 *
 * Both page through the shared usePagedList hook, which owns the awkward parts
 * (offset anchoring, overlap de-duping, re-entrant onEndReached). The loading /
 * error / end-of-list states here are the app's first of their kind and are
 * likely to get copied:
 *   - the first load owns the screen (skeleton); later loads own only the footer
 *   - a failed page keeps the rows already on screen and offers a retry, rather
 *     than throwing away everything loaded to show a banner
 *   - the end of the list says so once, instead of spinning forever
 *
 * Only `total` is an honest count - the server reports it. Anything derived from
 * loaded rows is labelled as covering what has loaded so far, because a tile
 * reading "38h" that grows as you scroll is a lie.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  SectionList,
  StyleSheet,
  View,
  type AlertButton,
} from 'react-native'
import { useRouter } from 'expo-router'
import type { BottomSheetModal } from '@gorhom/bottom-sheet'
import {
  classifyDevice,
  coverHue,
  coverInitial,
  fmtMonthLabel,
  fmtSessDate,
  formatTimestamp,
  groupByDay,
  type HSCompletion,
} from '@hearthshelf/core'
import {
  ABSRequestError,
  coverUrl,
  deleteListeningSession,
  getMe,
  getSessionsAtOffset,
  updateListeningSession,
  type SessionRow,
} from '@/api/abs'
import { getCompletionsPage } from '@/api/completions'
import { AppText, Cover, Screen, Touchable } from '@/ui/primitives'
import { DeviceKindIcon } from '@/ui/DeviceKindIcon'
import { EmptyState, ErrorState, SkeletonRow } from '@/ui/states'
import { Icon } from '@/ui/icons'
import { SessionDurationSheet } from '@/ui/SessionDurationSheet'
import { usePagedList } from '@/ui/usePagedList'
import { AppTabBar, useGoToTab } from '@/ui/AppTabBar'
import { SwipeableRow, type SwipeAction } from '@/ui/SwipeActions'
import { useContentInset } from '@/ui/useContentInset'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { haptics } from '@/ui/haptics'
import { Toast, useToast } from '@/ui/Toast'

const PAGE_SIZE = 25

type Segment = 'sessions' | 'books'

export default function HistoryScreen() {
  const [segment, setSegment] = useState<Segment>('sessions')
  const goToTab = useGoToTab()

  // Reached from the More menu, so More reads as the active tab - same as the
  // settings stack. Without a tab bar here nothing reserves the bottom band and
  // the list runs under the mini player (see hasBottomTabBar).
  return (
    <Screen tabBar={<AppTabBar activeName="more" onPressTab={goToTab} />}>
      <Header segment={segment} onSegment={setSegment} />
      {segment === 'sessions' ? <SessionsView /> : <BooksView />}
    </Screen>
  )
}

function Header({ segment, onSegment }: { segment: Segment; onSegment: (s: Segment) => void }) {
  const router = useRouter()
  const colors = useColors()
  const s = makeStyles(colors)
  return (
    <View style={s.headWrap}>
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
          <AppText variant="title">History</AppText>
        </View>
        <View style={s.iconBtn} />
      </View>
      <View style={s.segments}>
        {(
          [
            ['sessions', 'Sessions'],
            ['books', 'Books'],
          ] as [Segment, string][]
        ).map(([id, label]) => (
          <Touchable
            key={id}
            onPress={() => {
              if (id !== segment) haptics.select()
              onSegment(id)
            }}
            style={[s.segment, segment === id && s.segmentOn]}
            accessibilityRole="tab"
            accessibilityState={{ selected: segment === id }}
            accessibilityLabel={label}
          >
            <AppText variant="label" color={segment === id ? colors.onAccent : colors.textMuted}>
              {label}
            </AppText>
          </Touchable>
        ))}
      </View>
    </View>
  )
}

// ---- Sessions ---------------------------------------------------------------

function SessionsView() {
  const router = useRouter()
  const colors = useColors()
  const s = makeStyles(colors)
  const inset = useContentInset()
  const { message: toastMsg, show: showToast } = useToast()
  const [canDelete, setCanDelete] = useState(false)
  const [editing, setEditing] = useState<SessionRow | null>(null)
  const editSheet = useRef<BottomSheetModal>(null)

  const list = usePagedList<SessionRow>(getSessionsAtOffset, {
    pageSize: PAGE_SIZE,
    keyOf: (r) => r.id,
    errorMessage: 'Could not load your history.',
  })

  useEffect(() => {
    // Mirror the server's own rule exactly. ABS gates DELETE /api/sessions/:id on
    // `permissions.delete && isActive` with NO admin bypass, and its default
    // permissions grant delete to root ONLY - every other action grants to
    // root|admin, delete deliberately does not. So an `admin || ...` bypass here
    // shows a Delete button to admins that the server then 403s every time.
    // A 403 is still handled below: a stale read must not corrupt the list.
    void getMe()
      .then((me) => setCanDelete(me.permissions?.delete === true))
      .catch(() => setCanDelete(false))
  }, [])

  const sections = useMemo(() => groupByDay(list.rows, (r) => r.startedAt), [list.rows])
  const loadedSeconds = useMemo(() => list.rows.reduce((a, r) => a + r.seconds, 0), [list.rows])

  // Long-press offers both corrections. Editing is always available; deleting is
  // permission-gated, so on an account without it the chooser degrades to a
  // single Edit action rather than showing something that would 403.
  const openActions = (row: SessionRow) => {
    haptics.select()
    const actions: AlertButton[] = [{ text: 'Edit duration', onPress: () => openEdit(row) }]
    if (canDelete) {
      actions.push({
        text: 'Delete session',
        style: 'destructive',
        onPress: () => confirmDelete(row),
      })
    }
    actions.push({ text: 'Cancel', style: 'cancel' })
    Alert.alert(
      row.title,
      fmtSessDate(row.startedAt).day + ' · ' + formatTimestamp(row.seconds),
      actions,
    )
  }

  const openEdit = (row: SessionRow) => {
    setEditing(row)
    editSheet.current?.present()
  }

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

  const doDelete = async (row: SessionRow) => {
    const restore = list.removeRow((r) => r.id === row.id)
    try {
      await deleteListeningSession(row.id)
      showToast('Session deleted')
    } catch (e) {
      restore()
      // A 403 is the server saying this account lacks delete, not a transient
      // failure - retrying will never work, so say so instead of "could not".
      // The affordance is gated on the same flag, so this should be unreachable;
      // it still fires if the permission changed since the screen loaded.
      const denied = e instanceof ABSRequestError && e.status === 403
      showToast(
        denied ? "Your account isn't allowed to delete sessions" : 'Could not delete that session',
      )
      if (denied) setCanDelete(false)
    }
  }

  /**
   * Optimistic duration edit. The write re-submits the whole session through
   * ABS's local-session ingest keeping its id, which upserts - that upsert is
   * the entire basis of this path, since ABS has no session PATCH.
   */
  const saveDuration = async (row: SessionRow, seconds: number) => {
    editSheet.current?.dismiss()
    const previous = row.seconds
    list.patchRow(
      (r) => r.id === row.id,
      (r) => ({ ...r, seconds }),
    )
    try {
      await updateListeningSession({
        id: row.id,
        libraryItemId: row.itemId,
        displayTitle: row.title,
        duration: row.duration,
        currentTime: row.currentTime,
        timeListening: seconds,
        startedAt: row.startedAt,
        updatedAt: row.updatedAt,
      })
      showToast('Duration updated')
    } catch {
      list.patchRow(
        (r) => r.id === row.id,
        (r) => ({ ...r, seconds: previous }),
      )
      showToast('Could not update that session')
    }
  }

  if (list.firstLoad) return <FirstLoad />
  if (list.error && list.rows.length === 0)
    return <ErrorState message={list.error} onRetry={list.reload} />
  if (list.rows.length === 0)
    return (
      <EmptyState
        icon="history"
        title="No listening yet"
        body="Your sessions will appear here as you listen."
      />
    )

  return (
    <>
      <SectionList
        sections={sections}
        keyExtractor={(r) => r.id}
        contentContainerStyle={[s.body, { paddingBottom: inset + spacing.xl }]}
        stickySectionHeadersEnabled={false}
        onEndReached={list.onEndReached}
        onEndReachedThreshold={0.4}
        ListHeaderComponent={
          <View style={s.tiles}>
            <Tile value={String(list.total)} label="Sessions" />
            <Tile value={`${Math.round(loadedSeconds / 3600)}h`} label="Loaded so far" />
            <Tile value={String(list.rows.length)} label="Shown" />
          </View>
        }
        renderSectionHeader={({ section }) => <DayHeader title={section.title} />}
        renderItem={({ item }) => (
          <SessionRowView
            row={item}
            canDelete={canDelete}
            onOpen={() => router.push(`/item/${item.itemId}`)}
            onActions={() => openActions(item)}
            onEdit={() => openEdit(item)}
            onDelete={() => confirmDelete(item)}
          />
        )}
        ListFooterComponent={
          <ListFooter
            list={list}
            endLabel={`That's all ${list.total} ${list.total === 1 ? 'session' : 'sessions'}.`}
          />
        }
      />
      <SessionDurationSheet ref={editSheet} row={editing} onSave={saveDuration} />
      <Toast message={toastMsg} />
    </>
  )
}

function SessionRowView({
  row,
  canDelete,
  onOpen,
  onActions,
  onEdit,
  onDelete,
}: {
  row: SessionRow
  canDelete: boolean
  onOpen: () => void
  onActions: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const colors = useColors()
  const s = makeStyles(colors)
  const when = fmtSessDate(row.startedAt)
  // classifyDevice's label is the human name for the surface ("Car (Web)",
  // "iPhone"), which is what belongs next to the icon.
  const device = classifyDevice(row.device).label

  // Swipe exposes the same corrections the long press offers. Delete is
  // permission-gated the same way, so an account without it swipes to a single
  // Edit button rather than one that would 403.
  const actions: SwipeAction[] = [
    { key: 'edit', label: 'Edit', icon: 'edit', onPress: onEdit, tone: 'affirmative' },
    ...(canDelete
      ? [
          {
            key: 'delete',
            label: 'Delete',
            icon: 'delete' as const,
            onPress: onDelete,
            tone: 'destructive' as const,
          },
        ]
      : []),
  ]

  return (
    <SwipeableRow actions={actions}>
      <Touchable
        onPress={onOpen}
        onLongPress={onActions}
        style={s.row}
        accessibilityRole="button"
        accessibilityLabel={`${row.title}, ${formatTimestamp(row.seconds)} at ${when.time}`}
        accessibilityHint="Swipe left or long press to correct or delete this session"
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
    </SwipeableRow>
  )
}

// ---- Books ------------------------------------------------------------------

function BooksView() {
  const router = useRouter()
  const colors = useColors()
  const s = makeStyles(colors)
  const inset = useContentInset()

  const list = usePagedList<HSCompletion>(getCompletionsPage, {
    pageSize: PAGE_SIZE,
    keyOf: (r) => r.libraryItemId,
    errorMessage: 'Could not load your finished books.',
  })

  // Books with no parseable finish date cannot be placed on a month, so they
  // group under one honest heading rather than being silently dropped or
  // bucketed into the current month.
  const sections = useMemo(
    () =>
      groupByDay(
        list.rows,
        (r) => r.lastFinishedAt ?? 0,
        (ms) => (ms > 0 ? fmtMonthLabel(ms) : 'Date unknown'),
      ),
    [list.rows],
  )

  const rereads = useMemo(() => list.rows.filter((r) => r.completions > 1).length, [list.rows])

  if (list.firstLoad) return <FirstLoad />

  // The distinction that matters: this server CANNOT provide completion data
  // (no ABS database mounted), which is not the same as having finished nothing.
  if (!list.available)
    return (
      <EmptyState
        icon="cloud-off"
        title="Not available on this server"
        body="Finished-book history needs the AudiobookShelf database mounted. Your listening sessions still work."
      />
    )

  if (list.error && list.rows.length === 0)
    return <ErrorState message={list.error} onRetry={list.reload} />

  if (list.rows.length === 0)
    return (
      <EmptyState
        icon="menu-book"
        title="Nothing finished yet"
        body="Books you finish will be listed here, newest first."
      />
    )

  return (
    <SectionList
      sections={sections}
      keyExtractor={(r) => r.libraryItemId}
      contentContainerStyle={[s.body, { paddingBottom: inset + spacing.xl }]}
      stickySectionHeadersEnabled={false}
      onEndReached={list.onEndReached}
      onEndReachedThreshold={0.4}
      ListHeaderComponent={
        <View style={s.tiles}>
          <Tile value={String(list.total)} label="Finished" />
          <Tile value={String(rereads)} label="Re-read so far" />
          <Tile value={String(list.rows.length)} label="Shown" />
        </View>
      }
      renderSectionHeader={({ section }) => <DayHeader title={section.title} />}
      renderItem={({ item }) => (
        <BookRowView row={item} onOpen={() => router.push(`/item/${item.libraryItemId}`)} />
      )}
      ListFooterComponent={
        <ListFooter
          list={list}
          endLabel={`That's all ${list.total} ${list.total === 1 ? 'book' : 'books'}.`}
        />
      }
    />
  )
}

function BookRowView({ row, onOpen }: { row: HSCompletion; onOpen: () => void }) {
  const colors = useColors()
  const s = makeStyles(colors)
  const finished =
    row.lastFinishedAt != null && row.lastFinishedAt > 0
      ? new Date(row.lastFinishedAt).toLocaleDateString([], {
          month: 'short',
          day: 'numeric',
        })
      : 'Date unknown'

  return (
    <Touchable
      onPress={onOpen}
      style={s.row}
      accessibilityRole="button"
      accessibilityLabel={`${row.title}, finished ${finished}${
        row.completions > 1 ? `, read ${row.completions} times` : ''
      }`}
    >
      <Cover
        uri={coverUrl(row.libraryItemId)}
        width={44}
        aspectRatio={1}
        fallback={{
          hue: coverHue(row.libraryItemId),
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
        {row.completions > 1 ? (
          <View style={s.rereadPill}>
            <Icon name="replay" size={12} color={colors.accent} />
            <AppText variant="caption" color={colors.accent}>
              {`${row.completions}x`}
            </AppText>
          </View>
        ) : null}
        <AppText variant="caption" color={colors.textFaint}>
          {finished}
        </AppText>
      </View>
    </Touchable>
  )
}

// ---- Shared bits ------------------------------------------------------------

function FirstLoad() {
  const colors = useColors()
  const s = makeStyles(colors)
  return (
    <View style={s.body}>
      <SkeletonRow />
      <SkeletonRow />
      <SkeletonRow />
    </View>
  )
}

function Tile({ value, label }: { value: string; label: string }) {
  const colors = useColors()
  const s = makeStyles(colors)
  return (
    <View style={s.tile}>
      <AppText variant="title">{value}</AppText>
      <AppText variant="caption" color={colors.textMuted}>
        {label}
      </AppText>
    </View>
  )
}

function DayHeader({ title }: { title: string }) {
  const colors = useColors()
  const s = makeStyles(colors)
  return (
    <AppText variant="label" color={colors.textMuted} style={s.dayHead}>
      {title}
    </AppText>
  )
}

function ListFooter<T>({
  list,
  endLabel,
}: {
  list: ReturnType<typeof usePagedList<T>>
  endLabel: string
}) {
  const colors = useColors()
  const s = makeStyles(colors)
  return (
    <View style={s.footer}>
      {list.loadingMore ? (
        <ActivityIndicator color={colors.accent} />
      ) : list.error ? (
        <Touchable
          onPress={list.onEndReached}
          style={s.retry}
          accessibilityRole="button"
          accessibilityLabel="Retry loading more"
        >
          <Icon name="refresh" size={16} color={colors.accent} />
          <AppText variant="label" color={colors.accent}>
            Couldn&apos;t load more - retry
          </AppText>
        </Touchable>
      ) : list.atEnd ? (
        <AppText variant="caption" color={colors.textFaint}>
          {endLabel}
        </AppText>
      ) : null}
    </View>
  )
}

function makeStyles(c: Palette) {
  return StyleSheet.create({
    headWrap: { gap: spacing.md, paddingBottom: spacing.sm },
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
    },
    headText: { flex: 1, gap: 1 },
    iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    segments: {
      flexDirection: 'row',
      gap: spacing.xs,
      marginHorizontal: spacing.lg,
      padding: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: c.fill,
    },
    segment: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
    },
    segmentOn: { backgroundColor: c.accent },
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
    rereadPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      paddingHorizontal: spacing.sm,
      paddingVertical: 1,
      borderRadius: radius.pill,
      backgroundColor: c.accentTile,
    },
    footer: { paddingVertical: spacing.lg, alignItems: 'center' },
    retry: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  })
}
