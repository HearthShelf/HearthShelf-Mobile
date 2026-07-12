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
import type { ABSLibraryItem, ABSShelf, HSListeningStats } from '@hearthshelf/core'
import {
  coverHue,
  formatDuration,
  formatTimestamp,
  buildDiscoverShelves,
  rankDiscoverShelves,
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
  getPersonalized,
  itemAuthor,
  itemTitle,
} from '@/api/abs'
import { getProgressState, subscribeProgress, refreshProgress } from '@/store/progress'
import { playItemById } from '@/player/playback'
import { setAutoDownloadContinueListening } from '@/player/downloads'
import { catalogHomeShelves } from '@/player/offlineCatalog'
import {
  AppText,
  Cover,
  Loading,
  ProgressBar,
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
import { Scrubber } from '@/player/Scrubber'
import { SkipButton } from '@/player/SkipButton'
import {
  BookActionsSheet,
  type BookActionsHandle,
  type BookActionsSource,
} from '@/ui/BookActionsSheet'
import { getServerQueue } from '@/api/queue'
import { setQueueItems, setQueueManual } from '@/player/queue'
import {
  hydrateDismissals,
  subscribeDismissals,
  getDismissalsState,
  isItemDismissed,
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
  const [shelves, setShelves] = useState<ABSShelf[]>([])
  const [stats, setStats] = useState<HSListeningStats | null>(null)
  // Shared per-item progress; mark-finished anywhere updates tiles here live.
  const progressById = useSyncExternalStore(subscribeProgress, getProgressState).byId
  const { message: toast, show: showToast } = useToast()
  const actionsRef = useRef<BookActionsHandle>(null)
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
      const CONTINUE_IDS = ['continue-listening', 'continue-series']
      const continueShelves: ABSShelf[] = []
      let addedShelf: ABSShelf | null = null
      try {
        const personalized = await getPersonalized(firstBookLib.id)
        // Preserve ABS's own ordering of the continue rows (listening before
        // series, as ABS emits them).
        const finished = getProgressState().byId
        for (const s of personalized) {
          if (s.type !== 'book' || s.entities.length === 0) continue
          if (CONTINUE_IDS.includes(s.id)) {
            // Same finished-book pin fix as the hero: keep 100%-complete books
            // out of the Continue rows.
            const entities = s.entities.filter((e) => finished.get(e.id)?.isFinished !== true)
            if (entities.length) continueShelves.push({ ...s, entities })
          } else if (s.id === 'recently-added') addedShelf = s
        }
      } catch {
        // Personalized is best-effort; the taste engine still carries Home.
      }

      // Order: Continue rows -> taste-engine recommendations -> Recently Added.
      // Continue leads because it's what the listener is most likely to resume;
      // the hero already spotlights the single top in-progress book.
      const bookShelves: ABSShelf[] = [
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
    (item: ABSLibraryItem, source: BookActionsSource = 'browse', series?: { id: string; name: string }) => {
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
        {nowPlaying ? (
          <PlayerHero
            nowPlaying={nowPlaying}
            isPlaying={isPlaying}
            position={position}
            greeting={<Greeting firstName={firstName} nowPlayingTitle={nowPlaying.title} />}
            onOpen={() => router.push('/player')}
          />
        ) : hero ? (
          <ContinueHero
            item={hero}
            progress={progressById.get(hero.id)?.progress ?? 0}
            greeting={<Greeting firstName={firstName} />}
            onResume={async () => {
              try {
                // playItemById resolves the resume position itself (play session,
                // else the saved media-progress spot), so no manual seek here.
                await playItemById(hero.id)
                router.push('/player')
              } catch {
                router.push(`/item/${hero.id}`)
              }
            }}
            onLongPress={() => openActions(hero)}
          />
        ) : (
          <View style={styles.topBar}>
            <Greeting firstName={firstName} />
          </View>
        )}
        {stats ? <HomeStatsStrip stats={stats} /> : null}
        <ReleaseCountdownBanner />
        <HomeClubShelf />
        {shelves.map((shelf) => (
          <Shelf
            key={shelf.id}
            shelf={shelf}
            // Continue-Listening tiles get the dismiss + reset-progress actions.
            source={shelf.id === 'continue-listening' ? 'listening' : 'browse'}
            onLongPressItem={openActions}
          />
        ))}
      </Animated.ScrollView>

      <BookActionsSheet
        ref={actionsRef}
        onMarkedFinished={handleMarkedFinished}
        onDismissed={handleDismissed}
        onToast={showToast}
      />
      <Toast message={toast} />
    </Screen>
  )
}

/** Two-line personalized greeting: "Hello <name>" + a time-of-day subtext that
 *  nods to what's playing when there is something. Deterministic per render (no
 *  Math.random in the hot path - a small rotation keyed off the hour). */
function Greeting({
  firstName,
  nowPlayingTitle,
}: {
  firstName: string | null
  nowPlayingTitle?: string
}) {
  const colors = useColors()
  const h = new Date().getHours()
  const partOfDay =
    h < 5 ? 'night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night'
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
  onLongPress,
}: {
  item: ABSLibraryItem
  progress: number
  greeting: React.ReactNode
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
      <View style={[styles.heroContent, { maxWidth: contentMaxWidth, width: '100%' }]}>
        <View style={styles.heroGreeting}>{greeting}</View>
        <View style={styles.heroGap} />
        <Pressable style={styles.heroMeta} onLongPress={onLongPress} delayLongPress={350}>
          <AppText variant="eyebrow" color={colors.accent}>
            {started ? 'Continue' : 'Up next'}
          </AppText>
          <AppText variant="title" numberOfLines={2} style={{ marginTop: 6 }}>
            {itemTitle(item)}
          </AppText>
          <AppText
            variant="meta"
            color={colors.textMuted}
            numberOfLines={1}
            style={{ marginTop: 4 }}
          >
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
        </Pressable>

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
 * Live-player hero: shown in place of the Resume hero whenever something is
 * playing. The now-playing artwork fills the spotlight (same treatment as the
 * Continue hero), the Resume pill becomes a round play/pause, and the flat
 * progress bar becomes the real draggable Scrubber - chapter- or book-relative
 * per the user's scrubber setting, matching the full player. Skip buttons sit in
 * the bottom-right, using the configured skip amounts. Tapping the cover opens
 * the full player.
 */
function PlayerHero({
  nowPlaying,
  isPlaying,
  position,
  greeting,
  onOpen,
}: {
  nowPlaying: NonNullable<ReturnType<typeof getState>['nowPlaying']>
  isPlaying: boolean
  position: number
  greeting: React.ReactNode
  onOpen: () => void
}) {
  const colors = useColors()
  const styles = useStyles()
  const { width } = useWindowDimensions()
  const contentMaxWidth = adaptiveContentMaxWidth(width)
  const { scrubber, skipForward, skipBack } = useSyncExternalStore(
    subscribeSettings,
    getSettingsState,
  )
  const [previewRatio, setPreviewRatio] = useState<number | null>(null)

  const duration = nowPlaying.duration
  const hasChapters = nowPlaying.chapters.length > 0
  const chapterScope = scrubber === 'chapter' && hasChapters
  const chapter = currentChapter()

  const bookProgress = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0

  // Chapter-relative when the setting asks for it (and chapters exist), else
  // whole-book. Mirrors the full player's math so the two never disagree.
  const chStart = chapter?.start ?? 0
  const chEnd = chapter?.end ?? duration
  const chSpan = Math.max(1, chEnd - chStart)
  const shownPos = previewRatio !== null ? chStart + previewRatio * chSpan : position
  const chPos = Math.max(0, shownPos - chStart)
  const ratio = chapterScope ? Math.min(1, chPos / chSpan) : bookProgress
  const elapsed = formatTimestamp(chapterScope ? chPos : shownPos)
  const remain = formatTimestamp(Math.max(0, chapterScope ? chSpan - chPos : duration - shownPos))

  const seekToRatio = (r: number) => {
    if (chapterScope) requestSeek(chStart + r * chSpan)
    else if (duration > 0) requestSeek(r * duration)
  }

  const heroArt = coverUrl(nowPlaying.itemId)
  return (
    <View style={styles.hero}>
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

      <View style={[styles.heroContent, { maxWidth: contentMaxWidth, width: '100%' }]}>
        <Pressable style={styles.heroGreeting} onPress={onOpen}>
          {greeting}
        </Pressable>
        <View style={styles.heroGap} />
        <Pressable style={styles.heroMeta} onPress={onOpen}>
          <AppText variant="eyebrow" color={colors.accent}>
            {isPlaying ? 'Now playing' : 'Continue'}
          </AppText>
          <AppText variant="title" numberOfLines={2} style={{ marginTop: 6 }}>
            {nowPlaying.title}
          </AppText>
          <AppText
            variant="meta"
            color={colors.textMuted}
            numberOfLines={1}
            style={{ marginTop: 4 }}
          >
            {nowPlaying.author}
          </AppText>
          {isPlaying && chapterScope && chapter?.title ? (
            <AppText
              variant="caption"
              color={colors.textMuted}
              numberOfLines={1}
              style={{ marginTop: 2 }}
            >
              {chapter.title}
            </AppText>
          ) : null}
        </Pressable>

        {isPlaying ? (
          <>
            {/* Live player: draggable scrubber + transport, shown only while
                audio is advancing. Paused, the hero reverts to the Resume look. */}
            <View style={styles.heroScrub}>
              <Scrubber
                ratio={ratio}
                playing={isPlaying}
                elapsed={elapsed}
                remain={remain}
                onDrag={setPreviewRatio}
                onSeek={seekToRatio}
              />
            </View>

            <View style={styles.heroPlayerRow}>
              <Touchable onPress={togglePlay} style={styles.heroPlayBtn}>
                <Icon name={icons.pause} size={28} color={colors.onAccent} />
              </Touchable>
              <View style={{ flex: 1 }} />
              <SkipButton
                dir={-1}
                seconds={skipBack}
                size={30}
                color={colors.text}
                onPress={() => jumpBy(-skipBack)}
              />
              <SkipButton
                dir={1}
                seconds={skipForward}
                size={30}
                color={colors.text}
                onPress={() => jumpBy(skipForward)}
              />
            </View>
          </>
        ) : (
          <>
            <View style={styles.heroProgress}>
              <ProgressBar progress={bookProgress} style={{ flex: 1 }} />
              <AppText variant="mono" color={colors.textMuted}>
                {Math.round(bookProgress * 100)}%
              </AppText>
            </View>

            <Touchable onPress={togglePlay} style={styles.heroResume}>
              <Icon name={icons.play} size={20} color={colors.onAccent} />
              <AppText variant="label" color={colors.onAccent}>
                Resume
              </AppText>
            </Touchable>
          </>
        )}
      </View>
    </View>
  )
}

/**
 * Day streak + this-week cards, matching the prototype's home stats strip.
 * Reads the same getHSStats() data as the Stats tab, so the two never disagree.
 */
function HomeStatsStrip({ stats }: { stats: HSListeningStats }) {
  const colors = useColors()
  const styles = useStyles()
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

/** A small leading icon per home section, keyed off its label. */
function sectionIcon(label: string): IconName {
  const l = label.toLowerCase()
  if (l.includes('continue') || l.includes('listen again')) return icons.recent
  if (l.includes('recent') || l.includes('added') || l.includes('newest')) return icons.add
  if (l.includes('discover')) return icons.flame
  if (l.includes('series')) return icons.book
  return icons.library
}

function Shelf({
  shelf,
  source = 'browse',
  onLongPressItem,
}: {
  shelf: ABSShelf
  source?: BookActionsSource
  onLongPressItem: (item: ABSLibraryItem, source?: BookActionsSource) => void
}) {
  const colors = useColors()
  const styles = useStyles()
  const router = useRouter()
  const { width } = useWindowDimensions()
  const { coverAspect } = useSyncExternalStore(subscribeSettings, getSettingsState)
  // Hide dismissed books from this shelf live (the dismiss action re-pulls Home,
  // but this keeps the tile from lingering between the write and the reload).
  useSyncExternalStore(subscribeDismissals, getDismissalsState)
  const sheetRef = useRef<SheetRef>(null)
  if (shelf.type !== 'book') return null
  const entities = shelf.entities.filter((it) => !isItemDismissed(it.id))
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
        icon={sectionIcon(shelf.label)}
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
        renderItem={({ item, index }) => (
          // Staggered entrance, capped so deep-scroll mounts don't lag behind
          // their own appearance.
          <Animated.View entering={FadeInDown.delay(Math.min(index, 6) * 40).duration(DUR.slow)}>
            <Touchable
              style={{ width: tileWidth }}
              onPress={() => router.push(`/item/${item.id}`)}
              onLongPress={() => onLongPressItem(item, source)}
            >
              <Cover
                uri={coverUrl(item.id)}
                itemId={item.id}
                width={tileWidth}
                aspectRatio={COVER_ASPECT_RATIO[coverAspect]}
                showDownloadBadge
              />
              {/* Title + author in a fixed-height column. The minHeight reserves
                  both lines up front so the index-0 tile's FadeInDown (delay 0)
                  can't snapshot the frame before the author line has laid out and
                  clip it - the bug that dropped the first author in every row. */}
              <View style={[styles.tileMeta, { width: tileWidth }]}>
                <AppText variant="meta" numberOfLines={1}>
                  {itemTitle(item)}
                </AppText>
                <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                  {itemAuthor(item)}
                </AppText>
              </View>
            </Touchable>
          </Animated.View>
        )}
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
                router.push(`/item/${item.id}`)
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
      alignSelf: 'center',
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
      ...shadow.accentGlow,
    },
    heroScrub: { marginTop: 18 },
    heroPlayerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.lg,
    },
    heroPlayBtn: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      ...shadow.accentGlow,
    },
    seeAll: { flexDirection: 'row', alignItems: 'center', gap: 1 },
    // Reserve space for both text lines so the entrance animation can't clip the
    // author off the first tile (see the renderItem comment).
    tileMeta: { minHeight: 38, marginTop: spacing.xs },
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
      ...shadow.card,
    },
  })

// Hook: the memoized stylesheet for the active palette.
function useStyles() {
  const { colors, shadow } = useTheme()
  return useMemo(() => makeStyles(colors, shadow), [colors, shadow])
}
