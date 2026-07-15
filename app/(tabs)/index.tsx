import { useAuth, useUser } from '@clerk/expo'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  BackHandler,
  FlatList,
  ImageBackground,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native'
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import { useRouter } from 'expo-router'
import type { ABSLibraryItem, ABSShelf, ABSSeries, HSListeningStats } from '@hearthshelf/core'
import {
  coverHue,
  formatDuration,
  buildDiscoverShelves,
  rankDiscoverShelves,
  continueSeriesShelf,
} from '@hearthshelf/core'
import { setSessionExpiredHandler } from '@/api/controlPlane'
import { clearSession } from '@/api/session'
import { clearAudibleCache } from '@/api/absAudible'
import { clearSubscriptions } from '@/player/subscriptions'
import { resetPushRegistration } from '@/player/pushRegister'
import { useConnection } from '@/api/ConnectionProvider'
import {
  clearTrack,
  getState,
  subscribe,
  togglePlay,
  jumpBy,
  requestSeek,
  currentChapter,
} from '@/player/store'
import { getSettingsState, subscribeSettings, COVER_ASPECT_RATIO } from '@/store/settings'
import { clearAutoSession, setAutoDiscover } from '@/player/autoBridge'
import { stopQueueSync } from '@/player/queueSync'
import {
  coverUrl,
  getAllLibraryItems,
  getHSStats,
  getItemsInProgress,
  getLibraries,
  getLibrarySeries,
  getPersonalized,
  itemAuthor,
  itemTitle,
} from '@/api/abs'
import { getProgressState, subscribeProgress, refreshProgress } from '@/store/progress'
import { playItemById } from '@/player/playback'
import {
  setAutoDownloadContinueListening,
  getDownloadsState,
  subscribeDownloads,
} from '@/player/downloads'
import { catalogHomeShelves } from '@/player/offlineCatalog'
import {
  AppText,
  Cover,
  Loading,
  Screen,
  SectionHeader,
  Sheet,
  type SheetRef,
  Touchable,
  icons,
} from '@/ui/primitives'
import { BottomSheetFlatList } from '@gorhom/bottom-sheet'
import { Icon, type IconName } from '@/ui/icons'
import { DUR } from '@/ui/motion'
import { onTabReselect } from '@/ui/tabReselect'
import { SkipButton } from '@/player/SkipButton'
import {
  BookActionsSheet,
  type BookActionsHandle,
  type BookActionsSource,
} from '@/ui/BookActionsSheet'
import { BookTile } from '@/ui/BookTile'
import { getServerQueue } from '@/api/queue'
import {
  setQueueItems,
  setQueueManual,
  getQueueState,
  subscribeQueue,
  QUEUE_MODES,
} from '@/player/queue'
import { QueueSheet } from '@/player/QueueSheet'
import type { SheetHandle } from '@/player/sheets'
import {
  hydrateDismissals,
  subscribeDismissals,
  getDismissalsState,
  isItemDismissed,
  isSeriesDismissed,
} from '@/store/dismissals'
import { HomeClubShelf } from '@/social/HomeClubShelf'
import { ReleaseCountdownBanner } from '@/ui/ReleaseCountdownBanner'
import { Toast, useToast } from '@/ui/Toast'
import { useBackHandler, useSheetBackHandler } from '@/ui/useBackHandler'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useContentInset } from '@/ui/useContentInset'
import { useColors, useTheme } from '@/ui/ThemeProvider'
import {
  adaptiveContentMaxWidth,
  adaptiveGridColumns,
  adaptiveGridTileWidth,
  adaptiveShelfTileWidth,
} from '@/ui/responsive'

// A Home shelf: ABS's shape plus optional dismiss context. `source` picks the
// long-press actions; `seriesByItemId` maps a Continue-Series tile (rendered as
// its next book) to the series it stands for, so "Hide this series" dismisses
// the right series id. `icon` is the shelf's declared leading icon - no
// label-string guessing.
type HomeShelf = ABSShelf & {
  source?: BookActionsSource
  seriesByItemId?: Record<string, { id: string; name: string }>
  icon?: IconName
}

