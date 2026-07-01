/**
 * Full-screen now-playing view. Rebuilt against the WebApp's MobilePlayer.tsx
 * (the real, fleshed-out mobile player) for behavior, and the design system's
 * "now playing updates" commit (283f2895) for the HearthShelf visual language:
 * a centered header, a portrait cover with a real bookmark toggle and a
 * double-tap lightbox, a chapter-relative Hearth Pill scrubber, a 5-action row,
 * and an up-next peek bar backed by a real queue.
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
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
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
  icons,
} from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { CoverGlow } from '@/ui/CoverGlow'
import { useToast, Toast } from '@/ui/Toast'
import { colors, radius, spacing } from '@/ui/theme'
import { Scrubber } from '@/player/Scrubber'
import { ChaptersSheet, SpeedSheet, SleepSheet, type SheetHandle } from '@/player/sheets'
import { AddToListSheet } from '@/player/AddToListSheet'
import { QueueSheet } from '@/player/QueueSheet'

export default function PlayerScreen() {
  const router = useRouter()
  const { nowPlaying, isPlaying, position, sleepTimer, rate } = useSyncExternalStore(
    subscribe,
    getState
  )
  const queue = useSyncExternalStore(subscribeQueue, getQueueState)
  const { width } = useWindowDimensions()
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

  // Car mode: swipe up on the cover enlarges it + simplifies the controls.
  const [carMode, setCarMode] = useState(false)
  const enter = useCallback(() => setCarMode(true), [])
  const exit = useCallback(() => setCarMode(false), [])
  const coverY = useSharedValue(0)

  const swipe = Gesture.Pan().onEnd((e) => {
    if (e.velocityY < -400) {
      coverY.value = withTiming(0)
      runOnJS(enter)()
    } else if (e.velocityY > 400) {
      runOnJS(exit)()
    }
  })
  const coverStyle = useAnimatedStyle(() => ({ transform: [{ translateY: coverY.value }] }))

  if (!nowPlaying) {
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

  // Chapter-relative scrubber (matches the WebApp's onChapter model): position/
  // remaining are relative to the current chapter, not the whole book.
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

  const sleepLabel =
    sleepTimer?.kind === 'duration' || sleepTimer?.kind === 'clock'
      ? formatTimestamp(sleepTimer.remainingSec)
      : sleepTimer?.kind === 'endOfChapter'
        ? 'EOC'
        : 'Sleep'

  const hasNext = queue.mode !== 'off' && queue.items.length > 0
  const next = queue.items[0]

  const jumpToQueued = async (itemId: string) => {
    await playItemById(itemId)
    router.replace('/player')
  }

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={StyleSheet.absoluteFill}>
        <CoverGlow hue={hue} height={430} />
      </View>

      {!carMode && (
        <>
          <View style={styles.header}>
            <IconButton name={icons.collapse} size={28} onPress={() => router.back()} />
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

      <View style={styles.body}>
        <GestureDetector gesture={swipe}>
          <Animated.View
            style={[styles.coverWrap, carMode && styles.coverWrapCar, coverStyle]}
          >
            <Pressable onPress={onCoverTap} style={styles.coverTap}>
              <Cover
                uri={nowPlaying.artworkUrl}
                width={carMode ? Math.min(320, width - 80) : Math.min(280, width - 96)}
                aspectRatio={carMode ? 1 : 3 / 4}
                radius={radius.card}
                fallback={{ hue, initial: nowPlaying.title.charAt(0).toUpperCase(), title: nowPlaying.title }}
                style={styles.cover}
              />
              {!carMode && (
                <IconButton
                  name={isBookmarked ? icons.bookmarkFilled : icons.bookmark}
                  size={19}
                  color="#fff"
                  onPress={onBookmark}
                  style={styles.bookmarkBtn}
                />
              )}
            </Pressable>
          </Animated.View>
        </GestureDetector>

        <AppText variant="hero" numberOfLines={2} style={styles.title}>
          {nowPlaying.title}
        </AppText>
        <AppText variant="label" color={colors.textMuted} numberOfLines={1}>
          {nowPlaying.author}
        </AppText>

        {!carMode && (
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
        )}

        <View style={[styles.transport, carMode && styles.transportCar]}>
          {hasChapters ? (
            <IconButton name={icons.skipPrev} size={carMode ? 40 : 32} onPress={() => skipChapter(-1)} />
          ) : null}
          <IconButton name={icons.rewind} size={carMode ? 44 : 34} onPress={() => jumpBy(-15)} />
          <IconButton
            name={isPlaying ? icons.pause : icons.play}
            size={carMode ? 56 : 44}
            color={colors.onAccent}
            onPress={togglePlay}
            style={[styles.play, carMode && styles.playCar]}
          />
          <IconButton name={icons.forward} size={carMode ? 44 : 34} onPress={() => jumpBy(30)} />
          {hasChapters ? (
            <IconButton name={icons.skipNext} size={carMode ? 40 : 32} onPress={() => skipChapter(1)} />
          ) : null}
        </View>

        {!carMode && (
          <View style={styles.actionRow}>
            <ActionBtn
              icon={icons.chapters}
              label="Chapters"
              disabled={!hasChapters}
              onPress={() => chaptersRef.current?.present()}
            />
            <ActionBtn icon={icons.speed} label={`${rate.toFixed(2).replace(/\.?0+$/, '')}×`} onPress={() => speedRef.current?.present()} />
            <ActionBtn
              icon={icons.sleep}
              label={sleepLabel}
              active={sleepTimer !== null}
              onPress={() => sleepRef.current?.present()}
            />
            <ActionBtn icon={icons.recent} label="Recent" onPress={() => recentRef.current?.present()} />
            <ActionBtn icon={icons.more} label="More" onPress={() => moreRef.current?.present()} />
          </View>
        )}

        {carMode && (
          <View style={styles.carActions}>
            <Pressable style={styles.carAction} onPress={() => speedRef.current?.present()}>
              <Icon name={icons.speed} size={30} color={colors.textMuted} />
              <AppText variant="mono" color={colors.textMuted}>
                {rate.toFixed(2).replace(/\.?0+$/, '')}×
              </AppText>
            </Pressable>
            <Pressable style={styles.carAction} onPress={onBookmark}>
              <Icon name={icons.bookmark} size={30} color={colors.textMuted} />
              <AppText variant="caption" color={colors.textMuted}>
                Bookmark
              </AppText>
            </Pressable>
          </View>
        )}
      </View>

      {!carMode && (
        <Pressable style={styles.upNext} onPress={() => queueRef.current?.present()}>
          <Cover
            uri={next ? coverUrl(next.libraryItemId) : undefined}
            size={40}
            radius={9}
            fallback={
              next
                ? { hue: coverHue(next.libraryItemId), initial: next.title.charAt(0).toUpperCase() }
                : { hue: colors.elevated, initial: '' }
            }
          />
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="eyebrow">{hasNext ? 'Up next' : 'Queue off'}</AppText>
            <AppText variant="label" numberOfLines={1} style={{ marginTop: 2 }}>
              {hasNext ? next.title : 'Stops after this book'}
            </AppText>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
            <AppText variant="mono" color={colors.textMuted}>
              {hasNext ? `${queue.items.length} queued` : 'Off'}
            </AppText>
            <Icon name={icons.expandLess} size={20} color={colors.textMuted} />
          </View>
        </Pressable>
      )}

      {lightbox && (
        <Pressable style={styles.lightbox} onPress={() => setLightbox(false)}>
          <IconButton
            name={icons.close}
            size={24}
            color="#fff"
            onPress={() => setLightbox(false)}
            style={styles.lightboxClose}
          />
          <Cover
            uri={nowPlaying.artworkUrl}
            width={Math.min(300, width * 0.84)}
            aspectRatio={3 / 4}
            radius={16}
            fallback={{ hue, initial: nowPlaying.title.charAt(0).toUpperCase(), title: nowPlaying.title }}
          />
          <Text style={styles.lightboxTitle}>{nowPlaying.title}</Text>
          <Text style={styles.lightboxAuthor}>{nowPlaying.author}</Text>
        </Pressable>
      )}

      <Toast message={toast.message} />

      <ChaptersSheet ref={chaptersRef} />
      <SpeedSheet ref={speedRef} />
      <SleepSheet ref={sleepRef} />
      <QueueSheet ref={queueRef} onJump={jumpToQueued} />
      <MoreSheet
        ref={moreRef}
        itemId={nowPlaying.itemId}
        onAddToList={() => addToListRef.current?.present()}
        onCarMode={enter}
      />
      <RecentSheet ref={recentRef} itemId={nowPlaying.itemId} onSeek={requestSeek} />
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

function ActionBtn({
  icon,
  label,
  onPress,
  disabled,
  active,
}: {
  icon: (typeof icons)[keyof typeof icons]
  label: string
  onPress: () => void
  disabled?: boolean
  active?: boolean
}) {
  return (
    <Pressable
      style={[styles.actionBtn, active && styles.actionBtnActive, disabled && { opacity: 0.35 }]}
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
    >
      <Icon name={icon} size={21} color={active ? colors.accent : colors.text} />
      <AppText variant="caption" color={active ? colors.accent : colors.textMuted} numberOfLines={1}>
        {label}
      </AppText>
    </Pressable>
  )
}

// ---- More sheet ----

const MoreSheet = forwardRef<
  SheetHandle,
  { itemId: string; onAddToList: () => void; onCarMode: () => void }
>(function MoreSheet({ itemId, onAddToList, onCarMode }, ref) {
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
      icon: icons.car,
      label: 'Car mode',
      onPress: () => {
        sheetRef.current?.dismiss()
        onCarMode()
      },
    },
  ]

  return (
    <Sheet ref={sheetRef} title="Player">
      <View>
        {rows.map((r) => (
          <Pressable key={r.label} style={moreStyles.row} onPress={r.onPress}>
            <Icon name={r.icon} size={22} color={colors.accent} />
            <AppText variant="label" style={{ flex: 1 }}>
              {r.label}
            </AppText>
            <Icon name={icons.chevronRight} size={20} color={colors.textMuted} />
          </Pressable>
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

const RecentSheet = forwardRef<SheetHandle, { itemId: string; onSeek: (sec: number) => void }>(
  function RecentSheet({ itemId, onSeek }, ref) {
    const sheetRef = useRef<SheetRef>(null)
    useImperativeHandle(ref, () => ({
      present: () => sheetRef.current?.present(),
      dismiss: () => sheetRef.current?.dismiss(),
    }))
    const [sessions, setSessions] = useState<
      { id: string; startTime: number; currentTime: number; timeListening: number; startedAt: number }[] | null
    >(null)

    const load = useCallback(() => {
      getRecentSessions()
        .then((all) => setSessions(all.filter((s) => s.libraryItemId === itemId)))
        .catch(() => setSessions([]))
    }, [itemId])

    useEffect(() => {
      load()
    }, [load])

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
            {sessions.map((s) => (
              <Pressable
                key={s.id}
                style={recentStyles.row}
                onPress={() => {
                  onSeek(s.startTime)
                  sheetRef.current?.dismiss()
                }}
              >
                <View style={{ flex: 1 }}>
                  <AppText variant="mono">
                    {formatTimestamp(s.startTime)} → {formatTimestamp(s.currentTime)}
                  </AppText>
                  <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
                    {new Date(s.startedAt).toLocaleDateString()} · {formatTimestamp(s.timeListening)}
                  </AppText>
                </View>
                <Icon name={icons.rewind} size={20} color={colors.textMuted} />
              </Pressable>
            ))}
          </View>
        )}
      </Sheet>
    )
  }
)

const recentStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
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
  body: { flex: 1, alignItems: 'center', paddingHorizontal: spacing.xl },
  coverWrap: { marginTop: spacing.md, marginBottom: spacing.lg },
  coverWrapCar: { marginTop: spacing.xxl },
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
  title: { textAlign: 'center', marginTop: spacing.sm },
  scrub: { width: '100%', marginTop: spacing.lg },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    marginTop: spacing.lg,
  },
  transportCar: { marginTop: spacing.xxl, gap: spacing.xl },
  play: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playCar: { width: 84, height: 84, borderRadius: 42 },
  actionRow: {
    flexDirection: 'row',
    alignSelf: 'stretch',
    marginTop: spacing.lg,
  },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderRadius: radius.row,
  },
  actionBtnActive: { backgroundColor: colors.accentWash },
  carActions: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 56,
    marginTop: spacing.lg,
  },
  carAction: { alignItems: 'center', gap: 3 },
  upNext: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.hairline,
    backgroundColor: colors.high,
  },
  lightbox: {
    position: 'absolute',
    inset: 0,
    zIndex: 30,
    backgroundColor: 'rgba(8,7,6,0.94)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xxl,
  },
  lightboxClose: {
    position: 'absolute',
    top: 20,
    right: 20,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  lightboxTitle: { color: colors.text, fontSize: 15, fontWeight: '700', marginTop: spacing.lg },
  lightboxAuthor: { color: colors.textMuted, fontSize: 12.5, marginTop: 4 },
})
