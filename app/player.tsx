/**
 * Full-screen now-playing view. The cover fills the space between the header and
 * the controls (which are pinned to the bottom); the bottom tab bar stays visible
 * so you can move around the app while listening, and swiping up on the artwork
 * drops into an immersive mode that hides the chrome. Double-tapping the artwork
 * opens a full, pinch-zoomable lightbox.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Image, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { LinearGradient } from 'expo-linear-gradient'
import { useRouter } from 'expo-router'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { BottomSheetScrollView } from '@gorhom/bottom-sheet'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated'
import { coverHue, formatTimestamp, formatDuration } from '@hearthshelf/core'
import type { ABSDeviceInfo } from '@hearthshelf/core'
import {
  getState,
  subscribe,
  togglePlay,
  jumpBy,
  requestSeek,
  skipChapter,
  currentChapter,
} from '@/player/store'
import { getQueueState, subscribeQueue } from '@/player/queue'
import { getProgressState, subscribeProgress } from '@/store/progress'
import { getImmersive, subscribeImmersive, setImmersive } from '@/player/immersive'
import { getActiveClub, subscribeActiveClub } from '@/player/clubSync'
import { getSettingsState, subscribeSettings, COVER_ASPECT_RATIO } from '@/store/settings'
import { useBookmarks } from '@/player/useBookmarks'
import { coverUrl, getItemDetail, getRecentSessions } from '@/api/abs'
import { playItemById } from '@/player/playback'
import { SyncStatusIcon } from '@/player/SyncStatusIcon'
import { getSyncState, subscribeSyncState } from '@/player/syncState'
import { getPendingSessionState, subscribePendingSessions } from '@/player/pendingProgress'
import {
  getDownloadsState,
  subscribeDownloads,
  downloadItem,
  cancelDownload,
  deleteDownload,
} from '@/player/downloads'
import {
  AppText,
  Centered,
  Cover,
  IconButton,
  PrimaryButton,
  Screen,
  Sheet,
  type SheetRef,
  Touchable,
  icons,
} from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { DeviceKindIcon } from '@/ui/DeviceKindIcon'
import { CoverGlow } from '@/ui/CoverGlow'
import { CoverLightbox } from '@/ui/CoverLightbox'
import { useBackHandler, useSheetBackHandler } from '@/ui/useBackHandler'
import { AppTabBar, TAB_BAR_HEIGHT } from '@/ui/AppTabBar'
import { MiniPlayer } from '@/player/MiniPlayer'
import { haptics } from '@/ui/haptics'
import { DUR, SpringPressable } from '@/ui/motion'
import { useToast, Toast } from '@/ui/Toast'
import { radius, spacing, withAlpha, type Palette } from '@/ui/theme'
import { useColors, useTheme, type ActiveTheme } from '@/ui/ThemeProvider'
import { adaptiveContentMaxWidth, adaptivePlayerCoverMaxWidth } from '@/ui/responsive'
import { Scrubber } from '@/player/Scrubber'
import { Marquee } from '@/ui/Marquee'
import { PlayerCoverCarousel } from '@/player/PlayerCoverCarousel'
import { SkipFeedbackOverlay, type SkipFeedbackHandle } from '@/player/SkipFeedbackOverlay'
import { SkipButton } from '@/player/SkipButton'
import {
  ChaptersSheet,
  SpeedSheet,
  SleepSheet,
  BookmarksSheet,
  type SheetHandle,
} from '@/player/sheets'
import { AddToListSheet } from '@/player/AddToListSheet'
import { QueueSheet } from '@/player/QueueSheet'
import { buildActions, type ActionContext } from '@/player/actions'
import { PlayerNotesSheet, type PlayerNotesSheetHandle } from '@/social/PlayerNotesSheet'
import { TimelineMarkers } from '@/social/TimelineMarkers'
import { useTimelineMarkers } from '@/social/useTimelineMarkers'
import type { PlayerActionKey } from '@/store/settings'

const HEARTH_BG = require('../assets/images/hearth-centered.webp')
const INSPECT_HINT_KEY = 'hs.playerInspectHint'

/** "Ch 23 · Career Moves" - unless the title already encodes its number (e.g.
 *  "Chapter 23"), in which case the title alone is enough. */
function formatChapterLabel(title: string, num: number): string {
  const t = title.trim()
  // Title already leads with a chapter number ("Chapter 23", "Ch. 23", "23.").
  if (/^(chapter|ch\.?)\s*\d+\b/i.test(t) || /^\d+[.:) ]/.test(t)) return t
  return `Ch ${num} · ${t}`
}

/**
 * The full player UI. Rendered as the pushed `/player` route (with a collapse
 * button) and inline in the Now Playing tab (`embedded`, no collapse button - the
 * tab bar is the way out).
 */