export default function HomeScreen() {
  const styles = useStyles()
  const colors = useColors()
  const { signOut } = useAuth()
  const { user } = useUser()
  const firstName = user?.firstName ?? null
  const { nowPlaying, isPlaying, position } = useSyncExternalStore(subscribe, getState)
  const router = useRouter()
  // The root gate overlays the splash until connected, but the tabs (this screen
  // included) mount underneath from app start - so Home must wait for the
  // connection to be `ready` before loading, or getItemsInProgress() throws
  // not_connected. `loading` then covers just the first content fetch.
  const { status, serverName } = useConnection()
  const connected = status.phase === 'ready'
  const contentInset = useContentInset()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [inProgress, setInProgress] = useState<ABSLibraryItem[]>([])
  const [shelves, setShelves] = useState<HomeShelf[]>([])
  const [stats, setStats] = useState<HSListeningStats | null>(null)
  const [libraryName, setLibraryName] = useState<string | null>(null)
  // Shared per-item progress; mark-finished anywhere updates tiles here live.
  const progressById = useSyncExternalStore(subscribeProgress, getProgressState).byId
  const { message: toast, show: showToast } = useToast()
  const actionsRef = useRef<BookActionsHandle>(null)
  const queueSheetRef = useRef<SheetHandle>(null)
  const scrollRef = useRef<ScrollView>(null)
  // Re-tapping the Home tab while already on it scrolls back to the top.
  useEffect(
    () => onTabReselect('index', () => scrollRef.current?.scrollTo({ y: 0, animated: true })),
    [],
  )
  const lastPlaybackItemRef = useRef<string | null>(null)
  const lastPlaybackPlayingRef = useRef<boolean | null>(null)
  const playbackRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Books just marked finished here. A silent reload's items-in-progress can lag
  // ABS's own propagation and re-surface them in Continue, so filter them out
  // until a later fetch legitimately drops them. Held in a ref so loadHome's
  // identity stays stable.
  const justFinishedRef = useRef<Set<string>>(new Set())

  // Home is the back-stack root: the first hardware back arms a 2s window and
  // shows a hint; a second back within it exits the app. Prevents an accidental
  // single press from dropping the user out.
  const exitArmedRef = useRef(false)
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useBackHandler(
    useCallback(() => {
      if (exitArmedRef.current) {
        if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
        BackHandler.exitApp()
        return true
      }
      exitArmedRef.current = true
      showToast('Press back again to exit')
      exitTimerRef.current = setTimeout(() => {
        exitArmedRef.current = false
      }, 2000)
      return true
    }, [showToast]),
  )
  // Close any open sheet before the exit-arm logic above (registered after it so
  // it fires first; swallows the press only when a sheet was open).
  useSheetBackHandler()
  useEffect(
    () => () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
    },
    [],
  )

  const handleSignOut = useCallback(
    async (reason?: 'expired') => {
      clearTrack()
      clearAutoSession()
      stopQueueSync()
      clearAudibleCache()
      clearSubscriptions()
      resetPushRegistration()
      await clearSession()
      await signOut()
      router.replace(reason ? `/sign-in?reason=${reason}` : '/sign-in')
    },
    [signOut, router],
  )

  const loadHome = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true)
    const progress = await getItemsInProgress()
    // Drop books we just finished locally if the server hasn't caught up yet; once
    // items-in-progress stops returning them, they're gone from this set too.
    const stillPresent = new Set(progress.map((it) => it.id))
    for (const id of justFinishedRef.current)
      if (!stillPresent.has(id)) justFinishedRef.current.delete(id)
    // Drop books that are finished (100%) - ABS keeps returning a naturally
    // finished book in items-in-progress, which otherwise pins it as the hero
    // with "Resume". The shared progress store is the source of truth for
    // finished state; the render-time derivation below re-applies this against
    // live progress so a book finishing while Home is open falls off too.
    const finished = getProgressState().byId
    const visibleProgress = progress.filter(
      (it) => !justFinishedRef.current.has(it.id) && finished.get(it.id)?.isFinished !== true,
    )
    setInProgress(visibleProgress)
    setAutoDownloadContinueListening(
      visibleProgress.map((it) => ({
        itemId: it.id,
        title: itemTitle(it),
        author: itemAuthor(it),
      })),
    )

    // The hero's progress bar and the shelf tiles' finished marks read the
    // shared progress store; refresh it alongside the rest of Home. Awaited here
    // so the taste engine below sees fresh finished/started state.
    await refreshProgress().catch(() => {})

    // Dismissals drive which series/books are hidden from the Continue-* shelves;
    // pull them so the filter below is current. Best-effort.
    await hydrateDismissals().catch(() => {})

    // Stats strip is best-effort - a stats failure shouldn't block the rest of
    // Home from loading. Same getHSStats() the Stats tab reads, so the two never
    // disagree.
    getHSStats()
      .then(setStats)
      .catch(() => setStats(null))

    // Home shelves = ABS's own-progress/own-library rows (Continue Listening,
    // Recently Added) KEPT, but its recommendation rows (discover, listen-again)
    // dropped and replaced with HearthShelf's OWN taste engine. ABS's discover
    // feed mixes in other household members' books; ours is built from this
    // user's library + listening history. The engine is deterministic and offline
    // so it always produces rows - content on first run, no QuestGiver needed.
    const libs = await getLibraries()
    const firstBookLib = libs.find((l) => l.mediaType === 'book') ?? libs[0]
    setLibraryName(firstBookLib?.name ?? null)
    if (firstBookLib) {
      // Taste-engine recommendation shelves from the full library (limit=0 so
      // genres/narrator survive). Best-effort: a fetch failure just skips them.
      let recShelves: ABSShelf[] = []
      let carShelves: { id: string; label: string; items: ABSLibraryItem[] }[] = []
      try {
        const items = await getAllLibraryItems(firstBookLib.id)
        const progressMap = new Map(getProgressState().byId)
        const { shelves: baseShelves } = buildDiscoverShelves(items, progressMap)
        const byId = new Map(items.map((it) => [it.id, it] as const))
        const ranked = rankDiscoverShelves(baseShelves, byId)
        recShelves = ranked.map((s) => ({
          id: s.id,
          label: s.label,
          type: 'book',
          entities: s.items,
          icon: icons.sparkle,
        }))
        carShelves = ranked.map((s) => ({ id: s.id, label: s.label, items: s.items }))
      } catch {
        recShelves = []
      }

      // ABS's own-progress rows to keep: what the listener is mid-way through
      // ("continue-listening") and the next book in a series they've started
      // ("continue-series") lead; "recently-added" trails. ABS's recommendation /
      // finished rows ("discover", "listen-again") are dropped - the taste engine
      // replaces them. All three kept shelves are type 'book' in ABS.
      // Continue-Listening comes from ABS's personalized feed (books in
      // progress). Continue-Series is built from @hearthshelf/core's shelf
      // builder off the /series endpoint instead of ABS's own continue-series
      // row - that's the ONLY way each tile carries a real series id, which the
      // "Hide this series" dismiss action needs. Both are the same sources the
      // Auto queue draws from, so the shelves expose what the rules will queue.
      const continueShelves: HomeShelf[] = []
      let addedShelf: ABSShelf | null = null
      const finished = getProgressState().byId
      try {
        const personalized = await getPersonalized(firstBookLib.id)
        for (const s of personalized) {
          if (s.type !== 'book' || s.entities.length === 0) continue
          if (s.id === 'continue-listening') {
            const entities = s.entities.filter((e) => finished.get(e.id)?.isFinished !== true)
            if (entities.length)
              continueShelves.push({ ...s, source: 'listening', entities, icon: icons.recent })
          } else if (s.id === 'recently-added') addedShelf = { ...s, icon: icons.add } as HomeShelf
        }
      } catch {
        // Personalized is best-effort; the taste engine still carries Home.
      }

      // Build Continue-Series from core (series id per tile).
      try {
        const allSeries = await getLibrarySeries(firstBookLib.id)
        const csEntries = continueSeriesShelf(allSeries, getProgressState().byId, {
          seriesIds: [],
          itemIds: [],
        })
        if (csEntries.length) {
          const seriesByItemId: Record<string, { id: string; name: string }> = {}
          for (const e of csEntries)
            seriesByItemId[e.nextBook.id] = { id: e.series.id, name: e.series.name }
          continueShelves.push({
            id: 'continue-series',
            label: 'Continue Series',
            type: 'book',
            entities: csEntries.map((e) => e.nextBook),
            source: 'series',
            seriesByItemId,
            icon: icons.book,
          })
        }
      } catch {
        // Series fetch best-effort; Continue-Listening + taste engine still show.
      }

      // Order: Continue rows -> taste-engine recommendations -> Recently Added.
      // Continue leads because it's what the listener is most likely to resume;
      // the hero already spotlights the single top in-progress book.
      const bookShelves: HomeShelf[] = [
        ...continueShelves,
        ...recShelves,
        ...(addedShelf ? [addedShelf] : []),
      ]
      setShelves(bookShelves)

      // Publish the taste-engine recommendation shelves as the car's Discover
      // feed (the car can't run the engine itself, so it browses this snapshot).
      // Because the engine works offline/first-run, the car is populated even
      // before the user ever opens Discover or QuestGiver.
      setAutoDiscover(
        carShelves.map((s) => ({
          id: s.id,
          label: s.label,
          items: s.items.map((it) => ({
            id: it.id,
            title: it.media.metadata.title ?? 'Untitled',
            author: it.media.metadata.authorName ?? '',
          })),
        })),
      )
    }
    setLoading(false)
  }, [])

  // Offline: build Home from downloaded books (Continue + genre categories)
  // instead of the server, so the home screen stays useful with no network.
  const loadHomeOffline = useCallback(() => {
    const { inProgress: ip, shelves: sh } = catalogHomeShelves(
      (id) => getProgressState().byId.get(id)?.progress,
    )
    setInProgress(ip)
    setShelves(sh)
    setStats(null)
    setLoading(false)
  }, [])

  // Pull-to-refresh: reload Home without the full-screen spinner takeover
  // (loadHome's silent mode), showing only the pull spinner. Offline, refresh
  // just rebuilds from the downloaded catalog.
  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      if (connected) await loadHome({ silent: true })
      else loadHomeOffline()
    } finally {
      setRefreshing(false)
    }
  }, [connected, loadHome, loadHomeOffline])

  useEffect(() => {
    // Load once the session exists (reconnects re-fire this too, e.g. after
    // switching servers from the splash's "Manage servers").
    if (connected) {
      loadHome().catch(() => setLoading(false))
    } else if (status.phase === 'offline') {
      loadHomeOffline()
    }
  }, [connected, status.phase, loadHome, loadHomeOffline])

  useEffect(() => {
    if (!connected || !nowPlaying) {
      lastPlaybackItemRef.current = nowPlaying?.itemId ?? null
      lastPlaybackPlayingRef.current = isPlaying
      return
    }

    const lastItem = lastPlaybackItemRef.current
    const lastPlaying = lastPlaybackPlayingRef.current
    const itemChanged = lastItem !== nowPlaying.itemId
    const paused = lastPlaying === true && !isPlaying

    lastPlaybackItemRef.current = nowPlaying.itemId
    lastPlaybackPlayingRef.current = isPlaying

    if (!itemChanged && !paused) return

    if (playbackRefreshRef.current) clearTimeout(playbackRefreshRef.current)
    playbackRefreshRef.current = setTimeout(
      () => {
        playbackRefreshRef.current = null
        void loadHome({ silent: true }).catch(() => {})
      },
      paused ? 900 : 500,
    )
  }, [connected, nowPlaying, isPlaying, loadHome])

  useEffect(
    () => () => {
      if (playbackRefreshRef.current) clearTimeout(playbackRefreshRef.current)
    },
    [],
  )

  // Long-press mark-finished from a home tile. Update the visible sections right
  // away (a finished book leaves Continue), then reconcile with a silent reload
  // so the shelves/hero re-derive from the server.
  const handleMarkedFinished = useCallback(
    (item: ABSLibraryItem, finished: boolean) => {
      if (finished) {
        justFinishedRef.current.add(item.id)
        setInProgress((cur) => cur.filter((it) => it.id !== item.id))
      } else {
        justFinishedRef.current.delete(item.id)
      }
      void loadHome({ silent: true }).catch(() => {})
    },
    [loadHome],
  )

  const openActions = useCallback(
    (
      item: ABSLibraryItem,
      source: BookActionsSource = 'browse',
      series?: { id: string; name: string },
    ) => {
      haptics.longPress()
      actionsRef.current?.present(
        item,
        progressById.get(item.id)?.isFinished === true,
        source,
        series,
      )
    },
    [progressById],
  )

  // After a dismiss/reset: confirm, re-pull the server queue (the dismissed
  // series/book changes what Auto computes), and reload Home so the tile drops.
  // Undo lives in Settings > Hidden from shelves (the toast just confirms).
  const handleDismissed = useCallback(
    (label: string) => {
      showToast(`${label} - restore in Settings`)
      void getServerQueue()
        .then((q) => {
          setQueueItems(q.items, false)
          setQueueManual(q.manual, false)
        })
        .catch(() => {})
      void loadHome({ silent: true })
    },
    [showToast, loadHome],
  )

  useEffect(() => {
    setSessionExpiredHandler(() => {
      void handleSignOut('expired')
    })
    return () => setSessionExpiredHandler(null)
  }, [handleSignOut])

  // The gate guarantees a live session before Home mounts; this only covers the
  // brief first content fetch.
  if (loading) {
    return (
      <Screen>
        <Loading label={serverName ? `Loading ${serverName}...` : 'Loading your library...'} />
      </Screen>
    )
  }

  // Re-apply the finished filter at render against the live progress store so a
  // book that reaches 100% while Home is open drops out of the hero/Continue
  // immediately, without waiting for the next items-in-progress fetch.
  const visibleInProgress = inProgress.filter((it) => progressById.get(it.id)?.isFinished !== true)
  const hero = visibleInProgress[0]

  return (
    <Screen>
      {/* Mounts fresh when the first load finishes, so content fades in instead
          of hard-cutting from the spinner. */}
      <Animated.ScrollView
        ref={scrollRef}
        entering={FadeIn.duration(DUR.base)}
        contentContainerStyle={{ paddingBottom: contentInset }}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
            colors={[colors.accent]}
          />
        }
      >
        <HomeHeader firstName={firstName} libraryName={libraryName} />
        {nowPlaying ? (
          <PlayerHero
            nowPlaying={nowPlaying}
            isPlaying={isPlaying}
            position={position}
            onOpen={() => router.push('/player')}
          />
        ) : hero ? (
          <ContinueHero
            item={hero}
            progress={progressById.get(hero.id)?.progress ?? 0}
            onResume={async () => {
              try {
                // playItemById resolves the resume position itself (play session,
                // else the saved media-progress spot), so no manual seek here.
                await playItemById(hero.id)
                router.push('/player')
              } catch {
                router.push(`/item/${hero.id}?from=home`)
              }
            }}
            onLongPress={() => openActions(hero)}
          />
        ) : null}
        <DashboardRow stats={stats} onOpenQueue={() => queueSheetRef.current?.present()} />
        <ReleaseCountdownBanner />
        <HomeClubShelf />
        {shelves.map((shelf) => (
          <Shelf key={shelf.id} shelf={shelf} onLongPressItem={openActions} />
        ))}
      </Animated.ScrollView>

      <BookActionsSheet
        ref={actionsRef}
        onMarkedFinished={handleMarkedFinished}
        onDismissed={handleDismissed}
        onToast={showToast}
      />
      <QueueSheet
        ref={queueSheetRef}
        onJump={async (itemId) => {
          const saved = getProgressState().byId.get(itemId)
          await playItemById(itemId)
          if (!saved?.isFinished && (saved?.currentTime ?? 0) > 0) requestSeek(saved!.currentTime)
          router.push('/player')
        }}
      />
      <Toast message={toast} />
    </Screen>
  )
}

