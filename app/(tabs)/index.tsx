import { useAuth, useUser } from '@clerk/expo'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { FlatList, ImageBackground, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useRouter } from 'expo-router'
import type { ABSLibraryItem, ABSShelf, HSListeningStats } from '@hearthshelf/core'
import { coverHue, formatDuration } from '@hearthshelf/core'
import {
  fetchLinkedServers,
  setSessionExpiredHandler,
  type LinkedServer,
} from '@/api/controlPlane'
import { CLERK_JWT_TEMPLATE } from '@/lib/config'
import { connectServer } from '@/api/connect'
import { setSession, clearSession, setLastServerId, getLastServerId } from '@/api/session'
import { clearTrack, getState, subscribe } from '@/player/store'
import { getSettingsState, subscribeSettings, COVER_ASPECT_RATIO } from '@/store/settings'
import { setAutoSession, clearAutoSession } from '@/player/autoBridge'
import { startQueueSync, stopQueueSync } from '@/player/queueSync'
import {
  coverUrl,
  getHSStats,
  getItemsInProgress,
  getLibraries,
  getLibraryItems,
  getMe,
  getPersonalized,
  itemAuthor,
  itemTitle,
} from '@/api/abs'
import { playItemById } from '@/player/playback'
import {
  AppText,
  Centered,
  Cover,
  IconButton,
  Loading,
  PrimaryButton,
  ProgressBar,
  Row,
  Screen,
  SectionHeader,
  Touchable,
  icons,
} from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { colors, radius, spacing } from '@/ui/theme'

type Status =
  | { phase: 'connecting' }
  | { phase: 'error'; message: string }
  | { phase: 'no-servers' }
  | { phase: 'select-server'; servers: LinkedServer[] }
  | { phase: 'ready'; serverName: string }

class NoLinkedServersError extends Error {
  constructor() {
    super('No linked servers on this account')
    this.name = 'NoLinkedServersError'
  }
}