export function PlayerSurface({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter()
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  const { nowPlaying, isPlaying, position, sleepTimer, rate, carActive } = useSyncExternalStore(
    subscribe,
    getState,
  )
  const queue = useSyncExternalStore(subscribeQueue, getQueueState)
  const settings = useSyncExternalStore(subscribeSettings, getSettingsState)
  const downloads = useSyncExternalStore(subscribeDownloads, getDownloadsState)
  const insets = useSafeAreaInsets()
  const { width, height } = useWindowDimensions()
  const toast = useToast()

  const chaptersRef = useRef<SheetHandle>(null)
  const speedRef = useRef<SheetHandle>(null)
  const sleepRef = useRef<SheetHandle>(null)
  const moreRef = useRef<SheetHandle>(null)
  const recentRef = useRef<SheetHandle>(null)
  const bookmarksRef = useRef<SheetHandle>(null)
  const addToListRef = useRef<SheetHandle>(null)
  const queueRef = useRef<SheetHandle>(null)
  const notesRef = useRef<PlayerNotesSheetHandle>(null)
  const skipFeedbackRef = useRef<SkipFeedbackHandle>(null)

  // Fire a relative skip and flash the accumulating overlay over the cover.
  const skipBy = useCallback((dir: -1 | 1, seconds: number) => {
    skipFeedbackRef.current?.bump(dir, seconds)
    jumpBy(dir * seconds)
  }, [])

  const duration = nowPlaying?.duration ?? 0
  const { bookmarks, addBookmark } = useBookmarks(nowPlaying?.itemId ?? null)

  // The item's libraryId isn't on the play session; fetch it lazily once for
  // Add-to-list (collections/playlists are library-scoped).
  const [libraryId, setLibraryId] = useState<string | null>(null)
  useEffect(() => {
    if (!nowPlaying) return
    let cancelled = false
    getItemDetail(nowPlaying.itemId)
      .then((d) => {
        if (!cancelled) setLibraryId(d.libraryId)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [nowPlaying?.itemId])

  // While dragging the scrubber, preview the target time in the labels without
  // committing a seek (seek fires once, on release - see Scrubber).
  const [previewRatio, setPreviewRatio] = useState<number | null>(null)

  // Carousel deck state: page count, active index, and the browsed book (drives
  // the header title + the deck transport when off the live page).
  type DeckActive = { itemId: string; title: string; author: string; isLive: boolean }
  const [deck, setDeck] = useState<{ count: number; index: number; active: DeckActive | null }>({
    count: 1,
    index: 0,
    active: null,
  })
  const deckJumpRef = useRef<(i: number) => void>(() => {})
  const deckPlayRef = useRef<() => void>(() => {})
  // Continuous fractional page position, driven every frame by the carousel's
  // scroll, so the dots track the finger in sync with the artwork.
  const deckFraction = useSharedValue(0)
  const onDeckChange = useCallback(
    (info: {
      count: number
      index: number
      active: DeckActive
      jumpTo: (i: number) => void
      playActive: () => void
    }) => {
      deckJumpRef.current = info.jumpTo
      deckPlayRef.current = info.playActive
      setDeck((d) =>
        d.count === info.count &&
        d.index === info.index &&
        d.active?.itemId === info.active.itemId
          ? d
          : { count: info.count, index: info.index, active: info.active },
      )
    },
    [],
  )
  const onScrollFraction = useCallback(
    (frac: number) => {
      deckFraction.value = frac
    },
    [deckFraction],
  )

  // Buffering heuristic (no native buffer event yet): while we intend to be
  // playing but the reported position hasn't advanced, we're likely stalled.
  // Surface it only after a grace period so micro-stalls don't flash.
  const buffering = useBuffering(isPlaying, position)

  // Live per-item progress, so the browsed book's deck progress bar updates.
  const progressById = useSyncExternalStore(subscribeProgress, getProgressState).byId

  // One-time "tap to inspect" hint on the cover (device-local), so the
  // inspect-by-default gesture is discoverable. Dismissed on first cover tap or
  // after it has been shown once.
  const [showInspectHint, setShowInspectHint] = useState(false)
  useEffect(() => {
    void AsyncStorage.getItem(INSPECT_HINT_KEY).then((seen) => {
      if (!seen) setShowInspectHint(true)
    })
  }, [])
  const dismissInspectHint = useCallback(() => {
    setShowInspectHint(false)
    void AsyncStorage.setItem(INSPECT_HINT_KEY, '1')
  }, [])

  // Cover taps. Default (FINAL): a single tap INSPECTS - opens the lightbox -
  // since the cover is the largest target and shouldn't be a play/pause
  // hair-trigger. When the user opts into "Tap artwork to play", a single tap
  // toggles play/pause and a double-tap opens the lightbox instead.
  const [lightbox, setLightbox] = useState(false)
  const lastTap = useRef(0)
  const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const tapTogglesPlay = settings.tapArtworkTogglesPlay
  useEffect(
    () => () => {
      if (singleTapTimer.current) clearTimeout(singleTapTimer.current)
    },
    [],
  )
  const onCoverTap = useCallback(() => {
    if (showInspectHint) dismissInspectHint()
    if (!tapTogglesPlay) {
      // Inspect-by-default: single tap opens the lightbox immediately.
      setLightbox(true)
      return
    }
    // Play-on-cover opted in: single tap plays/pauses, double-tap inspects.
    const now = Date.now()
    if (now - lastTap.current < 320) {
      lastTap.current = 0
      if (singleTapTimer.current) {
        clearTimeout(singleTapTimer.current)
        singleTapTimer.current = null
      }
      setLightbox(true)
    } else {
      lastTap.current = now
      // Wait out the double-tap window so a double-tap opens the lightbox
      // without also flipping play/pause.
      if (singleTapTimer.current) clearTimeout(singleTapTimer.current)
      singleTapTimer.current = setTimeout(() => {
        singleTapTimer.current = null
        togglePlay()
      }, 320)
    }
  }, [tapTogglesPlay])

  // Skip hotspots: double-tap the margin beside the artwork to jump by the
  // configured skip amount (like Audible's edge taps). On by default.
  const hotspotTap = useRef(0)
  const onHotspotTap = useCallback(
    (dir: -1 | 1) => {
      const now = Date.now()
      if (now - hotspotTap.current < 320) {
        hotspotTap.current = 0
        const amount = dir < 0 ? getSettingsState().skipBack : getSettingsState().skipForward
        skipBy(dir, amount)
      } else {
        hotspotTap.current = now
      }
    },
    [skipBy],
  )

  // Immersive mode: swipe up on the cover enlarges it and hides the chrome + nav.
  // Kept in a shared store (not local state) so the bottom-tab navigator - which
  // owns the tab bar when the player is embedded in the Now Playing tab - can hide
  // it too. Reset on unmount so leaving the player never strands the nav hidden.
  const immersive = useSyncExternalStore(subscribeImmersive, getImmersive)
  // The club whose current book is playing (if any), for the open-club shortcut.
  const activeClub = useSyncExternalStore(subscribeActiveClub, getActiveClub)
  const showClubButton =
    settings.clubsEnabled && settings.clubPlayerButton && !!activeClub && !immersive
  const enter = useCallback(() => {
    haptics.mode()
    setImmersive(true)
  }, [])
  const exit = useCallback(() => {
    haptics.select()
    setImmersive(false)
  }, [])
  useEffect(() => () => setImmersive(false), [])

  // Hardware back: the open lightbox handles its own back (it takes precedence);
  // otherwise immersive mode exits first. When embedded (the Now Playing tab
  // root) a further back goes Home; the pushed /player route falls through to a
  // normal pop.
  useBackHandler(
    useCallback(() => {
      if (immersive) {
        exit()
        return true
      }
      if (embedded) {
        router.replace('/(tabs)')
        return true
      }
      return false
    }, [immersive, embedded, exit, router]),
    !lightbox,
  )

  // Close any open sheet (Queue, More, Auto rules, ...) before the above runs.
  // Registered after it so it fires first (BackHandler is last-registered-first),
  // and it swallows the press only when a sheet was actually open.
  useSheetBackHandler()

  // Vertical-only so it never steals the horizontal swipe when the cover is a
  // carousel (activeOffsetY makes it wait for clear vertical motion before
  // claiming the gesture; the FlatList keeps horizontal drags).
  const swipe = Gesture.Pan()
    .activeOffsetY([-14, 14])
    .failOffsetX([-16, 16])
    .onEnd((e) => {
      if (e.velocityY < -400) runOnJS(enter)()
      else if (e.velocityY > 400) runOnJS(exit)()
    })

  // The thin whole-book bar eases toward each new position instead of ticking,
  // so progress reads as flowing time. Computed before the no-track early return
  // (hooks must run unconditionally).
  const bookProgress = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0
  // Timeline note markers on the seek bar. Suppressed in immersive/car mode
  // (distraction; the car UI is native anyway). Hook runs unconditionally.
  const timelineMarkers = useTimelineMarkers(
    nowPlaying?.itemId ?? null,
    duration,
    position,
    !immersive,
  )
  const bookBar = useSharedValue(bookProgress)
  useEffect(() => {
    bookBar.value = withTiming(bookProgress, {
      duration: 400,
      easing: Easing.out(Easing.cubic),
    })
  }, [bookProgress, bookBar])
  const bookBarStyle = useAnimatedStyle(() => ({ width: `${bookBar.value * 100}%` }))

  if (!nowPlaying) {
    // In the tab, the Now Playing screen owns the empty state (hearth + resume).
    if (embedded) return null
    return (
      <Screen edges={['top', 'bottom']}>
        <Centered>
          <AppText variant="title">Nothing playing</AppText>
          <PrimaryButton label="Back" onPress={() => router.back()} />
        </Centered>
      </Screen>
    )
  }

  const chapters = nowPlaying.chapters
  const hasChapters = chapters.length > 0
  const chapter = currentChapter()
  const hue = coverHue(nowPlaying.itemId)
  const download = downloads.byId.get(nowPlaying.itemId)

  // Honor the user's Progress bar setting: the main scrubber tracks the current
  // chapter or the whole book. Chapter scope needs chapters to exist; without
  // them it falls back to whole-book.
  const scrubChapter = settings.scrubber === 'chapter' && hasChapters
  const chStart = scrubChapter ? (chapter?.start ?? 0) : 0
  const chEnd = scrubChapter ? (chapter?.end ?? duration) : duration
  const chSpan = Math.max(1, chEnd - chStart)
  const shownPos = previewRatio !== null ? chStart + previewRatio * chSpan : position
  const chPos = Math.max(0, shownPos - chStart)
  const chRatio = scrubChapter
    ? Math.min(1, chPos / chSpan)
    : Math.min(1, Math.max(0, shownPos / Math.max(1, duration)))
  const elapsedLabel = formatTimestamp(scrubChapter ? chPos : shownPos)
  const remainLabel = formatTimestamp(
    Math.max(0, scrubChapter ? chSpan - chPos : duration - shownPos),
  )
  const chapterLabel = scrubChapter ? chapter?.title : undefined

  const seekToRatio = (r: number) => {
    if (scrubChapter) requestSeek(chStart + r * chSpan)
    else if (duration > 0) requestSeek(r * duration)
  }

  const isBookmarked = bookmarks.some((b) => Math.abs(b.time - position) < 2)
  const onBookmark = async () => {
    if (isBookmarked) {
      toast.show('Already bookmarked here')
      return
    }
    await addBookmark(position, chapter?.title ?? nowPlaying.title)
    toast.show(`Bookmark saved at ${formatTimestamp(position)}`)
  }

  // Sleep action button: label + a 0..1 depletion ratio for the winding-down ring.
  const sleepLabel =
    sleepTimer?.kind === 'duration' || sleepTimer?.kind === 'clock'
      ? formatTimestamp(sleepTimer.remainingSec)
      : sleepTimer?.kind === 'endOfChapter'
        ? 'Chapter'
        : 'Sleep'
  const sleepDepletion =
    sleepTimer?.kind === 'duration' || sleepTimer?.kind === 'clock'
      ? Math.max(0, Math.min(1, sleepTimer.remainingSec / Math.max(1, sleepTimer.totalSec)))
      : null

  // Cover: fill the width (up to a cap), but never taller than the space we have.
  // Honor the cover-shape setting; height = width / aspect, so cap width so the
  // (possibly portrait) cover still fits the available height.
  const coverAspect = COVER_ASPECT_RATIO[settings.coverAspect]
  const coverMaxW = Math.min(width - spacing.xl * 2, adaptivePlayerCoverMaxWidth(width, immersive))
  const coverMaxH = height * (immersive ? 0.62 : 0.52)
  const coverWidth = Math.min(coverMaxW, coverMaxH * coverAspect)
  const contentMaxWidth = adaptiveContentMaxWidth(width)
  const progressRailWidth = Math.max(0, Math.min(width, contentMaxWidth) - spacing.xl * 2)
  // Width of each skip hotspot: the margin from the screen edge to the artwork.
  // The carousel page is inset by the content padding; its side gutters (where
  // the double-tap skip hotspots live) sit beside the centered cover.
  const carouselHotspotWidth = Math.max(0, (width - spacing.xl * 2 - coverWidth) / 2)

  const goToTab = (name: string) => {
    // The player already IS the now-playing surface; tapping that tab is a no-op.
    if (name === 'now') return
    router.dismissAll?.()
    router.replace(name === 'index' ? '/(tabs)' : `/(tabs)/${name}`)
  }

  // Resolve each configurable action to its live icon/label/handler. `present`
  // maps an action key to the sheet (or navigation) that owns it; stubs route
  // through a toast. The arrangement in settings.playerActions decides which of
  // these land on-screen vs. in the tray vs. hidden.
  const presentAction = (key: PlayerActionKey) => {
    switch (key) {
      case 'chapters':
        return chaptersRef.current?.present()
      case 'speed':
        return speedRef.current?.present()
      case 'sleep':
        return sleepRef.current?.present()
      case 'recent':
        return recentRef.current?.present()
      case 'bookmarks':
        return bookmarksRef.current?.present()
      case 'addList':
        return addToListRef.current?.present()
      case 'notes':
        return notesRef.current?.present()
      case 'details':
        router.push(`/item/${nowPlaying.itemId}?from=now`)
        return
    }
  }
  const actionCtx: ActionContext = {
    present: presentAction,
    comingSoon: (label) => toast.show(`${label} coming soon`),
    hasChapters,
    speedLabel: `${rate.toFixed(2).replace(/\.?0+$/, '')}×`,
    sleepLabel,
    sleepActive: sleepTimer !== null,
    sleepDepletion,
    downloaded: download?.status === 'done',
    downloading: download?.status === 'downloading' || download?.status === 'queued',
    onFocusView: enter,
    onDownload: () => {
      if (download?.status === 'done') {
        void deleteDownload(nowPlaying.itemId)
        toast.show('Download removed')
      } else if (download?.status === 'downloading' || download?.status === 'queued') {
        void cancelDownload(nowPlaying.itemId)
        toast.show('Download cancelled')
      } else {
        void downloadItem(nowPlaying.itemId, nowPlaying.title, nowPlaying.author)
        toast.show('Downloading for offline')
      }
    },
  }
  const actionMap = buildActions(actionCtx)
  const onScreenKeys = settings.playerActions
    .filter((a) => a.placement === 'onscreen')
    .map((a) => a.key)
  const trayKeys = settings.playerActions.filter((a) => a.placement === 'tray').map((a) => a.key)
  // Show More whenever anything isn't on-screen: the tray needs it to reach its
  // actions, and even with an empty tray it's the player-side door to the button
  // editor (via "Edit buttons"), so a fully-hidden set can still be recovered.
  const showMore = onScreenKeys.length < settings.playerActions.length
  const iconOnly = settings.playerActionsIconOnly

  // Browsing an up-next book (off the live page): the transport swaps to the
  // deck set (that book's read-only progress + a big Play that switches to it);
  // the mini player keeps the playing book controllable.
  const browsing = !immersive && deck.index > 0 && deck.active != null && !deck.active.isLive
  const browsedItemId = browsing ? (deck.active?.itemId ?? null) : null
  const browsedRec = browsedItemId ? progressById.get(browsedItemId) : undefined
  const browsedProgress = browsedRec?.progress ?? 0
  const browsedFinished = browsedRec?.isFinished === true
  // Time left = whole book minus the saved position (both from the progress
  // store, no fetch). Only meaningful once started.
  const browsedLeftSec =
    browsedRec && browsedRec.duration > 0
      ? Math.max(0, browsedRec.duration - browsedRec.currentTime)
      : null

  // Chapter the browsed book was left on. Chapters aren't in the progress store,
  // so fetch them lazily - only when the deck SETTLES on a started book (a short
  // debounce, so a fling doesn't fire a fetch per page), cached per item.
  const [browsedChapter, setBrowsedChapter] = useState<{
    id: string
    title: string
    num: number
    total: number
  } | null>(null)
  const chapterCache = useRef<Map<string, { title: string; start: number; end: number }[]>>(
    new Map(),
  )
  useEffect(() => {
    if (!browsedItemId || !browsedRec || browsedRec.isFinished || (browsedRec.currentTime ?? 0) <= 0) {
      setBrowsedChapter(null)
      return
    }
    const id = browsedItemId
    const at = browsedRec.currentTime
    const pick = (chs: { title: string; start: number; end: number }[]) => {
      let i = chs.findIndex((ch) => at >= ch.start && at < ch.end)
      if (i < 0) i = chs.length - 1
      const c = chs[i]
      setBrowsedChapter(c ? { id, title: c.title, num: i + 1, total: chs.length } : null)
    }
    const cached = chapterCache.current.get(id)
    if (cached) {
      pick(cached)
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      getItemDetail(id)
        .then((d) => {
          if (cancelled) return
          const chs = d.media.chapters ?? []
          chapterCache.current.set(id, chs)
          pick(chs)
        })
        .catch(() => {})
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [browsedItemId, browsedRec])

  return (
    <Screen edges={immersive ? ['top', 'bottom'] : ['top']}>
      {/* Player background, per the playerBg setting. Blurred cover gets a light
          scrim fading it into the scaffold near the controls; gradient mode is the
          breathing cover-hue glow on the bare scaffold; hearth art shows on its
          own with no scrim so the picture stays fully visible. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {settings.playerBg === 'blurred' && nowPlaying.artworkUrl ? (
          <>
            <Image
              source={{ uri: nowPlaying.artworkUrl }}
              style={StyleSheet.absoluteFill}
              blurRadius={40}
            />
            <LinearGradient
              colors={[
                withAlpha(colors.scaffold, 0.18),
                withAlpha(colors.scaffold, 0.5),
                colors.scaffold,
              ]}
              locations={[0, 0.62, 1]}
              style={StyleSheet.absoluteFill}
            />
          </>
        ) : null}
        {settings.playerBg === 'hearth' ? (
          <Image source={HEARTH_BG} style={styles.hearthBg} resizeMode="cover" />
        ) : null}
        {settings.playerBg === 'gradient' ? <CoverGlow hue={hue} height={430} breathe /> : null}
      </View>

      {/* Focus view: a visible X to leave (swipe-down still works). */}
      {immersive && (
        <Animated.View
          entering={FadeIn.duration(DUR.base)}
          exiting={FadeOut.duration(DUR.fast)}
          style={styles.focusExit}
        >
          <IconButton name={icons.close} size={24} color={colors.textMuted} onPress={exit} />
        </Animated.View>
      )}

      {!immersive && (
        <Animated.View entering={FadeIn.duration(DUR.base)} exiting={FadeOut.duration(DUR.fast)}>
          {/* Header, three zones: [queue count] · [title/author or back-to-live]
              · [focus + sync]. The center carries the now-playing identity
              (marquees if long) and becomes the return-home action when browsed
              into the deck, so the cover keeps its full size below. */}
          <View style={styles.header}>
            {/* Left: queue chip (icon + count) opening the Queue sheet. */}
            <Touchable style={styles.queueChip} onPress={() => queueRef.current?.present()}>
              <Icon name={icons.queue} size={16} color={colors.accent} />
              <AppText variant="caption" style={{ fontWeight: '700' }}>
                {queue.items.length}
              </AppText>
            </Touchable>

            {/* Center: the book you're viewing - the playing book at index 0,
                else the browsed up-next book (marquees when long). */}
            <View style={styles.headerCenter}>
              <Marquee>
                <View style={styles.headerTitleRow}>
                  <AppText variant="label" numberOfLines={1} style={styles.headerTitleText}>
                    {deck.active?.title ?? nowPlaying.title}
                  </AppText>
                  <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                    {deck.active?.author ?? nowPlaying.author}
                  </AppText>
                </View>
              </Marquee>
            </View>

            {/* Right: Focus-view entry + passive sync status glyph. */}
            <View style={styles.headerRight}>
              <IconButton
                name={icons.focusView}
                size={22}
                color={colors.textMuted}
                onPress={enter}
              />
              <SyncStatusIcon />
            </View>
          </View>

          {carActive && (
            <View style={styles.carChip}>
              <Icon name={icons.carMode} size={15} color={colors.accent} />
              <AppText variant="caption" color={colors.textMuted}>
                Playing in your car
              </AppText>
            </View>
          )}

          {/* Whole-book progress bar + numeric strip for the PLAYING book. Hidden
              while browsing the deck, where it would misread as the browsed
              book's progress (the mini player carries the playing book instead). */}
          {!browsing && (
            <>
              <View style={[styles.bookBarTrack, { width: progressRailWidth }]}>
                <Animated.View style={[styles.bookBarFill, bookBarStyle]} />
              </View>
              <View
                style={[
                  styles.wholeBookStrip,
                  { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' },
                ]}
              >
                <AppText variant="mono" color={colors.textMuted}>
                  {formatTimestamp(position)}
                </AppText>
                <AppText variant="mono" style={{ fontWeight: '700' }}>
                  {Math.round(bookProgress * 100)}%
                </AppText>
                <AppText variant="mono" color={colors.textMuted}>
                  -{formatTimestamp(Math.max(0, duration - position))}
                </AppText>
              </View>
            </>
          )}
        </Animated.View>
      )}

      {/* Carousel deck-position dots, above the cover per the layout. In normal
          flow here so they can't be clipped by the cover area's overflow. */}
      {!immersive && deck.count > 1 && (
        <DeckDots
          count={deck.count}
          index={deck.index}
          fraction={deckFraction}
          onJump={(i) => deckJumpRef.current(i)}
        />
      )}

      {/* Cover fills the space between header and the pinned controls. The
          cover-tap overlays (bookmark/club) are shared between the plain cover
          and the carousel; skip-hotspots are suppressed in carousel mode since
          the horizontal swipe owns that gesture. */}
      {(() => {
        const coverOverlays = (
          <>
            {!immersive && (
              <IconButton
                name={isBookmarked ? icons.bookmarkFilled : icons.bookmark}
                size={19}
                color="#fff"
                onPress={onBookmark}
                style={styles.bookmarkBtn}
              />
            )}
            {showClubButton && (
              <IconButton
                name={icons.club}
                size={19}
                color="#fff"
                onPress={() => router.push(`/club/${encodeURIComponent(activeClub!.id)}?from=now`)}
                style={styles.clubBtn}
              />
            )}
            {!immersive && showInspectHint && !tapTogglesPlay && (
              <Animated.View
                entering={FadeIn.duration(DUR.base)}
                exiting={FadeOut.duration(DUR.fast)}
                style={styles.inspectHint}
                pointerEvents="none"
              >
                <View style={styles.inspectHintChip}>
                  <Icon name={icons.search} size={13} color="rgba(255,255,255,0.85)" />
                  <AppText variant="caption" color="rgba(255,255,255,0.85)">
                    tap to inspect
                  </AppText>
                </View>
              </Animated.View>
            )}
          </>
        )
        const carouselOn = !immersive
        return (
          <GestureDetector gesture={swipe}>
            <View style={styles.coverArea}>
              {carouselOn ? (
                <PlayerCoverCarousel
                  liveItemId={nowPlaying.itemId}
                  liveTitle={nowPlaying.title}
                  liveAuthor={nowPlaying.author}
                  liveArtworkUrl={nowPlaying.artworkUrl}
                  queue={queue.items}
                  coverWidth={coverWidth}
                  coverAspect={coverAspect}
                  pageWidth={width}
                  overlay={coverOverlays}
                  skipFeedback={<SkipFeedbackOverlay ref={skipFeedbackRef} />}
                  hotspots={
                    // Only on the live page: once you've paged into the deck,
                    // hotspots hide so paging and skipping never fight.
                    settings.skipHotspots && deck.index === 0 && carouselHotspotWidth > 24 ? (
                      <>
                        <Pressable
                          onPress={() => onHotspotTap(-1)}
                          style={[styles.hotspotLeft, { width: carouselHotspotWidth }]}
                          accessibilityLabel={`Skip back ${settings.skipBack} seconds`}
                        />
                        <Pressable
                          onPress={() => onHotspotTap(1)}
                          style={[styles.hotspotRight, { width: carouselHotspotWidth }]}
                          accessibilityLabel={`Skip forward ${settings.skipForward} seconds`}
                        />
                      </>
                    ) : null
                  }
                  onLivePress={onCoverTap}
                  onDeckChange={onDeckChange}
                  onScrollFraction={onScrollFraction}
                />
              ) : (
                // Focus view (immersive): a single large cover, no carousel.
                <Pressable onPress={onCoverTap} style={styles.coverTap}>
                  <Cover
                    uri={nowPlaying.artworkUrl}
                    itemId={nowPlaying.itemId}
                    width={coverWidth}
                    aspectRatio={coverAspect}
                    radius={radius.card}
                    fallback={{
                      hue,
                      initial: nowPlaying.title.charAt(0).toUpperCase(),
                      title: nowPlaying.title,
                    }}
                    style={styles.cover}
                  />
                  <SkipFeedbackOverlay ref={skipFeedbackRef} />
                  {coverOverlays}
                </Pressable>
              )}
            </View>
          </GestureDetector>
        )
      })()}

      {/* Controls pinned to the bottom. Browsing an up-next book swaps in the
          deck transport (that book's progress + a big Play + a keep-controlling
          strip for the playing book); a distinct control set, not the live one
          reconfigured, so layouts stay clean across displays. */}
      <View
        style={[styles.controls, { maxWidth: contentMaxWidth, width: '100%', alignSelf: 'center' }]}
      >
        {browsing && deck.active ? (
          <DeckControls
            title={deck.active.title}
            author={deck.active.author}
            progress={browsedProgress}
            finished={browsedFinished}
            leftSec={browsedLeftSec}
            chapterLabel={
              browsedChapter?.id === deck.active.itemId
                ? formatChapterLabel(browsedChapter.title, browsedChapter.num)
                : null
            }
            onPlay={() => deckPlayRef.current()}
          />
        ) : (
          <>
        {/* Focus view has no header, so it keeps a compact title line here;
            normally the title lives in the header's center zone. */}
        {immersive && (
          <Marquee style={styles.titleLine}>
            <View style={styles.titleRow}>
              <AppText variant="title" numberOfLines={1} style={styles.titleText}>
                {nowPlaying.title}
              </AppText>
              <AppText variant="label" color={colors.textMuted} numberOfLines={1}>
                {nowPlaying.author}
              </AppText>
            </View>
          </Marquee>
        )}

        <View style={styles.scrub}>
          {!immersive && (
            <TimelineMarkers
              markers={timelineMarkers}
              onOpenNote={(timeSec) => notesRef.current?.presentAt(timeSec)}
              onAheadTeaser={(timeSec) =>
                toast.show(`A note awaits at ${formatTimestamp(timeSec)}`)
              }
            />
          )}
          <Scrubber
            ratio={chRatio}
            playing={isPlaying}
            elapsed={elapsedLabel}
            remain={remainLabel}
            chapter={chapterLabel}
            onDrag={setPreviewRatio}
            onSeek={seekToRatio}
          />
        </View>

        {/* In immersive (Car Mode) the chapter-skip buttons drop to a second row
            beneath the play button, leaving the top row an evenly spaced
            rewind / play / forward trio for easy in-car reach. */}
        <View style={[styles.transport, immersive && styles.transportImmersive]}>
          {/* Chapter-prev is gated on chapters existing; the rewind skip button
              always renders (a chapterless book still needs to skip back). */}
          {!immersive ? (
            <>
              {hasChapters ? (
                <TransportBtn icon={icons.skipPrev} ghost onPress={() => skipChapter(-1)} />
              ) : null}
              <SkipButton
                dir={-1}
                seconds={settings.skipBack}
                color={colors.text}
                onPress={() => skipBy(-1, settings.skipBack)}
              />
            </>
          ) : null}
          <View style={styles.playWrap}>
            {buffering && <BufferingRing />}
            <SpringPressable onPress={togglePlay} style={styles.play} scaleTo={0.9}>
              {/* Keyed remount so the pause/play glyph fades in rather than snapping. */}
              <Animated.View
                key={isPlaying ? 'pause' : 'play'}
                entering={FadeIn.duration(DUR.fast)}
              >
                <Icon
                  name={isPlaying ? icons.pause : icons.play}
                  size={44}
                  color={colors.onAccent}
                />
              </Animated.View>
            </SpringPressable>
          </View>
          {!immersive ? (
            <>
              <SkipButton
                dir={1}
                seconds={settings.skipForward}
                color={colors.text}
                onPress={() => skipBy(1, settings.skipForward)}
              />
              {hasChapters ? (
                <TransportBtn icon={icons.skipNext} ghost onPress={() => skipChapter(1)} />
              ) : null}
            </>
          ) : null}
        </View>

        {buffering && (
          <Animated.View entering={FadeIn.duration(DUR.base)} style={styles.bufferCaption}>
            <AppText variant="caption" color={colors.textMuted}>
              Buffering...
            </AppText>
          </Animated.View>
        )}

        {immersive && hasChapters && (
          <Animated.View entering={FadeIn.duration(DUR.base)} style={styles.chapterSkipRow}>
            <TransportBtn icon={icons.skipPrev} onPress={() => skipChapter(-1)} />
            <SkipButton
              dir={-1}
              seconds={settings.skipBack}
              color={colors.text}
              onPress={() => skipBy(-1, settings.skipBack)}
            />
            <SkipButton
              dir={1}
              seconds={settings.skipForward}
              color={colors.text}
              onPress={() => skipBy(1, settings.skipForward)}
            />
            <TransportBtn icon={icons.skipNext} onPress={() => skipChapter(1)} />
          </Animated.View>
        )}

        {!immersive && (
          <Animated.View
            entering={FadeIn.duration(DUR.base)}
            exiting={FadeOut.duration(DUR.fast)}
            style={styles.actionRow}
          >
            {onScreenKeys.map((key) => {
              const a = actionMap[key]
              return (
                <ActionBtn
                  key={key}
                  icon={a.icon}
                  label={a.label}
                  iconOnly={iconOnly}
                  disabled={a.disabled}
                  active={a.active}
                  depletion={a.depletion}
                  onPress={a.onPress}
                />
              )
            })}
            {showMore && (
              <ActionBtn
                icon={icons.more}
                label="More"
                iconOnly={iconOnly}
                onPress={() => moreRef.current?.present()}
              />
            )}
          </Animated.View>
        )}
          </>
        )}
      </View>

      {/* While browsing the deck, dock the real mini player so the playing book
          stays controllable (swipe to skip, tap the transport). It sits just
          above the tab bar (pushed route) or the screen bottom (embedded). */}
      {browsing && (
        <MiniPlayer bottomOffset={embedded ? insets.bottom : insets.bottom + TAB_BAR_HEIGHT} />
      )}

      {/* Nav stays visible unless immersive. */}
      {/* The pushed route shows its own tab bar; embedded, the real tab bar is
          already there (the Now Playing tab), so don't double it. */}
      {!immersive && !embedded && (
        <Animated.View entering={FadeIn.duration(DUR.base)} exiting={FadeOut.duration(DUR.fast)}>
          <AppTabBar activeName="now" onPressTab={goToTab} />
        </Animated.View>
      )}

      <CoverLightbox
        visible={lightbox}
        uri={nowPlaying.artworkUrl}
        title={nowPlaying.title}
        author={nowPlaying.author}
        hue={hue}
        onClose={() => setLightbox(false)}
      />

      <Toast message={toast.message} />

      <ChaptersSheet ref={chaptersRef} />
      <SpeedSheet ref={speedRef} />
      <SleepSheet
        ref={sleepRef}
        onEditBehavior={() => {
          sleepRef.current?.dismiss()
          router.push('/settings/sleep')
        }}
      />
      <QueueSheet
        ref={queueRef}
        onJump={async (itemId) => {
          const saved = getProgressState().byId.get(itemId)
          await playItemById(itemId)
          if (!saved?.isFinished && (saved?.currentTime ?? 0) > 0) requestSeek(saved!.currentTime)
          router.replace('/player')
        }}
      />
      <MoreSheet
        ref={moreRef}
        actions={trayKeys.map((k) => {
          const a = actionMap[k]
          // Surface a live-state badge on the tiles worth glancing at.
          const badge =
            k === 'bookmarks'
              ? bookmarks.length
              : k === 'notes'
                ? timelineMarkers.length
                : undefined
          return { ...a, badge }
        })}
        onSettings={() => {
          moreRef.current?.dismiss()
          router.push('/settings/playback')
        }}
        onEdit={() => {
          moreRef.current?.dismiss()
          router.push('/settings/player-buttons')
        }}
      />
      <RecentSheet
        ref={recentRef}
        itemId={nowPlaying.itemId}
        chapters={chapters}
        onSeek={requestSeek}
      />
      <BookmarksSheet ref={bookmarksRef} itemId={nowPlaying.itemId} onSeek={requestSeek} />
      <PlayerNotesSheet ref={notesRef} onToast={(msg) => toast.show(msg)} />
      {libraryId && (
        <AddToListSheet
          ref={addToListRef}
          libraryId={libraryId}
          libraryItemId={nowPlaying.itemId}
          onAdded={(msg) => toast.show(msg)}
        />
      )}
    </Screen>
  )
}

/**
 * Buffering heuristic. There's no native buffer event, so infer a stall: while
 * `playing` is true, if the reported `position` stops advancing for longer than
 * a grace period, treat it as buffering. Any position change (or a pause)
 * clears it immediately, so this only lights up during a genuine stall.
 */
const BUFFER_GRACE_MS = 400
function useBuffering(playing: boolean, position: number): boolean {
  const [buffering, setBuffering] = useState(false)
  const lastPos = useRef(position)
  const lastMovedAt = useRef(Date.now())

  useEffect(() => {
    if (position !== lastPos.current) {
      lastPos.current = position
      lastMovedAt.current = Date.now()
      if (buffering) setBuffering(false)
    }
  }, [position, buffering])

  useEffect(() => {
    if (!playing) {
      setBuffering(false)
      return
    }
    // Poll while playing; flip to buffering once the position has been static
    // past the grace window.
    const t = setInterval(() => {
      const stalledFor = Date.now() - lastMovedAt.current
      setBuffering(stalledFor > BUFFER_GRACE_MS)
    }, 200)
    return () => clearInterval(t)
  }, [playing])

  return playing && buffering
}

/** The pushed `/player` route: the full surface with a collapse button. */
export default function PlayerScreen() {
  return <PlayerSurface />
}

/**
 * Deck-position dots as a scrolling track under a fixed center pointer: all dots
 * ride a track that slides so the active dot always sits under the accent
 * pointer at the viewport's center. Paging feels like turning a wheel past a
 * fixed marker (not a static set reshuffling), and the whole track stays one
 * line regardless of deck size. Tap anywhere on a dot to jump to it.
 */
const DOT_PITCH = 16 // per-dot spacing (dot + gap)
const DOT_VIEWPORT = 9 * DOT_PITCH // visible width (~9 dots)
function DeckDots({
  count,
  index,
  fraction,
  onJump,
}: {
  count: number
  index: number
  /** Live fractional page position (0..count-1), driving the track in sync
   *  with the finger; falls back toward `index` when idle. */
  fraction: SharedValue<number>
  onJump: (i: number) => void
}) {
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  // Translate the track so the LIVE fractional position sits under the center
  // pointer - so the dots slide continuously with the artwork, not on settle.
  const trackStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: DOT_VIEWPORT / 2 - (fraction.value + 0.5) * DOT_PITCH }],
  }))
  return (
    <View style={styles.deckDotsViewport}>
      {/* Fixed accent pointer at the center; the track scrolls under it. */}
      <View style={styles.deckPointer} pointerEvents="none" />
      <Animated.View style={[styles.deckTrack, trackStyle]}>
        {Array.from({ length: count }).map((_, i) => {
          const dist = Math.abs(i - index)
          // Fade dots as they get farther from the pointer so the ends trail off.
          const opacity = dist === 0 ? 0.15 : Math.max(0.18, 0.55 - dist * 0.09)
          return (
            <Pressable
              key={i}
              onPress={() => onJump(i)}
              hitSlop={{ top: 10, bottom: 10, left: 2, right: 2 }}
              style={styles.deckDotSlot}
            >
              <View
                style={[styles.deckDot, { backgroundColor: withAlpha(colors.text, opacity) }]}
              />
            </Pressable>
          )
        })}
      </Animated.View>
    </View>
  )
}

/**
 * Deck transport: shown while browsing an up-next book. The browsed book's
 * read-only whole-book progress + a big Play that switches to it. The playing
 * book stays controllable via the real mini player docked below (rendered by
 * the player while browsing).
 */
function DeckControls({
  title,
  author,
  progress,
  finished,
  leftSec,
  chapterLabel,
  onPlay,
}: {
  title: string
  author: string
  progress: number
  finished: boolean
  /** Seconds left in the book (null if not started / unknown). */
  leftSec: number | null
  /** Chapter left off on, e.g. "Ch 23 · Career Moves" (null until fetched). */
  chapterLabel: string | null
  onPlay: () => void
}) {
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100)
  const started = pct > 0 && !finished
  // Status line under the bar: for an in-progress book, the chapter left off on
  // and time remaining; otherwise a simple Finished / Not started.
  const statusRight = finished
    ? 'Finished'
    : started && leftSec != null
      ? `${formatDuration(leftSec)} left`
      : 'Not started'
  return (
    <Animated.View entering={FadeIn.duration(DUR.fast)}>
      {/* Browsed book: title + read-only progress bar. */}
      <View style={styles.deckMeta}>
        <AppText variant="title" numberOfLines={1} style={styles.deckTitle}>
          {title}
        </AppText>
        <AppText variant="label" color={colors.textMuted} numberOfLines={1}>
          {author}
        </AppText>
      </View>
      <View style={styles.deckProgRow}>
        <View style={styles.deckProgTrack}>
          <View style={[styles.deckProgFill, { width: `${pct}%` }]} />
        </View>
        <AppText variant="caption" color={colors.textMuted}>
          {statusRight}
        </AppText>
      </View>
      {started && chapterLabel ? (
        <AppText
          variant="caption"
          color={colors.textMuted}
          numberOfLines={1}
          style={styles.deckChapter}
        >
          Left off in {chapterLabel}
        </AppText>
      ) : null}

      {/* Big Play switches to this book. */}
      <View style={styles.deckPlayRow}>
        <SpringPressable onPress={onPlay} style={styles.play} scaleTo={0.9}>
          <Icon name={finished ? icons.replay : icons.play} size={40} color={colors.onAccent} />
        </SpringPressable>
      </View>
      <AppText variant="caption" color={colors.textMuted} style={styles.deckPlayHint}>
        {finished ? 'Listen again' : started ? 'Resume this book' : 'Start this book'}
      </AppText>
    </Animated.View>
  )
}

/** A thin accent ring that spins around the play button while buffering. */
function BufferingRing() {
  const { colors } = useTheme()
  const spin = useSharedValue(0)
  useEffect(() => {
    spin.value = withRepeat(withTiming(1, { duration: 900, easing: Easing.linear }), -1, false)
    return () => cancelAnimation(spin)
  }, [spin])
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${spin.value * 360}deg` }] }))
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          width: 96,
          height: 96,
          borderRadius: 48,
          borderWidth: 2.5,
          borderColor: withAlpha(colors.accent, 0.25),
          borderTopColor: colors.accent,
        },
        style,
      ]}
    />
  )
}

/** A borderless, tappable transport button (rewind / skip / forward). Chapter
 *  prev/next pass `ghost` to render muted, separating them from the always-on
 *  skip buttons. */
function TransportBtn({
  icon,
  onPress,
  ghost,
}: {
  icon: (typeof icons)[keyof typeof icons]
  onPress: () => void
  ghost?: boolean
}) {
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  return (
    <SpringPressable onPress={onPress} hitSlop={10} style={styles.transportBtn} scaleTo={0.85}>
      <Icon name={icon} size={ghost ? 30 : 34} color={ghost ? colors.textMuted : colors.text} />
    </SpringPressable>
  )
}

function ActionBtn({
  icon,
  label,
  onPress,
  disabled,
  active,
  depletion,
  iconOnly,
}: {
  icon: (typeof icons)[keyof typeof icons]
  label: string
  onPress: () => void
  disabled?: boolean
  active?: boolean
  /** 0..1 remaining fraction for the sleep timer's winding-down bar. */
  depletion?: number | null
  /** Drop the label to fit more buttons per row (the "Icon only" setting). */
  iconOnly?: boolean
}) {
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  // A running duration/clock sleep timer turns the whole button into a
  // countdown bar: an accent-tinted fill drains left-to-right behind the
  // content, and in icon-only mode the label (a time like "12:34") stands in
  // for the icon so the compact button still shows the countdown.
  const showCountdown = active && depletion != null
  return (
    <SpringPressable
      style={[
        styles.actionBtn,
        iconOnly && styles.actionBtnIconOnly,
        active && styles.actionBtnActive,
        disabled && { opacity: 0.35 },
      ]}
      scaleTo={0.94}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
    >
      {showCountdown && (
        <View
          pointerEvents="none"
          style={[styles.actionBtnFill, { width: `${(depletion ?? 0) * 100}%` }]}
        />
      )}
      {showCountdown && iconOnly ? (
        <AppText color={colors.accent} numberOfLines={1} style={styles.actionBtnCountdown}>
          {label}
        </AppText>
      ) : (
        <Icon name={icon} size={21} color={active ? colors.accent : colors.text} />
      )}
      {!iconOnly && (
        <AppText
          variant="caption"
          color={active ? colors.accent : colors.textMuted}
          numberOfLines={1}
        >
          {label}
        </AppText>
      )}
    </SpringPressable>
  )
}

// ---- More sheet ----

const MoreSheet = forwardRef<
  SheetHandle,
  {
    /** The tray-placed action descriptors, already resolved by the player. */
    actions: {
      key: PlayerActionKey
      icon: (typeof icons)[keyof typeof icons]
      label: string
      disabled?: boolean
      active?: boolean
      /** A live-state badge count (e.g. saved bookmarks / notes threads). */
      badge?: number
      onPress: () => void
    }[]
    onSettings: () => void
    onEdit: () => void
  }
>(function MoreSheet({ actions, onSettings, onEdit }, ref) {
  const colors = useColors()
  const moreStyles = useMemo(() => makeMoreStyles(colors), [colors])
  const sheetRef = useRef<SheetRef>(null)
  useImperativeHandle(ref, () => ({
    present: () => sheetRef.current?.present(),
    dismiss: () => sheetRef.current?.dismiss(),
  }))

  return (
    <Sheet ref={sheetRef} title="More">
      {/* A 3-across grid of one-tap launch tiles for the tray actions (reads by
          icon, packs into the thumb arc, mirrors the on-screen action row). */}
      <View style={moreStyles.grid}>
        {actions.map((a) => (
          <SpringPressable
            key={a.key}
            style={[moreStyles.tile, a.disabled && { opacity: 0.35 }, a.active && moreStyles.tileActive]}
            scaleTo={0.94}
            onPress={
              a.disabled
                ? undefined
                : () => {
                    sheetRef.current?.dismiss()
                    a.onPress()
                  }
            }
            disabled={a.disabled}
          >
            {a.badge != null && a.badge > 0 ? (
              <View style={moreStyles.badge}>
                <AppText variant="caption" color={colors.onAccent} style={moreStyles.badgeText}>
                  {a.badge}
                </AppText>
              </View>
            ) : null}
            <Icon name={a.icon} size={24} color={a.active ? colors.accent : colors.text} />
            <AppText
              variant="caption"
              numberOfLines={1}
              color={a.active ? colors.accent : colors.textMuted}
            >
              {a.label}
            </AppText>
          </SpringPressable>
        ))}
      </View>

      {/* Pinned rows (a different category from the launch grid: they carry a
          chevron into a sub-surface). */}
      <View style={moreStyles.divider} />
      <Touchable style={moreStyles.row} onPress={onSettings}>
        <Icon name={icons.tune} size={22} color={colors.accent} />
        <AppText variant="label" style={{ flex: 1 }}>
          Player settings
        </AppText>
        <Icon name={icons.chevronRight} size={20} color={colors.textMuted} />
      </Touchable>
      <Touchable style={moreStyles.row} onPress={onEdit}>
        <Icon name={icons.dragHandle} size={22} color={colors.textMuted} />
        <AppText variant="label" style={{ flex: 1 }} color={colors.textMuted}>
          Edit these buttons
        </AppText>
        <Icon name={icons.chevronRight} size={20} color={colors.textMuted} />
      </Touchable>
    </Sheet>
  )
})

const makeMoreStyles = (colors: Palette) =>
  StyleSheet.create({
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.sm,
    },
    tile: {
      // Three per row: (100% - 2 gaps) / 3.
      width: '31.5%',
      aspectRatio: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      borderRadius: radius.card,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    tileActive: { backgroundColor: colors.accentWash, borderColor: colors.accent },
    badge: {
      position: 'absolute',
      top: 8,
      right: 8,
      minWidth: 18,
      height: 18,
      paddingHorizontal: 5,
      borderRadius: 9,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeText: { fontSize: 10, fontWeight: '700', lineHeight: 15 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
    },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.hairline,
      marginTop: spacing.lg,
      marginBottom: spacing.sm,
    },
  })

// ---- Recent sessions sheet ----

interface RecentSession {
  id: string
  startTime: number
  currentTime: number
  timeListening: number
  startedAt: number
  deviceInfo?: ABSDeviceInfo
}

/** A unified Recent Listens row: the live "Now" session, a local unsynced
 *  session, or a confirmed server session. `synced` drives the green/orange
 *  accent so the list doubles as a sync dashboard. */
interface RecentRow {
  key: string
  kind: 'live' | 'pending' | 'server'
  synced: boolean
  offline: boolean
  startedAt: number
  startTime: number
  currentTime: number
  timeListening: number
  deviceInfo?: ABSDeviceInfo
}

const RecentSheet = forwardRef<
  SheetHandle,
  {
    itemId: string
    chapters: { title: string; start: number; end: number }[]
    onSeek: (sec: number) => void
  }
>(function RecentSheet({ itemId, chapters, onSeek }, ref) {
  const colors = useColors()
  const recentStyles = useMemo(() => makeRecentStyles(colors), [colors])
  const sheetRef = useRef<SheetRef>(null)
  const [sessions, setSessions] = useState<RecentSession[] | null>(null)
  const [open, setOpen] = useState(false)

  // Live sync state (drives the pinned "Now" row + which rows read as unsynced).
  const sync = useSyncExternalStore(subscribeSyncState, getSyncState)
  const pending = useSyncExternalStore(subscribePendingSessions, getPendingSessionState).byId
  // Tick once a second while the sheet is open so the live row counts up.
  const [, force] = useState(0)
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [open])

  const load = useCallback(() => {
    getRecentSessions()
      .then((all) => setSessions(all.filter((s) => s.libraryItemId === itemId)))
      .catch(() => setSessions([]))
  }, [itemId])

  // Re-fetch every time the sheet opens - sessions grow while you listen (and a
  // new one starts after the sleep timer stops), so a stale mount-time fetch
  // would miss them until the whole player was torn down and rebuilt.
  useImperativeHandle(ref, () => ({
    present: () => {
      setSessions(null)
      setOpen(true)
      load()
      sheetRef.current?.present()
    },
    dismiss: () => sheetRef.current?.dismiss(),
  }))

  useEffect(() => {
    load()
  }, [load])

  // Match the main player's time display: in chapter mode the Recent Listens
  // timecodes read chapter-relative (e.g. 3:12 into Chapter 8), not book-overall.
  const settings = useSyncExternalStore(subscribeSettings, getSettingsState)
  const chapterMode = settings.scrubber === 'chapter' && chapters.length > 0

  const chapterAt = (sec: number) => chapters.find((ch) => sec >= ch.start && sec < ch.end) ?? null

  // Position to show for a book-overall second: chapter-relative in chapter mode
  // (offset from that second's chapter start), otherwise the raw book position.
  const shownPos = (sec: number) => {
    if (!chapterMode) return sec
    const c = chapterAt(sec)
    return c ? sec - c.start : sec
  }

  // Unified, sync-aware row list: the live "Now" session (in progress), any local
  // sessions not yet on the server (orange = unsynced), then the server's
  // confirmed sessions (green = synced), newest first.
  const rows: RecentRow[] = useMemo(() => {
    const out: RecentRow[] = []
    const live = sync.live
    if (live && live.itemId === itemId) {
      out.push({
        key: 'live',
        kind: 'live',
        synced: sync.status === 'synced',
        offline: sync.status === 'failed',
        startedAt: live.startedAt,
        startTime: live.startTime,
        currentTime: live.currentTime,
        timeListening: live.timeListening,
      })
    }
    const localForItem = pending.get(itemId)
    if (localForItem) {
      out.push({
        key: 'pending',
        kind: 'pending',
        synced: false,
        offline: true,
        startedAt: localForItem.startedAt,
        startTime: Math.max(0, localForItem.currentTime - localForItem.timeListening),
        currentTime: localForItem.currentTime,
        timeListening: localForItem.timeListening,
      })
    }
    for (const s of sessions ?? []) {
      out.push({
        key: s.id,
        kind: 'server',
        synced: true,
        offline: false,
        startedAt: s.startedAt,
        startTime: s.startTime,
        currentTime: s.currentTime,
        timeListening: s.timeListening,
        deviceInfo: s.deviceInfo,
      })
    }
    return out
  }, [sync, pending, sessions, itemId])

  return (
    <Sheet ref={sheetRef} kicker="Recent Listens" snapPoints={['60%']}>
      {!sessions && rows.length === 0 ? (
        <AppText variant="meta" color={colors.textMuted}>
          Loading...
        </AppText>
      ) : rows.length === 0 ? (
        <AppText
          variant="meta"
          color={colors.textMuted}
          style={{ textAlign: 'center', paddingVertical: spacing.xl }}
        >
          You haven't listened to this book yet.
        </AppText>
      ) : (
        <BottomSheetScrollView showsVerticalScrollIndicator={false}>
          {rows.map((r) => {
            const startCh = chapterAt(r.startTime)?.title ?? null
            const endCh = chapterAt(r.currentTime)?.title ?? null
            // Green once confirmed on the server; ember while unsynced/in-progress.
            const accent = r.synced ? colors.success : colors.accent
            const live = r.kind === 'live'
            const started = new Date(r.startedAt)
            const jump = (sec: number) => {
              onSeek(sec)
              sheetRef.current?.dismiss()
            }
            return (
              <Touchable
                key={r.key}
                style={[recentStyles.row, live && recentStyles.liveRow]}
                // Tapping the row picks up where this session ENDED (the natural
                // "keep going" spot). The two timecodes below jump to either end.
                onPress={() => jump(r.currentTime)}
              >
                <View style={{ flex: 1, gap: 3 }}>
                  <View style={recentStyles.durationRow}>
                    {/* Confirmed server rows show which device recorded them
                        (Apple/Android/Car/Web); the accent tint doubles as sync
                        status. Live/pending rows stay on a cloud glyph so the
                        row reads as an in-flight sync rather than a device. */}
                    {r.kind === 'server' ? (
                      <DeviceKindIcon deviceInfo={r.deviceInfo} size={15} color={accent} />
                    ) : (
                      <Icon
                        name={
                          r.offline ? icons.cloudOff : r.synced ? icons.cloudDone : icons.cloudQueue
                        }
                        size={15}
                        color={accent}
                      />
                    )}
                    <AppText variant="label" color={accent}>
                      {formatTimestamp(r.timeListening)} listened
                    </AppText>
                    <AppText variant="caption" color={colors.textMuted}>
                      {live
                        ? `Now · started ${started.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
                        : r.kind === 'pending'
                          ? 'Not synced yet'
                          : started.toLocaleDateString()}
                    </AppText>
                  </View>
                  {/* Display-only span; the row's single primary tap resumes at
                      the end, and the overflow offers jump-to-start. */}
                  <View style={recentStyles.timecodeRow}>
                    <AppText variant="mono" color={colors.textMuted}>
                      {formatTimestamp(shownPos(r.startTime))} {'→ '}
                    </AppText>
                    <AppText variant="mono" color={accent}>
                      {formatTimestamp(shownPos(r.currentTime))}
                    </AppText>
                  </View>
                  {(startCh || endCh) && (
                    <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                      {startCh && endCh && startCh !== endCh
                        ? `${startCh} → ${endCh}`
                        : (endCh ?? startCh)}
                    </AppText>
                  )}
                </View>
                {!live && (
                  <Touchable
                    hitSlop={8}
                    style={recentStyles.jumpStart}
                    onPress={() => jump(r.startTime)}
                  >
                    <Icon name={icons.skipPrev} size={16} color={colors.textMuted} />
                    <AppText variant="caption" color={colors.textMuted}>
                      Start
                    </AppText>
                  </Touchable>
                )}
                {!live && <Icon name={icons.play} size={20} color={accent} />}
              </Touchable>
            )
          })}
        </BottomSheetScrollView>
      )}
    </Sheet>
  )
})

