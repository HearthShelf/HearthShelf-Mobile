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
import {
  Screen,
  Centered,
  AppText,
  Avatar,
  Cover,
  IconButton,
  Loading,
} from '@/ui/primitives'
import { EmptyState, ErrorState } from '@/ui/states'
import { Icon, icons } from '@/ui/icons'
import { AppTabBar, tabFromParam, useGoToTab } from '@/ui/AppTabBar'
import { useMiniPlayerInset } from '@/ui/useContentInset'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
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
      <IconButton name={icons.back} onPress={() => router.back()} />
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
            username={profile.username || 'They'}
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
            body={`${profile.username || 'This listener'} hasn't turned on "Share when I'm listening".`}
            style={styles.blockEmpty}
          />
        )}

        {!profile.isMe && <CompareSection profile={profile} styles={styles} colors={colors} />}

        <FinishedSection
          profile={profile}
          styles={styles}
          colors={colors}
          onOpen={openBook}
        />
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
  const pct = Math.round(Math.min(Math.max(listen.progress || 0, 0), 1) * 100)
  const remaining = Math.max(listen.durationSec - listen.currentTimeSec, 0)
  const label = listen.isLive
    ? 'Listening now'
    : listen.isFinished
      ? 'Last finished'
      : 'Last listened to'

  return (
    <Pressable style={styles.card} onPress={() => onOpen(listen.libraryItemId)}>
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
  const hasShared = profile.sharedCount > 0
  const [sharedOnly, setSharedOnly] = useState(hasShared)
  const books = useMemo(
    () => (sharedOnly ? profile.finished.filter((b) => b.alsoMine) : profile.finished),
    [profile.finished, sharedOnly],
  )

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
          body={`${profile.username || 'This listener'} hasn't turned on "Share my reading list", so their finished books stay hidden.`}
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

      {books.length === 0 ? (
        <EmptyState
          icon={icons.book}
          title={sharedOnly ? 'No books in common yet' : 'Nothing finished yet'}
          body={
            sharedOnly
              ? "You haven't finished any of the same books."
              : `${profile.username || 'This listener'} hasn't finished a book yet.`
          }
          style={styles.blockEmpty}
        />
      ) : (
        <View style={styles.grid}>
          {books.map((b: HSProfileBook) => (
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
              <AppText variant="meta" color={b.alsoMine ? colors.accent : colors.textMuted}>
                {b.alsoMine ? 'Both read' : yearOf(b.finishedAt)}
              </AppText>
            </Pressable>
          ))}
        </View>
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

    section: { gap: spacing.sm },
    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    blockEmpty: { paddingVertical: spacing.lg },

    cmpHead: { flexDirection: 'row', justifyContent: 'space-between' },
    cmpRow: { gap: 6 },
    cmpLabel: {},
    cmpSides: { flexDirection: 'row', gap: spacing.sm },
    cmpSide: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 0 },
    cmpVal: { minWidth: 42, textAlign: 'right' },

    segRow: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
    seg: {
      paddingHorizontal: spacing.md,
      paddingVertical: 7,
      borderRadius: 999,
      backgroundColor: colors.fill,
    },
    segOn: { backgroundColor: colors.fillStrong },
    segDisabled: { opacity: 0.45 },

    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
    tile: { width: TILE_W, gap: 3 },
    tileTitle: { marginTop: 4 },
  })
}