export default function HomeScreen() {
  const { getToken, signOut } = useAuth()
  const { user } = useUser()
  const firstName = user?.firstName ?? null
  const { nowPlaying } = useSyncExternalStore(subscribe, getState)
  const router = useRouter()
  const [status, setStatus] = useState<Status>({ phase: 'connecting' })
  const [inProgress, setInProgress] = useState<ABSLibraryItem[]>([])
  const [heroProgress, setHeroProgress] = useState(0)
  const [shelves, setShelves] = useState<ABSShelf[]>([])
  const [stats, setStats] = useState<HSListeningStats | null>(null)

  async function handleSignOut(reason?: 'expired') {
    clearTrack()
    clearAutoSession()
    stopQueueSync()
    await clearSession()
    await signOut()
    router.replace(reason ? `/sign-in?reason=${reason}` : '/sign-in')
  }

  const getTokenRef = useRef(getToken)
  getTokenRef.current = getToken

  const tokenFn = useCallback(async () => {
    try {
      return await getTokenRef.current({ template: CLERK_JWT_TEMPLATE })
    } catch {
      return null
    }
  }, [])

  const connectTo = useCallback(
    async (server: LinkedServer) => {
      setStatus({ phase: 'connecting' })
      try {
        const { serverUrl, token: absToken } = await connectServer(tokenFn, server.id, server.url)
        await setSession({ serverUrl, token: absToken })
        await setLastServerId(server.id)
        setAutoSession(serverUrl, absToken)
        startQueueSync()

        const progress = await getItemsInProgress()
        setInProgress(progress)

        // The hero's progress bar needs per-item state, which items-in-progress
        // doesn't carry - read it from the caller's progress map (best-effort).
        const hero = progress[0]
        if (hero) {
          getMe()
            .then((me) => {
              const p = me.mediaProgress.find((mp) => mp.libraryItemId === hero.id)
              setHeroProgress(p?.progress ?? 0)
            })
            .catch(() => setHeroProgress(0))
        }

        // Stats strip is best-effort - a stats failure shouldn't block the rest
        // of Home from loading. Same getHSStats() the Stats tab reads, so the
        // two never disagree.
        getHSStats()
          .then(setStats)
          .catch(() => setStats(null))

        // Personalized shelves from the first book library (matches the web home).
        const libs = await getLibraries()
        const firstBookLib = libs.find((l) => l.mediaType === 'book') ?? libs[0]
        if (firstBookLib) {
          try {
            const personalized = await getPersonalized(firstBookLib.id)
            setShelves(personalized.filter((s) => s.type === 'book' && s.entities.length > 0))
          } catch {
            // Personalized is best-effort; fall back to first-page items as one shelf.
            const items = await getLibraryItems(firstBookLib.id, 0, 20)
            setShelves(
              items.length
                ? [{ id: 'all', label: firstBookLib.name, type: 'book', entities: items }]
                : []
            )
          }
        }
        setStatus({ phase: 'ready', serverName: server.name })
      } catch (e) {
        setStatus({ phase: 'error', message: (e as Error).message })
      }
    },
    [tokenFn]
  )

  const connect = useCallback(async () => {
    setStatus({ phase: 'connecting' })
    try {
      const servers = await fetchLinkedServers(tokenFn)
      if (servers.length === 0) throw new NoLinkedServersError()
      if (servers.length === 1) {
        await connectTo(servers[0])
        return
      }
      const lastId = await getLastServerId()
      const remembered = lastId ? servers.find((s) => s.id === lastId) : undefined
      if (remembered) await connectTo(remembered)
      else setStatus({ phase: 'select-server', servers })
    } catch (e) {
      if (e instanceof NoLinkedServersError) setStatus({ phase: 'no-servers' })
      else setStatus({ phase: 'error', message: (e as Error).message })
    }
  }, [connectTo, tokenFn])

  useEffect(() => {
    connect()
  }, [connect])

  useEffect(() => {
    setSessionExpiredHandler(() => {
      void handleSignOut('expired')
    })
    return () => setSessionExpiredHandler(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (status.phase === 'connecting') {
    return (
      <Screen>
        <Loading label="Connecting to your server..." />
      </Screen>
    )
  }

  if (status.phase === 'no-servers') {
    return (
      <Screen>
        <Centered>
          <AppText variant="hero">No server linked</AppText>
          <AppText variant="meta" color={colors.textMuted} style={{ textAlign: 'center' }}>
            Link an AudiobookShelf server at app.hearthshelf.com, then come back and retry.
          </AppText>
          <PrimaryButton label="Retry" icon={icons.retry} onPress={connect} />
          <Pressable onPress={() => handleSignOut()}>
            <AppText variant="meta" color={colors.textMuted}>
              Sign out
            </AppText>
          </Pressable>
        </Centered>
      </Screen>
    )
  }

  if (status.phase === 'select-server') {
    return (
      <Screen>
        <SectionHeader title="Choose a server" />
        <FlatList
          data={status.servers}
          keyExtractor={(s) => s.id}
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
          renderItem={({ item }) => (
            <Row onPress={() => connectTo(item)}>
              <View style={{ flex: 1 }}>
                <AppText variant="label">{item.name}</AppText>
                <AppText variant="meta" color={colors.textMuted} numberOfLines={1}>
                  {item.url}
                </AppText>
              </View>
              <IconButton name={icons.chevronRight} color={colors.textMuted} />
            </Row>
          )}
        />
      </Screen>
    )
  }

  if (status.phase === 'error') {
    return (
      <Screen>
        <Centered>
          <AppText variant="meta" color={colors.destructive} style={{ textAlign: 'center' }}>
            {status.message}
          </AppText>
          <PrimaryButton label="Retry" icon={icons.retry} onPress={connect} />
          <Pressable onPress={() => handleSignOut()}>
            <AppText variant="meta" color={colors.textMuted}>
              Sign out
            </AppText>
          </Pressable>
        </Centered>
      </Screen>
    )
  }

  const hero = inProgress[0]

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 140 }}
        showsVerticalScrollIndicator={false}
      >
        {hero ? (
          <ContinueHero
            item={hero}
            progress={heroProgress}
            greeting={<Greeting firstName={firstName} nowPlayingTitle={nowPlaying?.title} />}
            onResume={async () => {
              try {
                await playItemById(hero.id)
                router.push('/player')
              } catch {
                router.push(`/item/${hero.id}`)
              }
            }}
          />
        ) : (
          <View style={styles.topBar}>
            <Greeting firstName={firstName} nowPlayingTitle={nowPlaying?.title} />
          </View>
        )}
        {stats ? <HomeStatsStrip stats={stats} /> : null}
        {shelves.map((shelf) => (
          <Shelf key={shelf.id} shelf={shelf} />
        ))}
      </ScrollView>
    </Screen>
  )
}