/**
 * Header utility row above the hero: time-of-day greeting with the active
 * server/library context under it (tap opens the server switcher), plus
 * Downloads (accent activity dot while anything is in-flight) and Search on the
 * right edge. Deterministic per render (no Math.random in the hot path).
 */
function HomeHeader({
  firstName,
  libraryName,
}: {
  firstName: string | null
  libraryName: string | null
}) {
  const colors = useColors()
  const styles = useStyles()
  const router = useRouter()
  const { serverName } = useConnection()
  const downloads = useSyncExternalStore(subscribeDownloads, getDownloadsState)
  let downloading = false
  for (const e of downloads.byId.values()) {
    if (e.status === 'downloading' || e.status === 'queued') {
      downloading = true
      break
    }
  }
  const h = new Date().getHours()
  const partOfDay =
    h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night'
  const hello = firstName ? `Good ${partOfDay}, ${firstName}` : `Good ${partOfDay}`
  const context = [serverName, libraryName].filter(Boolean).join(' · ')
  return (
    <View style={styles.header}>
      <Touchable
        onPress={() => router.push('/settings/servers')}
        style={{ flex: 1, minWidth: 0 }}
      >
        <AppText variant="label" numberOfLines={1}>
          {hello}
        </AppText>
        {context ? (
          <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
            {context}
          </AppText>
        ) : null}
      </Touchable>
      <View style={styles.headerBtns}>
        <Touchable
          onPress={() => router.push('/settings/storage')}
          style={styles.headerBtn}
        >
          <Icon name={icons.download} size={19} color={colors.text} />
          {downloading ? <View style={styles.headerDot} /> : null}
        </Touchable>
        <Touchable
          onPress={() => router.push('/search?from=home')}
          style={styles.headerBtn}
        >
          <Icon name={icons.search} size={19} color={colors.text} />
        </Touchable>
      </View>
    </View>
  )
}

