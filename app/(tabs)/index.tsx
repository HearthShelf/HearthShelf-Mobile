import { useAuth } from '@clerk/expo'
import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, Pressable, ScrollView, StyleSheet, View } from 'react-native'
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
import { clearTrack } from '@/player/store'
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
  icons,
} from '@/ui/primitives'
import { CoverGlow } from '@/ui/CoverGlow'
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
      <View style={styles.topBar}>
        <AppText variant="hero">{status.serverName}</AppText>
        <IconButton name={icons.search} onPress={() => router.push('/search')} />
      </View>
      <ScrollView
        contentContainerStyle={{ paddingBottom: 140 }}
        showsVerticalScrollIndicator={false}
      >
        {hero ? (
          <ContinueHero
            item={hero}
            progress={heroProgress}
            onResume={async () => {
              try {
                await playItemById(hero.id)
                router.push('/player')
              } catch {
                router.push(`/item/${hero.id}`)
              }
            }}
          />
        ) : null}
        {stats ? <HomeStatsStrip stats={stats} /> : null}
        {shelves.map((shelf) => (
          <Shelf key={shelf.id} shelf={shelf} />
        ))}
      </ScrollView>
    </Screen>
  )
}

/**
 * Continue-listening spotlight hero: cover with a color glow, title/author, a
 * progress bar with a percent readout, and a Resume CTA (mirrors the web home's
 * ResumeHero). progress is 0..1.
 */
function ContinueHero({
  item,
  progress,
  onResume,
}: {
  item: ABSLibraryItem
  progress: number
  onResume: () => void
}) {
  const router = useRouter()
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100)
  const started = progress > 0
  return (
    <View style={styles.hero}>
      <CoverGlow hue={coverHue(item.id)} height={200} style={styles.heroGlow} />
      <View style={styles.heroTop}>
        <Pressable onPress={() => router.push(`/item/${item.id}`)}>
          <Cover
            uri={coverUrl(item.id)}
            width={92}
            aspectRatio={2 / 3}
            radius={radius.tile}
            fallback={{ hue: coverHue(item.id), initial: itemTitle(item).charAt(0).toUpperCase() }}
          />
        </Pressable>
        <View style={styles.heroMeta}>
          <AppText variant="eyebrow" color={colors.accent}>
            {started ? 'Continue' : 'Up next'}
          </AppText>
          <AppText variant="title" numberOfLines={2}>
            {itemTitle(item)}
          </AppText>
          <AppText variant="meta" color={colors.textMuted} numberOfLines={1}>
            {itemAuthor(item)}
          </AppText>
        </View>
      </View>

      {started && (
        <View style={styles.heroProgress}>
          <ProgressBar progress={progress} style={{ flex: 1 }} />
          <AppText variant="mono" color={colors.textMuted}>
            {pct}%
          </AppText>
        </View>
      )}

      <PrimaryButton
        label={started ? 'Resume' : 'Start listening'}
        icon={icons.play}
        onPress={onResume}
        style={{ marginTop: spacing.md }}
      />
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
    <Pressable onPress={() => router.push('/(tabs)/stats')} style={styles.statsStrip}>
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
    </Pressable>
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
  if (shelf.type !== 'book') return null
  const href = shelfToLibraryHref(shelf)
  return (
    <View style={{ marginTop: spacing.lg }}>
      <SectionHeader
        title={shelf.label}
        action={
          <Pressable
            onPress={() => router.push(href)}
            hitSlop={8}
            style={styles.seeAll}
          >
            <AppText variant="caption" color={colors.textMuted}>
              See all
            </AppText>
            <Icon name={icons.chevronRight} size={16} color={colors.textMuted} />
          </Pressable>
        }
      />
      <FlatList
        data={shelf.entities}
        keyExtractor={(it) => it.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.md }}
        renderItem={({ item }) => (
          <Pressable style={styles.tile} onPress={() => router.push(`/item/${item.id}`)}>
            <Cover uri={coverUrl(item.id)} width={120} aspectRatio={2 / 3} />
            <AppText variant="meta" numberOfLines={1} style={{ marginTop: spacing.xs }}>
              {itemTitle(item)}
            </AppText>
            <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
              {itemAuthor(item)}
            </AppText>
          </Pressable>
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
  hero: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    padding: spacing.lg,
    backgroundColor: colors.high,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    overflow: 'hidden',
  },
  heroGlow: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  heroTop: { flexDirection: 'row', gap: spacing.md },
  heroMeta: { flex: 1, gap: 3, justifyContent: 'center' },
  heroProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.md,
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
