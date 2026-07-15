/**
 * Floating mini-player, docked just above the bottom tab bar app-wide. Mirrors
 * the web `.playbar` mobile treatment: rounded card, cover + title + progress,
 * tap to open the full player. Reads the same store the car drives.
 */
import { useMemo, useState, useSyncExternalStore } from 'react'
import { Image, Pressable, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeInUp, FadeOut, runOnJS } from 'react-native-reanimated'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Svg, { Circle } from 'react-native-svg'
import { useRouter } from 'expo-router'
import { formatTimestamp } from '@hearthshelf/core'
import { AppText, icons } from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { CoverDownloadOverlay } from '@/ui/CoverDownloadOverlay'
import { SkipButton } from '@/player/SkipButton'
import { DUR, SpringPressable } from '@/ui/motion'
import { haptics } from '@/ui/haptics'
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { getState, subscribe, togglePlay, jumpBy, currentChapter } from './store'

/** Rendered height of the docked bar (progress strip + 42px row + padding),
 *  for content-inset math in useContentInset. */
export const MINI_PLAYER_HEIGHT = 60

export function MiniPlayer({ bottomOffset = 0 }: { bottomOffset?: number }) {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { nowPlaying, isPlaying, position } = useSyncExternalStore(subscribe, getState)
  const settings = useSyncExternalStore(subscribeSettings, getSettingsState)
  if (!nowPlaying) return null

  // Honor the user's Progress bar setting (chapter vs. whole book). Chapter scope
  // needs chapters to exist; without them it falls back to whole-book.
  const chapter = currentChapter()
  const useChapter = settings.scrubber === 'chapter' && nowPlaying.chapters.length > 0
  const chStart = chapter?.start ?? 0
  const chEnd = chapter?.end ?? nowPlaying.duration
  const chSpan = Math.max(1, chEnd - chStart)
  const chPos = Math.max(0, position - chStart)

  const progress = useChapter
    ? Math.min(1, chPos / chSpan)
    : nowPlaying.duration > 0
      ? position / nowPlaying.duration
      : 0
  const elapsed = useChapter ? chPos : position
  const total = useChapter ? chSpan : nowPlaying.duration

  return <MiniPlayerBar bottomOffset={bottomOffset} progress={progress} elapsed={elapsed} total={total} />
}

function MiniPlayerBar({
  bottomOffset,
  progress,
  elapsed,
  total,
}: {
  bottomOffset: number
  progress: number
  elapsed: number
  total: number
}) {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { nowPlaying, isPlaying } = useSyncExternalStore(subscribe, getState)
  const settings = useSyncExternalStore(subscribeSettings, getSettingsState)
  // A ± bloom shown briefly after a swipe-skip.
  const [bloom, setBloom] = useState<{ dir: -1 | 1; sec: number } | null>(null)

  const runSwipe = (dir: -1 | 1) => {
    const sec = dir < 0 ? settings.skipBack : settings.skipForward
    haptics.transport()
    jumpBy(dir * sec)
    setBloom({ dir, sec })
    setTimeout(() => setBloom(null), 700)
  }

  // Horizontal swipe on the bar = skip back/forward, mirroring the full player's
  // hotspots. Vertical is left to the parent; a clear horizontal fling past the
  // threshold fires one skip and shows the ± bloom.
  const swipe = Gesture.Pan()
    .activeOffsetX([-18, 18])
    .failOffsetY([-12, 12])
    .onEnd((e) => {
      'worklet'
      if (e.translationX > 40 || e.velocityX > 500) runOnJS(runSwipe)(1)
      else if (e.translationX < -40 || e.velocityX < -500) runOnJS(runSwipe)(-1)
    })

  if (!nowPlaying) return null

  return (
    // Mounts when playback starts, so the dock rises into place rather than
    // popping into existence.
    <Animated.View
      entering={FadeInUp.duration(DUR.slow)}
      style={[styles.wrap, { bottom: bottomOffset }]}
      pointerEvents="box-none"
    >
      <GestureDetector gesture={swipe}>
        <View style={styles.bar}>
          <Pressable style={styles.tap} onPress={() => router.push('/player')}>
            <View style={styles.cover}>
              {/* Thin progress ring around the cover. */}
              <CoverRing progress={progress} color={colors.accent} track={colors.fillStrong} />
              {nowPlaying.artworkUrl ? (
                <Image source={{ uri: nowPlaying.artworkUrl }} style={styles.coverImg} />
              ) : null}
              <CoverDownloadOverlay itemId={nowPlaying.itemId} size={42} radius={8} />
            </View>
            <View style={styles.meta}>
              <AppText variant="label" numberOfLines={1}>
                {nowPlaying.title}
              </AppText>
              <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                {formatTimestamp(elapsed)} / {formatTimestamp(total)}
              </AppText>
            </View>
          </Pressable>
          <SkipButton
            dir={-1}
            seconds={settings.skipBack}
            size={24}
            color={colors.textMuted}
            onPress={() => jumpBy(-settings.skipBack)}
          />
          <SpringPressable onPress={togglePlay} style={styles.play} scaleTo={0.88}>
            <Animated.View key={isPlaying ? 'pause' : 'play'} entering={FadeIn.duration(DUR.fast)}>
              <Icon name={isPlaying ? icons.pause : icons.play} size={30} color={colors.onAccent} />
            </Animated.View>
          </SpringPressable>
          <SkipButton
            dir={1}
            seconds={settings.skipForward}
            size={24}
            color={colors.textMuted}
            onPress={() => jumpBy(settings.skipForward)}
          />

          {/* Swipe-skip ± feedback bloom. */}
          {bloom && (
            <Animated.View
              entering={FadeIn.duration(DUR.fast)}
              exiting={FadeOut.duration(DUR.base)}
              style={styles.bloom}
              pointerEvents="none"
            >
              <Icon
                name={bloom.dir < 0 ? icons.replay : icons.forward}
                size={18}
                color={colors.accent}
              />
              <AppText variant="caption" color={colors.accent} style={{ fontWeight: '700' }}>
                {bloom.dir < 0 ? '-' : '+'}
                {bloom.sec}s
              </AppText>
            </Animated.View>
          )}
        </View>
      </GestureDetector>
    </Animated.View>
  )
}

/** A thin circular progress ring sized to sit around the 42px mini cover. */
function CoverRing({
  progress,
  color,
  track,
}: {
  progress: number
  color: string
  track: string
}) {
  const size = 46
  const stroke = 2
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const dash = Math.max(0, Math.min(1, progress)) * circ
  return (
    <Svg width={size} height={size} style={styles_ring}>
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
      <Circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={stroke}
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </Svg>
  )
}

const styles_ring = { position: 'absolute' as const, top: -2, left: -2, zIndex: 2 }

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    wrap: {
      position: 'absolute',
      left: 0,
      right: 0,
    },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingLeft: spacing.md,
      paddingRight: spacing.sm,
      paddingVertical: spacing.sm,
      backgroundColor: colors.popover,
    },
    tap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.md, minWidth: 0 },
    cover: {
      width: 42,
      height: 42,
      borderRadius: 8,
      backgroundColor: colors.high,
      overflow: 'hidden',
    },
    coverImg: { width: 42, height: 42, borderRadius: 8 },
    meta: { flex: 1, minWidth: 0 },
    play: {
      width: 42,
      height: 42,
      borderRadius: 21,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
    },
    bloom: {
      position: 'absolute',
      alignSelf: 'center',
      top: -22,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.md,
      paddingVertical: 4,
      borderRadius: 999,
      backgroundColor: colors.accentWash,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accent,
    },
  })
