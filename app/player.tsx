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
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { Image, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { LinearGradient } from 'expo-linear-gradient'
import { useRouter } from 'expo-router'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { coverHue, formatTimestamp } from '@hearthshelf/core'
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
import { getSettingsState, subscribeSettings, COVER_ASPECT_RATIO } from '@/store/settings'
import { useBookmarks } from '@/player/useBookmarks'
import { coverUrl, getItemDetail, getRecentSessions } from '@/api/abs'
import { playItemById } from '@/player/playback'
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
import { CoverGlow } from '@/ui/CoverGlow'
import { AppTabBar } from '@/ui/AppTabBar'
import { useToast, Toast } from '@/ui/Toast'
import { colors, radius, shadow, spacing } from '@/ui/theme'
import { Scrubber } from '@/player/Scrubber'
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
import type { PlayerActionKey } from '@/store/settings'

/**
 * The full player UI. Rendered as the pushed `/player` route (with a collapse
 * button) and inline in the Now Playing tab (`embedded`, no collapse button - the
 * tab bar is the way out).
 */
export function PlayerSurface({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter()
  const { nowPlaying, isPlaying, position, sleepTimer, rate } = useSyncExternalStore(
    subscribe,
    getState,
  )
  const queue = useSyncExternalStore(subscribeQueue, getQueueState)
  const settings = useSyncExternalStore(subscribeSettings, getSettingsState)
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

  // Double-tap the cover to open the lightbox.
  const [lightbox, setLightbox] = useState(false)
  const lastTap = useRef(0)
  const onCoverTap = useCallback(() => {
    const now = Date.now()
    if (now - lastTap.current < 320) {
      lastTap.current = 0
      setLightbox(true)
    } else {
      lastTap.current = now
    }
  }, [])

  // Immersive mode: swipe up on the cover enlarges it and hides the chrome + nav.
  const [immersive, setImmersive] = useState(false)
  const enter = useCallback(() => setImmersive(true), [])
  const exit = useCallback(() => setImmersive(false), [])

  const swipe = Gesture.Pan().onEnd((e) => {
    if (e.velocityY < -400) runOnJS(enter)()
    else if (e.velocityY > 400) runOnJS(exit)()
  })

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
  const bookProgress = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0
  const hue = coverHue(nowPlaying.itemId)

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
  const coverMaxW = Math.min(width - spacing.xl * 2, immersive ? width - 48 : 360)
  const coverMaxH = height * (immersive ? 0.62 : 0.46)
  const coverWidth = Math.min(coverMaxW, coverMaxH * coverAspect)

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
      case 'details':
        router.push(`/item/${nowPlaying.itemId}`)
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

  return (
    <Screen edges={immersive ? ['top', 'bottom'] : ['top']}>
      {/* Blurred artwork fills the whole player as a dim backdrop, then a gradient
          fades it into the scaffold so the cover, title, and controls stay
          readable. Falls back to the hue glow when there's no artwork. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {nowPlaying.artworkUrl ? (
          <Image
            source={{ uri: nowPlaying.artworkUrl }}
            style={StyleSheet.absoluteFill}
            blurRadius={40}
          />
        ) : null}
        <LinearGradient
          colors={['rgba(27,26,24,0.55)', 'rgba(27,26,24,0.82)', colors.scaffold]}
          locations={[0, 0.55, 1]}
          style={StyleSheet.absoluteFill}
        />
        <CoverGlow hue={hue} height={430} />
      </View>

      {!immersive && (
        <>
          <View style={styles.header}>
            {embedded ? (
              <View style={{ width: 28 }} />
            ) : (
              <IconButton name={icons.collapse} size={28} onPress={() => router.back()} />
            )}
            <View style={{ flex: 1 }} />
            <IconButton name={icons.queue} size={23} onPress={() => queueRef.current?.present()} />
          </View>

          {/* Thin whole-book progress bar sitting above the numeric strip. */}
          <View style={styles.bookBarTrack}>
            <View style={[styles.bookBarFill, { width: `${bookProgress * 100}%` }]} />
          </View>

          <View style={styles.wholeBookStrip}>
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

      {/* Cover fills the space between header and the pinned controls. */}
      <GestureDetector gesture={swipe}>
        <View style={styles.coverArea}>
          <Pressable onPress={onCoverTap} style={styles.coverTap}>
            <Cover
              uri={nowPlaying.artworkUrl}
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
            {!immersive && (
              <IconButton
                name={isBookmarked ? icons.bookmarkFilled : icons.bookmark}
                size={19}
                color="#fff"
                onPress={onBookmark}
                style={styles.bookmarkBtn}
              />
            )}
          </Pressable>
        </View>
      </GestureDetector>

      {/* Controls pinned to the bottom. */}
      <View style={styles.controls}>
        <AppText variant="hero" numberOfLines={1} style={styles.title}>
          {nowPlaying.title}
        </AppText>
        <AppText variant="label" color={colors.textMuted} numberOfLines={1} style={styles.author}>
          {nowPlaying.author}
        </AppText>

        <View style={styles.scrub}>
          <Scrubber
            ratio={chRatio}
            elapsed={elapsedLabel}
            remain={remainLabel}
            chapter={chapterLabel}
            onDrag={setPreviewRatio}
            onSeek={seekToRatio}
          />
        </View>

        <View style={styles.transport}>
          {hasChapters ? (
            <TransportBtn icon={icons.skipPrev} onPress={() => skipChapter(-1)} />
          ) : null}
          <TransportBtn icon={icons.rewind} onPress={() => jumpBy(-15)} />
          <Pressable
            onPress={togglePlay}
            style={({ pressed }) => [styles.play, pressed && styles.pressed]}
          >
            <Icon name={isPlaying ? icons.pause : icons.play} size={44} color={colors.onAccent} />
          </Pressable>
          <TransportBtn icon={icons.forward} onPress={() => jumpBy(30)} />
          {hasChapters ? (
            <TransportBtn icon={icons.skipNext} onPress={() => skipChapter(1)} />
          ) : null}
        </View>

        {!immersive && (
          <View style={styles.actionRow}>
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
          </View>
        )}
      </View>

      {/* Nav stays visible unless immersive. */}
      {/* The pushed route shows its own tab bar; embedded, the real tab bar is
          already there (the Now Playing tab), so don't double it. */}
      {!immersive && !embedded && <AppTabBar activeName="now" onPressTab={goToTab} />}

      {lightbox && (
        <Lightbox
          uri={nowPlaying.artworkUrl}
          title={nowPlaying.title}
          author={nowPlaying.author}
          hue={hue}
          onClose={() => setLightbox(false)}
        />
      )}

      <Toast message={toast.message} />

      <ChaptersSheet ref={chaptersRef} />
      <SpeedSheet ref={speedRef} />
      <SleepSheet
        ref={sleepRef}
        onEditBehavior={() => {
          sleepRef.current?.dismiss()
          router.push('/settings')
        }}
      />
      <QueueSheet
        ref={queueRef}
        onJump={async (itemId) => {
          await playItemById(itemId)
          router.replace('/player')
        }}
      />
      <MoreSheet
        ref={moreRef}
        actions={trayKeys.map((k) => actionMap[k])}
        onImmersive={enter}
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

/** The pushed `/player` route: the full surface with a collapse button. */
export default function PlayerScreen() {
  return <PlayerSurface />
}

/** A borderless, tappable transport button (rewind / skip / forward). */
function TransportBtn({
  icon,
  onPress,
}: {
  icon: (typeof icons)[keyof typeof icons]
  onPress: () => void
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => [styles.transportBtn, pressed && styles.pressed]}
    >
      <Icon name={icon} size={34} color={colors.text} />
    </Pressable>
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
  return (
    <Pressable
      style={({ pressed }) => [
        styles.actionBtn,
        iconOnly && styles.actionBtnIconOnly,
        active && styles.actionBtnActive,
        disabled && { opacity: 0.35 },
        pressed && styles.pressed,
      ]}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
    >
      <Icon name={icon} size={21} color={active ? colors.accent : colors.text} />
      {!iconOnly && (
        <AppText
          variant="caption"
          color={active ? colors.accent : colors.textMuted}
          numberOfLines={1}
        >
          {label}
        </AppText>
      )}
      {active && depletion != null && !iconOnly && (
        <View style={styles.depletionTrack}>
          <View style={[styles.depletionFill, { width: `${depletion * 100}%` }]} />
        </View>
      )}
    </Pressable>
  )
}

// ---- Lightbox (full, pinch-zoomable artwork) ----

function Lightbox({
  uri,
  title,
  author,
  hue,
  onClose,
}: {
  uri?: string
  title: string
  author: string
  hue: string
  onClose: () => void
}) {
  const { width, height } = useWindowDimensions()
  const insets = useSafeAreaInsets()
  const scale = useSharedValue(1)
  const savedScale = useSharedValue(1)
  const tx = useSharedValue(0)
  const ty = useSharedValue(0)
  const savedTx = useSharedValue(0)
  const savedTy = useSharedValue(0)

  const pinch = Gesture.Pinch()
    .onUpdate((e) => {
      scale.value = Math.max(1, Math.min(4, savedScale.value * e.scale))
    })
    .onEnd(() => {
      savedScale.value = scale.value
      if (scale.value <= 1) {
        scale.value = withTiming(1)
        tx.value = withTiming(0)
        ty.value = withTiming(0)
        savedTx.value = 0
        savedTy.value = 0
      }
    })
  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (scale.value <= 1) return
      tx.value = savedTx.value + e.translationX
      ty.value = savedTy.value + e.translationY
    })
    .onEnd(() => {
      savedTx.value = tx.value
      savedTy.value = ty.value
    })
  const doubleTap = Gesture.Tap()
    .numberOfTaps(2)
    .onEnd(() => {
      const next = scale.value > 1 ? 1 : 2
      scale.value = withTiming(next)
      savedScale.value = next
      if (next === 1) {
        tx.value = withTiming(0)
        ty.value = withTiming(0)
        savedTx.value = 0
        savedTy.value = 0
      }
    })
  const gesture = Gesture.Simultaneous(pinch, pan, doubleTap)

  const imgStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: tx.value }, { translateY: ty.value }, { scale: scale.value }],
  }))

  return (
    <View style={styles.lightbox}>
      <IconButton
        name={icons.close}
        size={24}
        color="#fff"
        onPress={onClose}
        style={[styles.lightboxClose, { top: insets.top + 12 }]}
      />
      <GestureDetector gesture={gesture}>
        <Animated.View style={[styles.lightboxImgWrap, imgStyle]}>
          {uri ? (
            // Full uncropped artwork (contain) so nothing is cut off.
            <Image
              source={{ uri }}
              style={{ width: width, height: height * 0.7 }}
              resizeMode="contain"
            />
          ) : (
            <Cover
              width={Math.min(320, width * 0.84)}
              aspectRatio={1}
              radius={16}
              fallback={{ hue, initial: title.charAt(0).toUpperCase(), title }}
            />
          )}
        </Animated.View>
      </GestureDetector>
      <View style={styles.lightboxMeta} pointerEvents="none">
        <Text style={styles.lightboxTitle}>{title}</Text>
        <Text style={styles.lightboxAuthor}>{author}</Text>
      </View>
    </View>
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
      onPress: () => void
    }[]
    onImmersive: () => void
    onEdit: () => void
  }