const makeRecentStyles = (colors: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    liveRow: {
      backgroundColor: colors.accentWash,
      borderRadius: radius.card,
      paddingHorizontal: spacing.md,
      borderBottomWidth: 0,
      marginBottom: spacing.xs,
    },
    durationRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    timecodeRow: { flexDirection: 'row', alignItems: 'center' },
    jumpStart: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  })

const makeStyles = (colors: Palette, shadow: ActiveTheme['shadow']) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    // Center zone flexes to fill between the queue chip and the right controls;
    // its Marquee clips + scrolls a long title/author within this width.
    headerCenter: { flex: 1, minWidth: 0, alignItems: 'center' },
    headerTitleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6 },
    headerTitleText: { fontWeight: '700' },
    headerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    // Floating back-to-now-playing button, anchored just above the controls.
    focusExit: {
      alignItems: 'flex-end',
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
    },
    // Fixed-width viewport; the dot track scrolls under a centered pointer.
    deckDotsViewport: {
      width: DOT_VIEWPORT,
      height: 16,
      alignSelf: 'center',
      marginVertical: spacing.sm,
      overflow: 'hidden',
      justifyContent: 'center',
    },
    // The accent pointer: a fixed pill at the viewport center (the "arrow" the
    // dots scroll past).
    deckPointer: {
      position: 'absolute',
      alignSelf: 'center',
      width: 16,
      height: 8,
      borderRadius: 4,
      backgroundColor: colors.accent,
      zIndex: 1,
    },
    deckTrack: {
      position: 'absolute',
      left: 0,
      flexDirection: 'row',
      alignItems: 'center',
    },
    // Each dot occupies one pitch so the track's math (index * pitch) lines up.
    deckDotSlot: { width: DOT_PITCH, height: 16, alignItems: 'center', justifyContent: 'center' },
    deckDot: { width: 7, height: 7, borderRadius: 3.5 },
    carChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      alignSelf: 'center',
      marginBottom: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: colors.accentWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accent,
    },
    bookBarTrack: {
      height: 2,
      alignSelf: 'center',
      borderRadius: 1,
      backgroundColor: colors.fillStrong,
      overflow: 'hidden',
    },
    bookBarFill: { height: 2, borderRadius: 1, backgroundColor: colors.accent },
    wholeBookStrip: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.xl,
      marginTop: 6,
    },
    coverArea: {
      flex: 1,
      // minHeight:0 lets this flex child actually shrink below its content size
      // (RN flex children default to minHeight:auto and refuse to shrink), and
      // overflow:hidden clips a cover that's still taller than the space left
      // after the controls - so the artwork can never bleed down over the title.
      // coverMaxH bounds the cover to a fraction of screen height, but on a short
      // screen the real flex space is less than that fraction; this keeps the
      // overlap from happening regardless of device.
      minHeight: 0,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
      // No horizontal padding: the carousel spans the full screen width so the
      // neighbor covers peek to the true edges. The centered cover is capped at
      // coverWidth, and Focus view's single cover is likewise well within the
      // screen, so neither needs page padding here.
    },
    // Full-strength art, shown on its own with no scrim over it.
    hearthBg: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
    coverTap: { position: 'relative' },
    // Skip hotspots fill the margins beside the artwork (edge to cover). Top/
    // bottom are inset so they don't overlap the header or the controls.
    hotspotLeft: { position: 'absolute', left: 0, top: 0, bottom: 0 },
    hotspotRight: { position: 'absolute', right: 0, top: 0, bottom: 0 },
    cover: { backgroundColor: colors.high },
    bookmarkBtn: {
      position: 'absolute',
      top: 10,
      right: 10,
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: 'rgba(20,17,15,0.5)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    clubBtn: {
      position: 'absolute',
      top: 10,
      left: 10,
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: 'rgba(20,17,15,0.5)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    // One-time "tap to inspect" hint chip, bottom-center of the cover. The
    // absolute wrapper spans the cover width so the chip centers within it.
    inspectHint: {
      position: 'absolute',
      bottom: 10,
      left: 0,
      right: 0,
      flexDirection: 'row',
      justifyContent: 'center',
    },
    inspectHintChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: spacing.md,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: 'rgba(20,17,15,0.7)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.14)',
    },
    controls: {
      paddingHorizontal: spacing.xl,
      paddingBottom: spacing.lg,
    },
    // ---- Deck (browsed up-next book) transport ----
    deckMeta: { alignItems: 'center', marginTop: spacing.sm },
    deckTitle: { textAlign: 'center' },
    deckProgRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    deckProgTrack: {
      flex: 1,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.fillStrong,
      overflow: 'hidden',
    },
    deckProgFill: { height: '100%', borderRadius: 3, backgroundColor: colors.accent },
    deckChapter: { textAlign: 'center', marginTop: spacing.sm },
    deckPlayRow: { alignItems: 'center', marginTop: spacing.lg },
    // Leave room below the Play hint for the docked mini player.
    deckPlayHint: { textAlign: 'center', marginTop: spacing.sm, marginBottom: 72 },
    // One-line title/author (marquees when long); the marquee wrapper owns the
    // width so the row can overflow and scroll.
    titleLine: { marginTop: spacing.xs },
    titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
    titleText: {
      textShadowColor: 'rgba(0,0,0,0.85)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 4,
    },
    queueChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: spacing.md - 2,
      paddingVertical: 7,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    scrub: { width: '100%', marginTop: spacing.md },
    transport: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      alignSelf: 'stretch',
      paddingHorizontal: spacing.lg,
      marginTop: spacing.md,
    },
    transportImmersive: {
      justifyContent: 'center',
      gap: spacing.xl,
    },
    chapterSkipRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: spacing.xl * 2,
      marginTop: spacing.md,
    },
    transportBtn: {
      width: 60,
      height: 60,
      alignItems: 'center',
      justifyContent: 'center',
    },
    playWrap: { alignItems: 'center', justifyContent: 'center' },
    bufferCaption: { alignItems: 'center', marginTop: spacing.sm },
    play: {
      width: 84,
      height: 84,
      borderRadius: 42,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      // Accent-tinted drop shadow for real height. iOS honors the color + blur;
      // Android renders a soft shadow from elevation (its color is tinted on API28+
      // by shadowColor, plain dark below - either way it reads as a lift).
      ...shadow.accentLift,
    },
    pressed: { opacity: 0.6 },
    actionRow: {
      flexDirection: 'row',
      alignSelf: 'stretch',
      gap: spacing.sm,
      marginTop: spacing.lg,
      // Sit above the play button's accent glow so the shadow doesn't bleed onto
      // these buttons (Android draws by elevation; iOS by zIndex).
      elevation: 16,
      zIndex: 2,
    },
    actionBtn: {
      flex: 1,
      minHeight: 52,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 3,
      paddingVertical: spacing.sm,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.fill,
      // Clip the sleep-timer countdown fill to the rounded button shape.
      overflow: 'hidden',
    },
    actionBtnIconOnly: { paddingVertical: spacing.md },
    actionBtnActive: { backgroundColor: colors.accentWash, borderColor: colors.accent },
    // The whole-button sleep countdown fill: an accent wash draining left-to-right.
    actionBtnFill: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      backgroundColor: withAlpha(colors.accent, 0.15),
    },
    actionBtnCountdown: { fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  })
