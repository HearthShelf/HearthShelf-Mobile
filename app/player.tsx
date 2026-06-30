/**
 * Full-screen now-playing view, modeled on the web mobile player: large cover,
 * scrubber, big transport, a 4-button toolbar, and bottom sheets for chapters /
 * speed / sleep. A swipe-up on the cover enters a stripped-down "car mode".
 * Drives the same player store the mini-bar and the car surface read.
 */
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import { Image, PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native'
import { useRouter } from 'expo-router'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated'
import { formatTimestamp } from '@hearthshelf/core'
import {
  getState,
  subscribe,
  togglePlay,
  jumpBy,
  requestSeek,
  skipChapter,
  currentChapter,
} from '@/player/store'
import {
  AppText,
  Centered,
  IconButton,
  PrimaryButton,
  Screen,
  icons,
} from '@/ui/primitives'
import { colors, radius, spacing } from '@/ui/theme'
import { ChaptersSheet, SpeedSheet, SleepSheet, type SheetHandle } from '@/player/sheets'

export default function PlayerScreen() {
  const router = useRouter()
  const { nowPlaying, isPlaying, position, sleepTimer, rate } = useSyncExternalStore(
    subscribe,
    getState
  )

  const chaptersRef = useRef<SheetHandle>(null)
  const speedRef = useRef<SheetHandle>(null)
  const sleepRef = useRef<SheetHandle>(null)

  const trackWidth = useRef(0)
  const duration = nowPlaying?.duration ?? 0

  const seekFromX = (x: number) => {
    if (trackWidth.current <= 0 || duration <= 0) return
    const ratio = Math.min(1, Math.max(0, x / trackWidth.current))
    requestSeek(ratio * duration)
  }
  const seekFromXRef = useRef(seekFromX)
  seekFromXRef.current = seekFromX

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => seekFromXRef.current(e.nativeEvent.locationX),
      onPanResponderMove: (e) => seekFromXRef.current(e.nativeEvent.locationX),
    })
  ).current

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
  const progress = duration > 0 ? Math.min(1, Math.max(0, position / duration)) : 0

  const sleepLabel =
    sleepTimer?.kind === 'duration'
      ? formatTimestamp(sleepTimer.remainingSec)
      : sleepTimer?.kind === 'endOfChapter'
        ? 'EOC'
        : 'Sleep'

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <IconButton name={icons.collapse} size={28} onPress={() => router.back()} />
        <AppText variant="caption" color={colors.textMuted}>
          {carMode ? 'CAR MODE' : 'NOW PLAYING'}
        </AppText>
        <View style={{ width: 28 }} />
      </View>

      <View style={styles.body}>
        <GestureDetector gesture={swipe}>
          <Animated.View style={[styles.coverWrap, carMode && styles.coverWrapCar, coverStyle]}>
            {nowPlaying.artworkUrl ? (
              <Image
                source={{ uri: nowPlaying.artworkUrl }}
                style={[styles.cover, carMode && styles.coverCar]}
              />
            ) : (
              <View style={[styles.cover, carMode && styles.coverCar]} />
            )}
          </Animated.View>
        </GestureDetector>

        <AppText variant="hero" numberOfLines={2} style={styles.title}>
          {nowPlaying.title}
        </AppText>
        <AppText variant="label" color={colors.textMuted} numberOfLines={1}>
          {nowPlaying.author}
        </AppText>
        {hasChapters && chapter ? (
          <AppText variant="meta" color={colors.accent} numberOfLines={1} style={{ marginTop: spacing.sm }}>
            {chapter.title}
          </AppText>
        ) : null}

        {!carMode && (
          <>
            <View
              style={styles.track}
              onLayout={(e: LayoutChangeEvent) => {
                trackWidth.current = e.nativeEvent.layout.width
              }}
              {...pan.panHandlers}
            >
              <View style={styles.trackFill} pointerEvents="none">
                <View style={[styles.trackProgress, { width: `${progress * 100}%` }]} />
              </View>
            </View>
            <View style={styles.times}>
              <AppText variant="caption" color={colors.textMuted}>
                {formatTimestamp(position)}
              </AppText>
              <AppText variant="caption" color={colors.textMuted}>
                {formatTimestamp(duration)}
              </AppText>
            </View>
          </>
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
          <View style={styles.toolbar}>
            <ToolbarBtn
              icon={icons.chapters}
              label="Chapters"
              disabled={!hasChapters}
              onPress={() => chaptersRef.current?.present()}
            />
            <ToolbarBtn icon={icons.speed} label={`${rate}x`} onPress={() => speedRef.current?.present()} />
            <ToolbarBtn icon={icons.sleep} label={sleepLabel} onPress={() => sleepRef.current?.present()} />
            <ToolbarBtn icon={icons.nowPlaying} label="Car" onPress={enter} />
          </View>
        )}
      </View>

      <ChaptersSheet ref={chaptersRef} />
      <SpeedSheet ref={speedRef} />
      <SleepSheet ref={sleepRef} />
    </Screen>
  )
}

function ToolbarBtn({
  icon,
  label,
  onPress,
  disabled,
}: {
  icon: (typeof icons)[keyof typeof icons]
  label: string
  onPress: () => void
  disabled?: boolean
}) {
  return (
    <View style={[styles.toolBtn, disabled && { opacity: 0.35 }]}>
      <IconButton name={icon} size={22} color={colors.text} onPress={disabled ? undefined : onPress} />
      <AppText variant="caption" color={colors.textMuted}>
        {label}
      </AppText>
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
  body: { flex: 1, alignItems: 'center', paddingHorizontal: spacing.xl },
  coverWrap: { marginTop: spacing.lg, marginBottom: spacing.xl },
  coverWrapCar: { marginTop: spacing.xxl },
  cover: { width: 260, height: 260, borderRadius: radius.card, backgroundColor: colors.high },
  coverCar: { width: 320, height: 320 },
  title: { textAlign: 'center' },
  track: { width: '100%', height: 28, justifyContent: 'center', marginTop: spacing.xl },
  trackFill: { height: 6, borderRadius: 3, backgroundColor: colors.fillStrong, overflow: 'hidden' },
  trackProgress: { height: 6, backgroundColor: colors.accent },
  times: { width: '100%', flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    marginTop: spacing.xl,
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
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignSelf: 'stretch',
    marginTop: 'auto',
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
  },
  toolBtn: { alignItems: 'center', gap: 2, minWidth: 56 },
})