>(function MoreSheet({ actions, onImmersive, onEdit }, ref) {
  const sheetRef = useRef<SheetRef>(null)
  useImperativeHandle(ref, () => ({
    present: () => sheetRef.current?.present(),
    dismiss: () => sheetRef.current?.dismiss(),
  }))

  return (
    <Sheet ref={sheetRef} title="Player">
      <View>
        {actions.map((a) => (
          <Touchable
            key={a.key}
            style={[moreStyles.row, a.disabled && { opacity: 0.35 }]}
            onPress={
              a.disabled
                ? undefined
                : () => {
                    sheetRef.current?.dismiss()
                    a.onPress()
                  }
            }
          >
            <Icon name={a.icon} size={22} color={colors.accent} />
            <AppText
              variant="label"
              style={{ flex: 1 }}
              color={a.active ? colors.accent : colors.text}
            >
              {a.label}
            </AppText>
            <Icon name={icons.chevronRight} size={20} color={colors.textMuted} />
          </Touchable>
        ))}

        <Touchable
          style={moreStyles.row}
          onPress={() => {
            sheetRef.current?.dismiss()
            onImmersive()
          }}
        >
          <Icon name={icons.expandLess} size={22} color={colors.accent} />
          <AppText variant="label" style={{ flex: 1 }}>
            Immersive mode
          </AppText>
          <Icon name={icons.chevronRight} size={20} color={colors.textMuted} />
        </Touchable>

        <View style={moreStyles.divider} />
        <Touchable style={moreStyles.row} onPress={onEdit}>
          <Icon name={icons.tune} size={22} color={colors.textMuted} />
          <AppText variant="label" style={{ flex: 1 }} color={colors.textMuted}>
            Edit buttons
          </AppText>
          <Icon name={icons.chevronRight} size={20} color={colors.textMuted} />
        </Touchable>
      </View>
    </Sheet>
  )
})

const moreStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.hairline,
    marginVertical: spacing.sm,
  },
})

// ---- Recent sessions sheet ----

interface RecentSession {
  id: string
  startTime: number
  currentTime: number
  timeListening: number
  startedAt: number
}

const RecentSheet = forwardRef<
  SheetHandle,
  {
    itemId: string
    chapters: { title: string; start: number; end: number }[]
    onSeek: (sec: number) => void
  }
>(function RecentSheet({ itemId, chapters, onSeek }, ref) {
  const sheetRef = useRef<SheetRef>(null)
  const [sessions, setSessions] = useState<RecentSession[] | null>(null)

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
      load()
      sheetRef.current?.present()
    },
    dismiss: () => sheetRef.current?.dismiss(),
  }))

  useEffect(() => {
    load()
  }, [load])

  const chapterAt = (sec: number): string | null => {
    const c = chapters.find((ch) => sec >= ch.start && sec < ch.end)
    return c?.title ?? null
  }

  return (
    <Sheet ref={sheetRef} kicker="Recent listens" snapPoints={['60%']}>
      {!sessions ? (
        <AppText variant="meta" color={colors.textMuted}>
          Loading...
        </AppText>
      ) : sessions.length === 0 ? (
        <AppText
          variant="meta"
          color={colors.textMuted}
          style={{ textAlign: 'center', paddingVertical: spacing.xl }}
        >
          You haven't listened to this book yet.
        </AppText>
      ) : (
        <View>
          {sessions.map((s) => {
            const startCh = chapterAt(s.startTime)
            const endCh = chapterAt(s.currentTime)
            return (
              <Touchable
                key={s.id}
                style={recentStyles.row}
                onPress={() => {
                  onSeek(s.startTime)
                  sheetRef.current?.dismiss()
                }}
              >
                <View style={{ flex: 1, gap: 3 }}>
                  <View style={recentStyles.durationRow}>
                    <Icon name={icons.schedule} size={15} color={colors.accent} />
                    <AppText variant="label" color={colors.accent}>
                      {formatTimestamp(s.timeListening)} listened
                    </AppText>
                    <AppText variant="caption" color={colors.textMuted}>
                      {new Date(s.startedAt).toLocaleDateString()}
                    </AppText>
                  </View>
                  <AppText variant="mono" color={colors.textMuted}>
                    {formatTimestamp(s.startTime)} → {formatTimestamp(s.currentTime)}
                  </AppText>
                  {(startCh || endCh) && (
                    <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                      {startCh && endCh && startCh !== endCh
                        ? `${startCh} → ${endCh}`
                        : (endCh ?? startCh)}
                    </AppText>
                  )}
                </View>
                <Icon name={icons.play} size={20} color={colors.textMuted} />
              </Touchable>
            )
          })}
        </View>
      )}
    </Sheet>
  )
})

const recentStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
  durationRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
})

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  bookBarTrack: {
    height: 2,
    marginHorizontal: spacing.xl,
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
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
  },
  coverTap: { position: 'relative' },
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
  controls: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.md,
  },
  title: { textAlign: 'center' },
  author: { textAlign: 'center', marginTop: 2 },
  scrub: { width: '100%', marginTop: spacing.md },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  transportBtn: {
    width: 56,
    height: 56,
    alignItems: 'center',
    justifyContent: 'center',
  },
  play: {
    width: 76,
    height: 76,
    borderRadius: 38,
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
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.fill,
  },
  actionBtnIconOnly: { paddingVertical: spacing.md },
  actionBtnActive: { backgroundColor: colors.accentWash, borderColor: colors.accent },
  depletionTrack: {
    width: '70%',
    height: 3,
    borderRadius: 3,
    backgroundColor: colors.fillStrong,
    overflow: 'hidden',
  },
  depletionFill: { height: 3, borderRadius: 3, backgroundColor: colors.accent },
  lightbox: {
    position: 'absolute',
    inset: 0,
    zIndex: 30,
    backgroundColor: 'rgba(8,7,6,0.96)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lightboxImgWrap: { alignItems: 'center', justifyContent: 'center' },
  lightboxClose: {
    position: 'absolute',
    right: 20,
    zIndex: 2,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lightboxMeta: { position: 'absolute', bottom: 60, alignItems: 'center' },
  lightboxTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  lightboxAuthor: { color: colors.textMuted, fontSize: 12.5, marginTop: 4 },
})