/** Two-line personalized greeting: "Hello <name>" + a time-of-day subtext that
 *  nods to what's playing when there is something. Deterministic per render (no
 *  Math.random in the hot path - a small rotation keyed off the hour). */
function Greeting({ firstName, nowPlayingTitle }: { firstName: string | null; nowPlayingTitle?: string }) {
  const h = new Date().getHours()
  const partOfDay = h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night'
  const hello = firstName ? `Hello ${firstName}` : 'Hello'
  const subs =
    partOfDay === 'morning'
      ? ['Good morning', 'A fresh chapter awaits', 'Coffee and a good book?']
      : partOfDay === 'afternoon'
        ? ['Good afternoon', 'Pick up where you left off', 'A little listening break?']
        : partOfDay === 'evening'
          ? ['Good evening', 'Wind down with a chapter', 'Settle in by the hearth']
          : ['Burning the midnight oil', 'A late-night listen', 'The hearth is still warm']
  const sub = nowPlayingTitle ? `Still on ${nowPlayingTitle}` : subs[h % subs.length]
  return (
    <View>
      <AppText variant="hero">{hello}</AppText>
      <AppText variant="meta" color={colors.textMuted} numberOfLines={1}>
        {sub}
      </AppText>
    </View>
  )
}

/**
 * Continue-listening spotlight hero: the book's artwork blown up as the
 * background, fading down to the scaffold just below the Resume button and
 * running up off the top of the screen (behind the greeting). Borderless.
 */
function ContinueHero({
  item,
  progress,
  greeting,
  onResume,
}: {
  item: ABSLibraryItem
  progress: number
  greeting: React.ReactNode
  onResume: () => void
}) {
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100)
  const started = progress > 0
  const heroArt = coverUrl(item.id)
  return (
    <View style={styles.hero}>
      {/* Blown-up artwork background; the gradient fades it down to the scaffold
          and up off the top so it reads as a borderless spotlight, not a card.
          Skip the source when there's no art (mid server-switch) - an empty uri
          warns and shows nothing anyway; the gradient carries the look. */}
      <ImageBackground
        source={heroArt ? { uri: heroArt } : undefined}
        style={styles.heroBg}
        imageStyle={styles.heroBgImg}
      >
        <LinearGradient
          colors={['rgba(27,26,24,0.35)', 'rgba(27,26,24,0.55)', colors.scaffold]}
          locations={[0, 0.55, 1]}
          style={StyleSheet.absoluteFill}
        />
      </ImageBackground>

      {/* DS "spotlight 2c": greeting, a gap so the art breathes, then a text-only
          meta block over the art (no duplicate cover thumbnail), progress, and a
          compact Resume pill - matching HearthShelf Android - Material.dc.html. */}
      <View style={styles.heroContent}>
        <View style={styles.heroGreeting}>{greeting}</View>
        <View style={styles.heroGap} />
        <View style={styles.heroMeta}>
          <AppText variant="eyebrow" color={colors.accent}>
            {started ? 'Continue' : 'Up next'}
          </AppText>
          <AppText variant="title" numberOfLines={2} style={{ marginTop: 6 }}>
            {itemTitle(item)}
          </AppText>
          <AppText variant="meta" color={colors.textMuted} numberOfLines={1} style={{ marginTop: 4 }}>
            {itemAuthor(item)}
          </AppText>

          {started && (
            <View style={styles.heroProgress}>
              <ProgressBar progress={progress} style={{ flex: 1 }} />
              <AppText variant="mono" color={colors.textMuted}>
                {pct}%
              </AppText>
            </View>
          )}
        </View>

        <Touchable onPress={onResume} style={styles.heroResume}>
          <Icon name={icons.play} size={20} color={colors.onAccent} />
          <AppText variant="label" color={colors.onAccent}>
            {started ? 'Resume' : 'Start listening'}
          </AppText>
        </Touchable>
      </View>
    </View>
  )
}

/**
 * Day streak + this-week cards, matching the prototype's home stats strip.
 * Reads the same getHSStats() data as the Stats tab, so the two never disagree.
 */
