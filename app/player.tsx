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
import { useRouter } from 'expo-router'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
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
import { ChaptersSheet, SpeedSheet, SleepSheet, type SheetHandle } from '@/player/sheets'
import { AddToListSheet } from '@/player/AddToListSheet'
import { QueueSheet } from '@/player/QueueSheet'

/**
 * The full player UI. Rendered as the pushed `/player` route (with a collapse
 * button) and inline in the Now Playing tab (`embedded`, no collapse button - the
 * tab bar is the way out).
 */
export function PlayerSurface({ embedded = false }: { embedded?: boolean }) {
  const router = useRouter()
  const { nowPlaying, isPlaying, position, sleepTimer, rate } = useSyncExternalStore(
    subscribe,
    getState
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
  const chapterIdx = hasChapters ? chapters.findIndex((c) => c === chapter) : -1
  const bookProgress = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0
  const hue = coverHue(nowPlaying.itemId)

  // Chapter-relative scrubber: position/remaining are relative to the current
  // chapter, not the whole book.
  const chStart = chapter?.start ?? 0
  const chEnd = chapter?.end ?? duration
  const chSpan = Math.max(1, chEnd - chStart)
  const shownPos = previewRatio !== null ? chStart + previewRatio * chSpan : position
  const chPos = Math.max(0, shownPos - chStart)
  const chRatio = hasChapters ? Math.min(1, chPos / chSpan) : bookProgress
  const elapsedLabel = formatTimestamp(hasChapters ? chPos : shownPos)
  const remainLabel = formatTimestamp(
    Math.max(0, hasChapters ? chSpan - chPos : duration - shownPos)
  )
  const chapterLabel = hasChapters
    ? `Ch ${chapterIdx + 1}/${chapters.length} · ${chapter?.title}`
    : undefined

  const seekToRatio = (r: number) => {
    if (hasChapters) requestSeek(chStart + r * chSpan)
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

  return (
    <Screen edges={immersive ? ['top', 'bottom'] : ['top']}>
      <View style={StyleSheet.absoluteFill}>
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
            <View style={{ flex: 1, alignItems: 'center' }}>
              <AppText variant="eyebrow">Now playing</AppText>
              <AppText variant="caption" numberOfLines={1} style={{ marginTop: 2, opacity: 0.8 }}>
                HearthShelf{chapter ? ` · ${chapter.title}` : ''}
              </AppText>
            </View>
            <IconButton name={icons.queue} size={23} onPress={() => queueRef.current?.present()} />
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
              fallback={{ hue, initial: nowPlaying.title.charAt(0).toUpperCase(), title: nowPlaying.title }}
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
            playing={isPlaying}
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
          <Pressable onPress={togglePlay} style={({ pressed }) => [styles.play, pressed && styles.pressed]}>
            <Icon name={isPlaying ? icons.pause : icons.play} size={44} color={colors.onAccent} />
          </Pressable>
          <TransportBtn icon={icons.forward} onPress={() => jumpBy(30)} />
          {hasChapters ? (
            <TransportBtn icon={icons.skipNext} onPress={() => skipChapter(1)} />
          ) : null}
        </View>

        {!immersive && (
          <View style={styles.actionRow}>
            <ActionBtn
              icon={icons.chapters}
              label="Chapters"
              disabled={!hasChapters}
              onPress={() => chaptersRef.current?.present()}
            />
            <ActionBtn
              icon={icons.speed}
              label={`${rate.toFixed(2).replace(/\.?0+$/, '')}×`}
              onPress={() => speedRef.current?.present()}
            />
            <ActionBtn
              icon={icons.sleep}
              label={sleepLabel}
              active={sleepTimer !== null}
              depletion={sleepDepletion}
              onPress={() => sleepRef.current?.present()}
            />
            <ActionBtn icon={icons.recent} label="Recent" onPress={() => recentRef.current?.present()} />
            <ActionBtn icon={icons.more} label="More" onPress={() => moreRef.current?.present()} />
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
      <SleepSheet ref={sleepRef} />
      <QueueSheet
        ref={queueRef}
        onJump={async (itemId) => {
          await playItemById(itemId)
          router.replace('/player')
        }}
      />
      <MoreSheet
        ref={moreRef}
        itemId={nowPlaying.itemId}
        onAddToList={() => addToListRef.current?.present()}
        onImmersive={enter}
      />
      <RecentSheet ref={recentRef} itemId={nowPlaying.itemId} chapters={chapters} onSeek={requestSeek} />
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
function TransportBtn({ icon, onPress }: { icon: (typeof icons)[keyof typeof icons]; onPress: () => void }) {
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
}: {
  icon: (typeof icons)[keyof typeof icons]
  label: string
  onPress: () => void
  disabled?: boolean
  active?: boolean
  /** 0..1 remaining fraction for the sleep timer's winding-down bar. */
  depletion?: number | null
}) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.actionBtn,
        active && styles.actionBtnActive,
        disabled && { opacity: 0.35 },
        pressed && styles.pressed,
      ]}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
    >
      <Icon name={icon} size={21} color={active ? colors.accent : colors.text} />
      <AppText variant="caption" color={active ? colors.accent : colors.textMuted} numberOfLines={1}>
        {label}
      </AppText>
      {active && depletion != null && (
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
        style={styles.lightboxClose}
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
  { itemId: string; onAddToList: () => void; onImmersive: () => void }
>(function MoreSheet({ itemId, onAddToList, onImmersive }, ref) {
  const router = useRouter()
  const sheetRef = useRef<SheetRef>(null)
  useImperativeHandle(ref, () => ({
    present: () => sheetRef.current?.present(),
    dismiss: () => sheetRef.current?.dismiss(),
  }))

  const rows: { icon: (typeof icons)[keyof typeof icons]; label: string; onPress: () => void }[] = [
    {
      icon: icons.info,
      label: 'Book details',
      onPress: () => {
        sheetRef.current?.dismiss()
        router.push(`/item/${itemId}`)
      },
    },
    {
      icon: icons.addList,
      label: 'Add to list',
      onPress: () => {
        sheetRef.current?.dismiss()
        onAddToList()
      },
    },
    {
      icon: icons.expandLess,
      label: 'Immersive mode',
      onPress: () => {
        sheetRef.current?.dismiss()
        onImmersive()
      },
    },
  ]

  return (
    <Sheet ref={sheetRef} title="Player">
      <View>
        {rows.map((r) => (
          <Touchable key={r.label} style={moreStyles.row} onPress={r.onPress}>
            <Icon name={r.icon} size={22} color={colors.accent} />
            <AppText variant="label" style={{ flex: 1 }}>
              {r.label}
            </AppText>
            <Icon name={icons.chevronRight} size={20} color={colors.textMuted} />
          </Touchable>
        ))}
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
  { itemId: string; chapters: { title: string; start: number; end: number }[]; onSeek: (sec: number) => void }
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
    <Sheet ref={sheetRef} title="Recent listens" snapPoints={['60%']}>
      {!sessions ? (
        <AppText variant="meta" color={colors.textMuted}>
          Loading...
        </AppText>
      ) : sessions.length === 0 ? (
        <AppText variant="meta" color={colors.textMuted} style={{ textAlign: 'center', paddingVertical: spacing.xl }}>
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
  wholeBookStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    marginTop: 2,
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
    top: 20,
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
