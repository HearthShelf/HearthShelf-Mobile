/**
 * One listener's profile: what they're playing (or last played) as a hero,
 * their totals beside yours, and the books you've both finished.
 *
 * Reached from the Stats leaderboard / compare picker and the per-book reader
 * chips. Every section is privacy-gated server-side (see /hs/social/profile);
 * this screen deliberately distinguishes "they keep this private" from "the
 * feature isn't available", so a deliberate opt-out never reads as a broken
 * screen.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { View, ScrollView, Pressable, RefreshControl } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { HSProfileResponse, HSProfileListen, HSProfileBook } from '@hearthshelf/core'
import { coverHue, formatDuration } from '@hearthshelf/core'
import { getProfile } from '@/api/social'
import { avatarUrl, coverUrl } from '@/api/abs'
import { Screen, Centered, AppText, Avatar, Cover, IconButton, Loading } from '@/ui/primitives'
import { EmptyState, ErrorState } from '@/ui/states'
import { Icon, icons } from '@/ui/icons'
import { AppTabBar, tabFromParam, useGoToTab } from '@/ui/AppTabBar'
import { useMiniPlayerInset } from '@/ui/useContentInset'
import { LinearGradient } from 'expo-linear-gradient'
import { radius, spacing, withAlpha, type Palette } from '@/ui/theme'
import { useColors, useTheme } from '@/ui/ThemeProvider'
import { StyleSheet } from 'react-native'

type Status =
  | { phase: 'loading' }
  | { phase: 'not-shared' }
  | { phase: 'unavailable' }
  | { phase: 'ready'; profile: HSProfileResponse }

// Coarse "2 days ago" for the last-listened line. Presence, not an audit trail.
function agoLabel(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 2) return 'just now'
  if (mins < 60) return `${mins} minutes ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.round(hrs / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.round(days / 30)
  return `${months} month${months === 1 ? '' : 's'} ago`
}

function yearOf(ms: number | null): string {
  return ms ? String(new Date(ms).getFullYear()) : ''
}

/** How many finished tiles to mount per page. */
const FINISHED_PAGE = 60

/** Bucket an already newest-first list into year runs, order preserved. Books
 *  with no finish date land in a trailing "Earlier" group rather than a "" one. */
function groupByYear(books: HSProfileBook[]): { year: string; books: HSProfileBook[] }[] {
  const out: { year: string; books: HSProfileBook[] }[] = []
  for (const b of books) {
    const year = yearOf(b.finishedAt) || 'Earlier'
    const last = out[out.length - 1]
    if (last && last.year === year) last.books.push(b)
    else out.push({ year, books: [b] })
  }
  return out
}

type Styles = ReturnType<typeof makeStyles>