// Text and track colors used over the heroes' scrimmed artwork. The art is
// always dark-scrimmed regardless of theme, so these are content-anchored
// constants, not theme tokens.
const HERO_TEXT = 'rgba(255,255,255,0.98)'
const HERO_TEXT_DIM = 'rgba(255,255,255,0.78)'
const HERO_EYEBROW = 'rgba(255,255,255,0.75)'
const HERO_TRACK = 'rgba(255,255,255,0.22)'

/**
 * Compact continue-listening hero card (~190px): the book's artwork fills a
 * rounded band with a bottom-heavy scrim; title/progress/Resume sit in the
 * thumb-friendly lower half. Tap resumes, long-press opens actions.
 */
function ContinueHero({
  item,
  progress,
  onResume,
  onLongPress,
}: {
  item: ABSLibraryItem
  progress: number
  onResume: () => void
  onLongPress: () => void
}) {
  const colors = useColors()
  const styles = useStyles()
  const { width } = useWindowDimensions()
  const contentMaxWidth = adaptiveContentMaxWidth(width)
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100)
  const started = progress > 0
  const heroArt = coverUrl(item.id)
  const duration = (item.media as { duration?: number }).duration
  const left =
    started && duration && duration > 0 ? `${formatDuration(duration * (1 - progress))} left` : null
  return (
    <View style={styles.heroWrap}>
      <Pressable
        onPress={onResume}
        onLongPress={onLongPress}
        delayLongPress={350}
        style={[styles.heroCard, styles.heroCardShort, { maxWidth: contentMaxWidth }]}
      >
        <ImageBackground
          source={heroArt ? { uri: heroArt } : undefined}
          style={StyleSheet.absoluteFill}
          imageStyle={styles.heroBgImg}
        >
          <LinearGradient
            colors={['rgba(0,0,0,0.08)', 'rgba(15,11,8,0.62)']}
            locations={[0, 0.8]}
            style={StyleSheet.absoluteFill}
          />
        </ImageBackground>

        <View style={styles.heroBody}>
          <AppText variant="eyebrow" color={HERO_EYEBROW}>
            {started ? 'Continue' : 'Up next'}
          </AppText>
          <AppText variant="title" color={HERO_TEXT} numberOfLines={1} style={{ marginTop: 5 }}>
            {itemTitle(item)}
          </AppText>
          <AppText variant="meta" color={HERO_TEXT_DIM} numberOfLines={1} style={{ marginTop: 3 }}>
            {[itemAuthor(item), left].filter(Boolean).join(' · ')}
          </AppText>
        </View>

        {started && (
          <View style={[styles.heroTrackRow, { bottom: 56 }]}>
            <View style={styles.heroTrack}>
              <View style={[styles.heroTrackFill, { width: `${pct}%` }]} />
            </View>
            <AppText variant="mono" color={HERO_TEXT_DIM}>
              {pct}%
            </AppText>
          </View>
        )}

        <Touchable onPress={onResume} style={styles.heroResume}>
          <Icon name={icons.play} size={20} color={colors.onAccent} />
          <AppText variant="label" color={colors.onAccent}>
            {started ? 'Resume' : 'Start listening'}
          </AppText>
        </Touchable>
      </Pressable>
    </View>
  )
}