function HomeStatsStrip({ stats }: { stats: HSListeningStats }) {
  const router = useRouter()
  return (
    <Touchable onPress={() => router.push('/(tabs)/stats')} style={styles.statsStrip}>
      <View style={styles.statsTile}>
        <Icon name={icons.flame} size={21} color={colors.brandHearth} />
        <View>
          <AppText variant="mono" style={{ fontWeight: '700' }}>
            {stats.dayStreak}
          </AppText>
          <AppText variant="caption" color={colors.textMuted}>
            Day streak
          </AppText>
        </View>
      </View>
      <View style={styles.statsTile}>
        <Icon name={icons.schedule} size={21} color={colors.textMuted} />
        <View>
          <AppText variant="mono" style={{ fontWeight: '700' }}>
            {formatDuration(stats.weekSec)}
          </AppText>
          <AppText variant="caption" color={colors.textMuted}>
            This week
          </AppText>
        </View>
      </View>
    </Touchable>
  )
}

/**
 * Map a personalized shelf to a Library deep-link. "Recently added" just means
 * the Library sorted by date added; anything else falls back to a genre filter on
 * the shelf label so the "See all" tap always lands somewhere useful.
 */
function shelfToLibraryHref(shelf: ABSShelf): string {
  const label = shelf.label.toLowerCase()
  if (label.includes('recent') || label.includes('added') || label.includes('newest')) {
    return '/(tabs)/library?sort=Date%20Added&desc=1'
  }
  if (label.includes('continue') || label.includes('listen again')) {
    return '/(tabs)/library?filter=progress|In%20Progress'
  }
  // Discover / genre-ish shelves: filter by the shelf's own name as a genre.
  return `/(tabs)/library?filter=genres|${encodeURIComponent(shelf.label)}`
}

function Shelf({ shelf }: { shelf: ABSShelf }) {
  const router = useRouter()
  const { coverAspect } = useSyncExternalStore(subscribeSettings, getSettingsState)
  if (shelf.type !== 'book') return null
  const href = shelfToLibraryHref(shelf)
  return (
    <View style={{ marginTop: spacing.lg }}>
      <SectionHeader
        title={shelf.label}
        action={
          <Touchable
            onPress={() => router.push(href)}
            hitSlop={8}
            style={styles.seeAll}
          >
            <AppText variant="caption" color={colors.textMuted}>
              See all
            </AppText>
            <Icon name={icons.chevronRight} size={16} color={colors.textMuted} />
          </Touchable>
        }
      />
      <FlatList
        data={shelf.entities}
        keyExtractor={(it) => it.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.md }}
        renderItem={({ item }) => (
          <Touchable style={styles.tile} onPress={() => router.push(`/item/${item.id}`)}>
            <Cover uri={coverUrl(item.id)} width={120} aspectRatio={COVER_ASPECT_RATIO[coverAspect]} />
            <AppText variant="meta" numberOfLines={1} style={{ marginTop: spacing.xs }}>
              {itemTitle(item)}
            </AppText>
            <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
              {itemAuthor(item)}
            </AppText>
          </Touchable>
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  // Borderless spotlight: the artwork background bleeds up past the top of the
  // screen (negative top margin under the safe area) and fades to scaffold below.
  hero: {
    marginTop: -60,
    paddingTop: 60,
    position: 'relative',
  },
  heroBg: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 340,
  },
  heroBgImg: { resizeMode: 'cover' },
  heroContent: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    // Gap below the Resume pill so the art's fade-out is visible before the
    // stats, matching the DS (not overly busy).
    paddingBottom: spacing.lg,
  },
  heroGreeting: {},
  // DS: 44px of breathing room between the greeting and the title block so the
  // spotlight art reads before the text starts.
  heroGap: { height: 44 },
  heroMeta: {},
  heroProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: 14,
  },
  // Compact auto-width Resume pill (DS: padding 13/26, radius 16), NOT full-width.
  heroResume: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
    marginTop: spacing.lg,
    paddingVertical: 13,
    paddingHorizontal: 26,
    borderRadius: 16,
    backgroundColor: colors.accent,
  },
  seeAll: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  tile: { width: 120 },
  statsStrip: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  statsTile: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm + 5,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
})