export default function UserProfileScreen() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { id, from } = useLocalSearchParams<{ id: string; from?: string }>()
  const active = tabFromParam(from, 'stats')
  const goToTab = useGoToTab()
  const miniInset = useMiniPlayerInset()

  const [status, setStatus] = useState<Status>({ phase: 'loading' })
  const [refreshing, setRefreshing] = useState(false)

  // `isStale` lets the mount effect drop a response for a previous id; retry and
  // pull-to-refresh pass nothing and always apply.
  const load = useCallback(
    async (isStale: () => boolean = () => false) => {
      const res = await getProfile(id)
      if (isStale()) return
      if (res.status === 'ok') setStatus({ phase: 'ready', profile: res.profile })
      else if (res.status === 'not-shared') setStatus({ phase: 'not-shared' })
      else setStatus({ phase: 'unavailable' })
    },
    [id],
  )

  useEffect(() => {
    let cancelled = false
    void load(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [load])

  const refresh = useCallback(async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }, [load])

  const openBook = useCallback(
    (itemId: string) => router.push(`/item/${itemId}?from=${active}`),
    [router, active],
  )

  const header = (
    <View style={styles.header}>
      <IconButton name={icons.back} onPress={() => router.back()} accessibilityLabel="Back" />
      <AppText variant="label" numberOfLines={1} style={styles.headerTitle}>
        {status.phase === 'ready' ? status.profile.username || 'Listener' : 'Profile'}
      </AppText>
    </View>
  )

  if (status.phase === 'loading') {
    return (
      <Screen tabBar={<AppTabBar activeName={active} onPressTab={goToTab} />}>
        {header}
        <Centered>
          <Loading />
        </Centered>
      </Screen>
    )
  }

  if (status.phase === 'not-shared') {
    return (
      <Screen tabBar={<AppTabBar activeName={active} onPressTab={goToTab} />}>
        {header}
        <Centered>
          <EmptyState
            icon={icons.lock}
            title="This listener keeps their activity private"
            body="They haven't opted into sharing, so there's no profile to show."
          />
        </Centered>
      </Screen>
    )
  }

  if (status.phase === 'unavailable') {
    return (
      <Screen tabBar={<AppTabBar activeName={active} onPressTab={goToTab} />}>
        {header}
        <Centered>
          <ErrorState
            title="Profiles aren't available"
            message="Community features need access to your library's database."
            onRetry={() => void load()}
          />
        </Centered>
      </Screen>
    )
  }

  const profile = status.profile

  return (
    <Screen tabBar={<AppTabBar activeName={active} onPressTab={goToTab} />}>
      {header}
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: miniInset + spacing.xl }]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => void refresh()}
            tintColor={colors.textMuted}
          />
        }
      >
        <View style={styles.identity}>
          <Avatar
            uri={avatarUrl(profile.userId)}
            size={64}
            name={profile.username || '?'}
            hue={coverHue(profile.userId)}
          />
          <View style={styles.identityMeta}>
            <AppText variant="title" numberOfLines={1}>
              {profile.username || 'Listener'}
              {profile.isMe ? ' (you)' : ''}
            </AppText>
            <AppText variant="caption" color={colors.textMuted}>
              {Math.round(profile.target.secondsListened / 3600)}h listened ·{' '}
              {profile.target.booksFinished} books finished
            </AppText>
          </View>
        </View>

        {profile.listeningShared && profile.listening && (
          <ListeningHero
            listen={profile.listening}
            // Subject of "<x> listened 3h ago", so it must be second person on
            // your own profile rather than your own name in the third person.
            username={profile.isMe ? 'You' : profile.username || 'They'}
            styles={styles}
            colors={colors}
            onOpen={openBook}
          />
        )}

        {profile.listeningShared && !profile.listening && (
          <EmptyState
            icon={icons.nowPlaying}
            title="Nothing playing"
            body="No recent listening to show."
            style={styles.blockEmpty}
          />
        )}

        {!profile.listeningShared && (
          <EmptyState
            icon={icons.lock}
            title="Listening activity is private"
            body={
              profile.isMe
                ? 'You haven\'t turned on "Share when I\'m listening", so this stays hidden from others.'
                : `${profile.username || 'This listener'} hasn't turned on "Share when I'm listening".`
            }
            style={styles.blockEmpty}
          />
        )}

        {!profile.isMe && <CompareSection profile={profile} styles={styles} colors={colors} />}

        <YearInReviewSection profile={profile} styles={styles} colors={colors} />

        <FinishedSection profile={profile} styles={styles} colors={colors} onOpen={openBook} />
      </ScrollView>
    </Screen>
  )
}