/**
 * Compact live-player hero card (~238px playing / ~190px paused): now-playing
 * artwork fills the band; title, chapter, display-only progress, and the
 * transport sit in the lower half (scrubbing stays in the full player). Tapping
 * anywhere opens the full player.
 */
function PlayerHero({
  nowPlaying,
  isPlaying,
  position,
  onOpen,
}: {
  nowPlaying: NonNullable<ReturnType<typeof getState>['nowPlaying']>
  isPlaying: boolean
  position: number
  onOpen: () => void
}) {
  const colors = useColors()
  const styles = useStyles()
  const { width } = useWindowDimensions()
  const contentMaxWidth = adaptiveContentMaxWidth(width)
  const { skipForward, skipBack } = useSyncExternalStore(subscribeSettings, getSettingsState)

  const duration = nowPlaying.duration
  const bookProgress = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0
  const pct = Math.round(bookProgress * 100)
  const chapter = currentChapter()
  const meta = [nowPlaying.author, chapter?.title].filter(Boolean).join(' · ')

  const heroArt = coverUrl(nowPlaying.itemId)
  return (
    <View style={styles.heroWrap}>
      <Pressable
        onPress={onOpen}
        style={[
          styles.heroCard,
          isPlaying ? styles.heroCardTall : styles.heroCardShort,
          { maxWidth: contentMaxWidth },
        ]}
      >
        <ImageBackground
          source={heroArt ? { uri: heroArt } : undefined}
          style={StyleSheet.absoluteFill}
          imageStyle={styles.heroBgImg}
        >
          <LinearGradient
            colors={['rgba(0,0,0,0.08)', 'rgba(15,11,8,0.62)']}
            locations={[0, 0.8]}
            style={StyleSheet.absoluteFill}
          />
        </ImageBackground>

        <View style={styles.heroBody}>
          <AppText variant="eyebrow" color={HERO_EYEBROW}>
            {isPlaying ? 'Now playing' : 'Continue'}
          </AppText>
          <AppText variant="title" color={HERO_TEXT} numberOfLines={1} style={{ marginTop: 5 }}>
            {nowPlaying.title}
          </AppText>
          <AppText variant="meta" color={HERO_TEXT_DIM} numberOfLines={1} style={{ marginTop: 3 }}>
            {meta}
          </AppText>
        </View>

        <View style={[styles.heroTrackRow, { bottom: isPlaying ? 76 : 56 }]}>
          <View style={styles.heroTrack}>
            <View style={[styles.heroTrackFill, { width: `${pct}%` }]} />
          </View>
          <AppText variant="mono" color={HERO_TEXT_DIM}>
            {pct}%
          </AppText>
        </View>

        {isPlaying ? (
          <>
            <View style={styles.heroTransport}>
              <SkipButton
                dir={-1}
                seconds={skipBack}
                size={26}
                color={HERO_TEXT}
                onPress={() => jumpBy(-skipBack)}
              />
              <Touchable onPress={togglePlay} style={styles.heroPlayBtn}>
                <Icon name={icons.pause} size={28} color={colors.onAccent} />
              </Touchable>
              <SkipButton
                dir={1}
                seconds={skipForward}
                size={26}
                color={HERO_TEXT}
                onPress={() => jumpBy(skipForward)}
              />
            </View>
            <View style={styles.heroOpenHint}>
              <AppText variant="caption" color={HERO_TEXT_DIM}>
                Player
              </AppText>
              <Icon name={icons.chevronRight} size={16} color={HERO_TEXT_DIM} />
            </View>
          </>
        ) : (
          <Touchable onPress={togglePlay} style={styles.heroResume}>
            <Icon name={icons.play} size={20} color={colors.onAccent} />
            <AppText variant="label" color={colors.onAccent}>
              Resume
            </AppText>
          </Touchable>
        )}
      </Pressable>
    </View>
  )
}

/**
 * Dashboard row under the hero: an "Up next" card previewing the live queue
 * (mini covers + count + mode; taps straight into the queue sheet) and the
 * streak/this-week card that jumps to Stats. Height is reserved up front so
 * nothing shifts when stats/queue data lands.
 */
function DashboardRow({
  stats,
  onOpenQueue,
}: {
  stats: HSListeningStats | null
  onOpenQueue: () => void
}) {
  const colors = useColors()
  const styles = useStyles()
  const router = useRouter()
  const queue = useSyncExternalStore(subscribeQueue, getQueueState)
  const { queueMode } = useSyncExternalStore(subscribeSettings, getSettingsState)
  const modeLabel = QUEUE_MODES.find((m) => m.v === queueMode)?.label ?? 'Off'
  const preview = queue.items.slice(0, 3)
  // Streak nudge: today has no listening yet but there's a streak to protect.
  const streakAtRisk = stats != null && stats.todaySec === 0 && stats.dayStreak > 0
  return (
    <View style={styles.dashRow}>
      <Touchable onPress={onOpenQueue} style={[styles.dashCard, { flex: 1.2 }]}>
        <View style={styles.dashHead}>
          <AppText variant="label">Up next</AppText>
          <Icon name={icons.queue} size={17} color={colors.textMuted} />
        </View>
        {preview.length > 0 ? (
          <View style={styles.dashCovers}>
            {preview.map((e, i) => (
              <View key={e.libraryItemId} style={[styles.dashCover, i > 0 && { marginLeft: -8 }]}>
                <Cover
                  uri={coverUrl(e.libraryItemId)}
                  itemId={e.libraryItemId}
                  width={26}
                  aspectRatio={2 / 3}
                  fallback={{
                    hue: coverHue(e.libraryItemId),
                    initial: e.title.charAt(0).toUpperCase(),
                  }}
                />
              </View>
            ))}
          </View>
        ) : null}
        <AppText variant="caption" color={colors.textMuted} style={styles.dashCaption}>
          {queue.items.length > 0
            ? `${queue.items.length} queued · ${modeLabel}`
            : `Nothing queued · ${modeLabel}`}
        </AppText>
      </Touchable>
      <Touchable onPress={() => router.push('/(tabs)/stats')} style={[styles.dashCard, { flex: 1 }]}>
        <View style={styles.dashStat}>
          <Icon name={icons.flame} size={18} color={colors.brandHearth} />
          <AppText variant="mono" style={styles.dashBig}>
            {stats ? String(stats.dayStreak) : '–'}
          </AppText>
          <AppText variant="caption" color={colors.textMuted}>
            days
          </AppText>
        </View>
        {streakAtRisk ? (
          <AppText
            variant="caption"
            color={colors.textMuted}
            numberOfLines={2}
            style={styles.dashCaption}
          >
            streak on the line - listen today to keep it
          </AppText>
        ) : (
          <>
            <View style={[styles.dashStat, { marginTop: spacing.sm }]}>
              <Icon name={icons.schedule} size={15} color={colors.textMuted} />
              <AppText variant="mono" style={{ fontWeight: '700' }}>
                {stats ? formatDuration(stats.weekSec) : '–'}
              </AppText>
            </View>
            <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
              this week
            </AppText>
          </>
        )}
      </Touchable>
    </View>
  )
}