// What they're playing now, or last played. The whole point of the screen:
// seeing "80h this week" on the leaderboard and finding out what it went into
// without walking the library book by book.
function ListeningHero({
  listen,
  username,
  styles,
  colors,
  onOpen,
}: {
  listen: HSProfileListen
  username: string
  styles: Styles
  colors: Palette
  onOpen: (itemId: string) => void
}) {
  const { shadow } = useTheme()
  const pct = Math.round(Math.min(Math.max(listen.progress || 0, 0), 1) * 100)
  const remaining = Math.max(listen.durationSec - listen.currentTimeSec, 0)
  const label = listen.isLive
    ? 'Listening now'
    : listen.isFinished
      ? 'Last finished'
      : 'Last listened to'

  return (
    <Pressable style={[styles.heroCard, shadow.card]} onPress={() => onOpen(listen.libraryItemId)}>
      <LinearGradient
        pointerEvents="none"
        colors={[
          withAlpha(coverHue(listen.libraryItemId), 0.34),
          withAlpha(colors.accent, 0.07),
          colors.card,
        ]}
        locations={[0, 0.56, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View style={styles.heroRow}>
        <Cover
          uri={coverUrl(listen.libraryItemId)}
          itemId={listen.libraryItemId}
          size={96}
          radius={radius.tile}
          fallback={{
            hue: coverHue(listen.libraryItemId),
            initial: (listen.title || '?').charAt(0).toUpperCase(),
          }}
        />
        <View style={styles.heroMeta}>
          <View style={styles.eyebrowRow}>
            {listen.isLive && <View style={styles.liveDot} />}
            <AppText variant="eyebrow" color={listen.isLive ? colors.accent : colors.textMuted}>
              {label}
            </AppText>
          </View>
          <AppText variant="label" numberOfLines={2} style={styles.heroTitle}>
            {listen.title || 'Untitled'}
          </AppText>
          {!!listen.author && (
            <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
              by {listen.author}
            </AppText>
          )}
          {!!listen.narrator && (
            <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
              Narrated by {listen.narrator}
            </AppText>
          )}
        </View>
      </View>

      {listen.durationSec > 0 && (
        <View style={styles.heroProg}>
          <View style={styles.bar}>
            <View style={[styles.barFill, { width: `${pct}%`, backgroundColor: colors.accent }]} />
          </View>
          <View style={styles.heroProgMeta}>
            <AppText variant="meta" color={colors.textMuted}>
              {pct}% through
            </AppText>
            {remaining > 0 && !listen.isFinished && (
              <AppText variant="meta" color={colors.textMuted}>
                {formatDuration(remaining)} left
              </AppText>
            )}
          </View>
        </View>
      )}

      {!listen.isLive && !!listen.lastListenedAt && (
        <AppText variant="meta" color={colors.textMuted} style={styles.heroAgo}>
          {username} listened {agoLabel(listen.lastListenedAt)}
        </AppText>
      )}
    </Pressable>
  )
}

// Their totals beside yours. A row renders only when BOTH sides carry a number,
// so an older server that omits a newer field never draws a misleading
// 0-vs-real bar.
function CompareSection({
  profile,
  styles,
  colors,
}: {
  profile: HSProfileResponse
  styles: Styles
  colors: Palette
}) {
  const roundInt = (n: number) => String(Math.round(n))
  const hoursFmt = (n: number) => `${n.toFixed(1)}h`
  const specs: {
    label: string
    me: number | null | undefined
    target: number | null | undefined
    fmt: (n: number) => string
  }[] = [
    {
      label: 'Books finished',
      me: profile.me.booksFinished,
      target: profile.target.booksFinished,
      fmt: roundInt,
    },
    {
      label: 'Hours listened',
      me: profile.me.secondsListened / 3600,
      target: profile.target.secondsListened / 3600,
      fmt: hoursFmt,
    },
    {
      label: 'Books this year',
      me: profile.me.booksThisYear,
      target: profile.target.booksThisYear,
      fmt: roundInt,
    },
    {
      label: 'Active days',
      me: profile.me.activeDays,
      target: profile.target.activeDays,
      fmt: roundInt,
    },
    {
      label: 'Avg / active day',
      me: profile.me.avgPerActiveDaySec != null ? profile.me.avgPerActiveDaySec / 3600 : undefined,
      target:
        profile.target.avgPerActiveDaySec != null
          ? profile.target.avgPerActiveDaySec / 3600
          : undefined,
      fmt: hoursFmt,
    },
  ]
  const rows = specs.filter(
    (s): s is { label: string; me: number; target: number; fmt: (n: number) => string } =>
      typeof s.me === 'number' && typeof s.target === 'number',
  )
  if (!rows.length) return null

  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Icon name={icons.compare} size={18} color={colors.textMuted} />
        <AppText variant="label">Head to head</AppText>
      </View>
      <View style={styles.card}>
        <View style={styles.cmpHead}>
          <AppText variant="meta" color={colors.textMuted}>
            You
          </AppText>
          <AppText variant="meta" color={colors.textMuted} numberOfLines={1}>
            {profile.username || 'That listener'}
          </AppText>
        </View>
        {rows.map((r) => {
          const max = Math.max(r.me, r.target, 0.001)
          return (
            <View key={r.label} style={styles.cmpRow}>
              <AppText variant="caption" color={colors.textMuted} style={styles.cmpLabel}>
                {r.label}
              </AppText>
              <View style={styles.cmpSides}>
                <View style={styles.cmpSide}>
                  <View style={styles.bar}>
                    <View
                      style={[
                        styles.barFill,
                        { width: `${(r.me / max) * 100}%`, backgroundColor: colors.accent },
                      ]}
                    />
                  </View>
                  <AppText variant="meta" style={styles.cmpVal}>
                    {r.fmt(r.me)}
                  </AppText>
                </View>
                <View style={styles.cmpSide}>
                  <View style={styles.bar}>
                    <View
                      style={[
                        styles.barFill,
                        { width: `${(r.target / max) * 100}%`, backgroundColor: colors.textFaint },
                      ]}
                    />
                  </View>
                  <AppText variant="meta" style={styles.cmpVal}>
                    {r.fmt(r.target)}
                  </AppText>
                </View>
              </View>
            </View>
          )
        })}
      </View>
    </View>
  )
}

// Their finished books, with the ones you've both read called out. Defaults to
// A year at a time, newest first, with the year picker only when there is more
// than one to pick from. Every highlight is nullable server-side (a year can
// lack the data to compute it), so each row renders only when it has a value -
// a year with nothing but a count still shows the count rather than a shell of
// empty labels.
function YearInReviewSection({
  profile,
  styles,
  colors,
}: {
  profile: HSProfileResponse
  styles: Styles
  colors: Palette
}) {
  const years = profile.yearsInReview ?? []
  const [pick, setPick] = useState(0)
  const year = years[Math.min(pick, years.length - 1)]

  // Absent on older servers, and empty when the reading list is private - the
  // FinishedSection below already explains that case, so stay quiet here.
  if (!year) return null

  const rows: { label: string; value: string }[] = []
  rows.push({ label: 'Books finished', value: String(year.books) })
  if (year.seconds > 0) rows.push({ label: 'Time listened', value: formatDuration(year.seconds) })
  if (year.longest) {
    rows.push({
      label: 'Longest book',
      value: `${year.longest.title} (${formatDuration(year.longest.durationSec)})`,
    })
  }
  if (year.shortest) {
    rows.push({
      label: 'Shortest book',
      value: `${year.shortest.title} (${formatDuration(year.shortest.durationSec)})`,
    })
  }
  if (year.topAuthor) {
    rows.push({
      label: 'Most read author',
      value: `${year.topAuthor.name} · ${year.topAuthor.count} book${year.topAuthor.count === 1 ? '' : 's'}`,
    })
  }
  if (year.topNarrator) {
    rows.push({
      label: 'Most heard narrator',
      value: `${year.topNarrator.name} · ${year.topNarrator.count} book${year.topNarrator.count === 1 ? '' : 's'}`,
    })
  }
  if (year.topSeriesByTime) {
    rows.push({
      label: 'Most time in a series',
      value: `${year.topSeriesByTime.name} · ${formatDuration(year.topSeriesByTime.seconds)}`,
    })
  }
  if (year.topSeriesByBooks) {
    rows.push({
      label: 'Most books in a series',
      value: `${year.topSeriesByBooks.name} · ${year.topSeriesByBooks.count}`,
    })
  }
  if (year.seriesStarted > 0) {
    rows.push({ label: 'New series started', value: String(year.seriesStarted) })
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Icon name={icons.stats} size={18} color={colors.textMuted} />
        <AppText variant="label">Year in review</AppText>
      </View>

      {years.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.yearRow}>
            {years.map((y, i) => (
              <Pressable
                key={y.year}
                onPress={() => setPick(i)}
                style={[styles.seg, i === pick && styles.segOn]}
              >
                <AppText variant="meta" color={i === pick ? colors.text : colors.textMuted}>
                  {y.year}
                </AppText>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      ) : null}

      <View style={styles.card}>
        {rows.map((r, i) => (
          <View key={r.label} style={[styles.yirRow, i > 0 && styles.yirRowDivided]}>
            <AppText variant="meta" color={colors.textMuted}>
              {r.label}
            </AppText>
            <AppText variant="meta" numberOfLines={2} style={styles.yirValue}>
              {r.value}
            </AppText>
          </View>
        ))}
      </View>
    </View>
  )
}

// the overlap when there is any - the interesting view when you've arrived from
// the leaderboard.
function FinishedSection({
  profile,
  styles,
  colors,
  onOpen,
}: {
  profile: HSProfileResponse
  styles: Styles
  colors: Palette
  onOpen: (itemId: string) => void
}) {
  // On your own profile every finished book is trivially "also mine", so the
  // shared/overlap framing is meaningless there - the filter would read "All 200
  // / You both finished 200" and every tile would claim "Both read".
  const hasShared = !profile.isMe && profile.sharedCount > 0
  const [sharedOnly, setSharedOnly] = useState(hasShared)
  const books = useMemo(
    () => (sharedOnly ? profile.finished.filter((b) => b.alsoMine) : profile.finished),
    [profile.finished, sharedOnly],
  )

  // A heavy listener's list runs to the server's 500-book cap, and mounting
  // every tile at once locks the device up. The list is already newest-first,
  // so walk backwards through the calendar a page at a time.
  const [shownCount, setShownCount] = useState(FINISHED_PAGE)
  useEffect(() => {
    setShownCount(FINISHED_PAGE)
  }, [sharedOnly])
  const visible = useMemo(() => books.slice(0, shownCount), [books, shownCount])
  const remaining = books.length - visible.length
  // Grouped by the year they were finished in, so scrolling back reads as
  // moving back through the calendar rather than one undifferentiated wall.
  const years = useMemo(() => groupByYear(visible), [visible])

  if (!profile.readShared) {
    return (
      <View style={styles.section}>
        <View style={styles.sectionHead}>
          <Icon name={icons.book} size={18} color={colors.textMuted} />
          <AppText variant="label">Finished books</AppText>
        </View>
        <EmptyState
          icon={icons.lock}
          title="Reading list is private"
          body={
            profile.isMe
              ? 'You haven\'t turned on "Share my reading list", so your finished books stay hidden from others.'
              : `${profile.username || 'This listener'} hasn't turned on "Share my reading list", so their finished books stay hidden.`
          }
          style={styles.blockEmpty}
        />
      </View>
    )
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Icon name={icons.book} size={18} color={colors.textMuted} />
        <AppText variant="label">Finished books</AppText>
      </View>

      {profile.isMe ? null : (
        <View style={styles.segRow}>
          <Pressable
            onPress={() => setSharedOnly(false)}
            style={[styles.seg, !sharedOnly && styles.segOn]}
          >
            <AppText variant="meta" color={!sharedOnly ? colors.text : colors.textMuted}>
              All {profile.finished.length}
            </AppText>
          </Pressable>
          <Pressable
            onPress={() => hasShared && setSharedOnly(true)}
            style={[styles.seg, sharedOnly && styles.segOn, !hasShared && styles.segDisabled]}
          >
            <AppText variant="meta" color={sharedOnly ? colors.text : colors.textMuted}>
              You both finished {profile.sharedCount}
            </AppText>
          </Pressable>
        </View>
      )}

      {books.length === 0 ? (
        <EmptyState
          icon={icons.book}
          title={sharedOnly ? 'No books in common yet' : 'Nothing finished yet'}
          body={
            sharedOnly
              ? "You haven't finished any of the same books."
              : profile.isMe
                ? "You haven't finished a book yet."
                : `${profile.username || 'This listener'} hasn't finished a book yet.`
          }
          style={styles.blockEmpty}
        />
      ) : (
        <>
          {years.map((group) => (
            <View key={group.year} style={styles.yearBlock}>
              <View style={styles.yearHead}>
                <AppText variant="label" color={colors.textMuted}>
                  {group.year}
                </AppText>
                <AppText variant="meta" color={colors.textFaint}>
                  {group.books.length} book{group.books.length === 1 ? '' : 's'}
                </AppText>
              </View>
              <View style={styles.grid}>
                {group.books.map((b: HSProfileBook) => (
                  <Pressable
                    key={b.libraryItemId}
                    style={styles.tile}
                    onPress={() => onOpen(b.libraryItemId)}
                  >
                    <Cover
                      uri={coverUrl(b.libraryItemId)}
                      itemId={b.libraryItemId}
                      width={TILE_W}
                      radius={radius.tile}
                      fallback={{
                        hue: coverHue(b.libraryItemId),
                        initial: (b.title || '?').charAt(0).toUpperCase(),
                      }}
                    />
                    <AppText variant="meta" numberOfLines={2} style={styles.tileTitle}>
                      {b.title || 'Untitled'}
                    </AppText>
                    {b.alsoMine && !profile.isMe ? (
                      <AppText variant="meta" color={colors.accent}>
                        Both read
                      </AppText>
                    ) : null}
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
          {remaining > 0 ? (
            <Pressable
              style={styles.moreBtn}
              onPress={() => setShownCount((n) => n + FINISHED_PAGE)}
            >
              <AppText variant="meta" color={colors.accent}>
                Show {Math.min(remaining, FINISHED_PAGE)} more
                {remaining > FINISHED_PAGE ? ` of ${remaining}` : ''}
              </AppText>
            </Pressable>
          ) : null}
        </>
      )}
    </View>
  )
}

const TILE_W = 104

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      gap: spacing.sm,
    },
    headerTitle: { flex: 1, minWidth: 0 },
    content: { paddingHorizontal: spacing.md, gap: spacing.lg },

    identity: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    identityMeta: { flex: 1, minWidth: 0, gap: 2 },

    card: {
      backgroundColor: colors.card,
      borderRadius: radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      padding: spacing.md,
      gap: spacing.md,
    },

    // The hero is the one card on this screen that should catch the eye, so it
    // gets the accent edge and cover-hue wash the Following hero uses. Plain
    // `card` left it identical to the stats card sitting right below it.
    heroCard: {
      position: 'relative',
      overflow: 'hidden',
      backgroundColor: colors.card,
      borderRadius: radius.card + 6,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha(colors.accent, 0.28),
      padding: spacing.md,
      gap: spacing.md,
      marginBottom: spacing.xs,
    },
    heroRow: { flexDirection: 'row', gap: spacing.md },
    heroMeta: { flex: 1, minWidth: 0, gap: 3 },
    eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
    heroTitle: { marginTop: 1 },
    heroProg: { gap: 6 },
    heroProgMeta: { flexDirection: 'row', justifyContent: 'space-between' },
    heroAgo: { marginTop: -4 },

    bar: {
      flex: 1,
      height: 8,
      borderRadius: 999,
      backgroundColor: colors.fill,
      overflow: 'hidden',
      minWidth: 0,
    },
    barFill: { height: '100%', borderRadius: 999 },

    section: { gap: spacing.md },
    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    blockEmpty: { paddingVertical: spacing.lg },

    cmpHead: { flexDirection: 'row', justifyContent: 'space-between' },
    cmpRow: { gap: 6 },
    cmpLabel: {},
    cmpSides: { flexDirection: 'row', gap: spacing.sm },
    cmpSide: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
    cmpVal: { minWidth: 42, textAlign: 'right' },

    segRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
    // Year picker: no wrap, since it scrolls horizontally instead.
    yearRow: { flexDirection: 'row', gap: spacing.sm },
    yirRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
      gap: spacing.md,
      paddingVertical: spacing.sm,
    },
    yirRowDivided: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.hairline,
    },
    yirValue: { flex: 1, textAlign: 'right' },
    seg: {
      paddingHorizontal: spacing.md,
      paddingVertical: 7,
      borderRadius: 999,
      backgroundColor: colors.fill,
    },
    segOn: { backgroundColor: colors.fillStrong },
    segDisabled: { opacity: 0.45 },

    yearBlock: { gap: spacing.sm },
    yearHead: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
    },
    moreBtn: {
      alignItems: 'center',
      paddingVertical: spacing.sm,
      borderRadius: radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
    tile: { width: TILE_W, gap: 3 },
    tileTitle: { marginTop: 4 },
  })
}