function Shelf({
  shelf,
  onLongPressItem,
}: {
  shelf: HomeShelf
  onLongPressItem: (
    item: ABSLibraryItem,
    source?: BookActionsSource,
    series?: { id: string; name: string },
  ) => void
}) {
  const colors = useColors()
  const styles = useStyles()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const { coverAspect } = useSyncExternalStore(subscribeSettings, getSettingsState)
  // Per-item progress drives the tiles' progress bars, finished badges, and
  // whether the quick-play chip shows.
  const progressById = useSyncExternalStore(subscribeProgress, getProgressState).byId
  // Hide dismissed series/books from this shelf live (the dismiss action re-pulls
  // Home, but this keeps the tile from lingering between the write and reload).
  useSyncExternalStore(subscribeDismissals, getDismissalsState)
  const sheetRef = useRef<SheetRef>(null)
  if (shelf.type !== 'book') return null
  const source = shelf.source ?? 'browse'
  const seriesByItemId = shelf.seriesByItemId
  const entities = shelf.entities.filter((it) => {
    if (isItemDismissed(it.id)) return false
    // A Continue-Series tile is hidden if its series was dismissed.
    const sr = seriesByItemId?.[it.id]
    if (sr && isSeriesDismissed(sr.id)) return false
    return true
  })
  if (entities.length === 0) return null
  const openAll = () => sheetRef.current?.present()
  const tileWidth = adaptiveShelfTileWidth(width)
  const sheetCols = adaptiveGridColumns({
    width,
    minTile: 104,
    maxCols: 5,
    gutter: spacing.md,
  })
  const sheetTileWidth = adaptiveGridTileWidth({
    width,
    cols: sheetCols,
    gutter: spacing.md,
  })
  return (
    <View style={{ marginTop: spacing.lg }}>
      <SectionHeader
        title={shelf.label}
        icon={shelf.icon ?? icons.library}
        onPress={openAll}
        action={
          <Touchable onPress={openAll} hitSlop={8} style={styles.seeAll}>
            <AppText variant="caption" color={colors.textMuted}>
              See all
            </AppText>
            <Icon name={icons.chevronRight} size={16} color={colors.textMuted} />
          </Touchable>
        }
      />
      <FlatList
        data={entities}
        keyExtractor={(it) => it.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.md }}
        renderItem={({ item, index }) => {
          const p = progressById.get(item.id)
          const quickPlay = async () => {
            haptics.transport()
            try {
              await playItemById(item.id)
              router.push('/player')
            } catch {
              router.push(`/item/${item.id}?from=home`)
            }
          }
          return (
            // Staggered entrance, capped so deep-scroll mounts don't lag behind
            // their own appearance. minHeight reserves the tile's full frame
            // (cover + two meta lines) so the index-0 FadeInDown (delay 0)
            // can't snapshot before layout and clip the meta - the bug that
            // dropped the first author in every row.
            <Animated.View
              entering={FadeInDown.delay(Math.min(index, 6) * 40).duration(DUR.slow)}
              style={{ minHeight: tileWidth / COVER_ASPECT_RATIO[coverAspect] + 56 }}
            >
              <BookTile
                item={item}
                width={tileWidth}
                from="home"
                progress={p?.progress}
                finished={p?.isFinished === true}
                onQuickPlay={() => void quickPlay()}
                onLongPress={() => onLongPressItem(item, source, seriesByItemId?.[item.id])}
              />
            </Animated.View>
          )
        }}
      />

      {/* "See all" opens the section's OWN items in a tray (a 3-col grid) rather
          than a Library-filtered view, which mis-mapped some shelves. */}
      <Sheet ref={sheetRef} title={shelf.label} snapPoints={['85%']}>
        <BottomSheetFlatList
          data={shelf.entities}
          keyExtractor={(it) => it.id}
          key={`home-sheet-${sheetCols}`}
          numColumns={sheetCols}
          columnWrapperStyle={{ gap: spacing.md }}
          contentContainerStyle={{ gap: spacing.lg, paddingBottom: spacing.xl }}
          renderItem={({ item }) => (
            <Touchable
              style={{ width: sheetTileWidth }}
              onPress={() => {
                sheetRef.current?.dismiss()
                router.push(`/item/${item.id}?from=home`)
              }}
            >
              <Cover
                uri={coverUrl(item.id)}
                itemId={item.id}
                width={sheetTileWidth}
                aspectRatio={COVER_ASPECT_RATIO[coverAspect]}
                fallback={{
                  hue: coverHue(item.id),
                  initial: itemTitle(item).charAt(0).toUpperCase(),
                }}
                showDownloadBadge
              />
              <AppText variant="caption" numberOfLines={1} style={{ marginTop: spacing.xs }}>
                {itemTitle(item)}
              </AppText>
            </Touchable>
          )}
        />
      </Sheet>
    </View>
  )
}

const makeStyles = (colors: Palette, shadow: ReturnType<typeof useTheme>['shadow']) =>
  StyleSheet.create({
    // Header utility row: greeting + server context left, 44px icon targets right.
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xs,
    },
    headerBtns: { flexDirection: 'row', gap: spacing.sm },
    headerBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerDot: {
      position: 'absolute',
      top: 6,
      right: 6,
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: colors.accent,
      borderWidth: 1.5,
      borderColor: colors.scaffold,
    },
    // Compact hearth hero: a rounded card band (~238px playing / ~190px paused)
    // with the artwork filling it and content in the thumb-friendly lower half.
    heroWrap: { paddingHorizontal: spacing.md, marginTop: spacing.sm },
    heroCard: {
      alignSelf: 'center',
      width: '100%',
      borderRadius: 20,
      overflow: 'hidden',
      backgroundColor: colors.card,
    },
    heroCardTall: { height: 238 },
    heroCardShort: { height: 190 },
    heroBgImg: { resizeMode: 'cover' },
    heroBody: { paddingTop: 15, paddingHorizontal: 18 },
    heroTrackRow: {
      position: 'absolute',
      left: 18,
      right: 18,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    heroTrack: {
      flex: 1,
      height: 4,
      borderRadius: 2,
      backgroundColor: HERO_TRACK,
      overflow: 'hidden',
    },
    heroTrackFill: {
      height: '100%',
      borderRadius: 2,
      backgroundColor: colors.accent,
    },
    // Compact auto-width Resume pill anchored bottom-left in the card.
    heroResume: {
      position: 'absolute',
      left: 18,
      bottom: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingVertical: 10,
      paddingHorizontal: 22,
      borderRadius: 14,
      backgroundColor: colors.accent,
      ...shadow.accentGlow,
    },
    heroTransport: {
      position: 'absolute',
      left: 18,
      bottom: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.lg,
    },
    heroPlayBtn: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      ...shadow.accentGlow,
    },
    heroOpenHint: {
      position: 'absolute',
      right: 14,
      bottom: 24,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 2,
    },
    seeAll: { flexDirection: 'row', alignItems: 'center', gap: 1 },
    // Dashboard row: Up-next queue peek + streak/this-week tile. minHeight
    // reserves the band before stats/queue data lands (no layout shift).
    dashRow: {
      flexDirection: 'row',
      gap: spacing.sm + 2,
      marginHorizontal: spacing.md,
      marginTop: spacing.md,
    },
    dashCard: {
      minHeight: 96,
      paddingHorizontal: 14,
      paddingVertical: spacing.md,
      backgroundColor: colors.card,
      borderRadius: radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      ...shadow.card,
    },
    dashHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    dashCovers: { flexDirection: 'row', marginTop: spacing.sm + 1 },
    dashCover: {
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: colors.card,
      overflow: 'hidden',
    },
    dashCaption: { marginTop: spacing.sm },
    dashStat: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    dashBig: { fontSize: 19, fontWeight: '700' },
  })

// Hook: the memoized stylesheet for the active palette.
function useStyles() {
  const { colors, shadow } = useTheme()
  return useMemo(() => makeStyles(colors, shadow), [colors, shadow])
}
