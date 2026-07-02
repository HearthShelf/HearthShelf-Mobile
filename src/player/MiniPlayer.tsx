/**
 * Floating mini-player, docked just above the bottom tab bar app-wide. Mirrors
 * the web `.playbar` mobile treatment: rounded card, cover + title + progress,
 * tap to open the full player. Reads the same store the car drives.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { Image, Pressable, StyleSheet, View } from 'react-native'
import Animated, { FadeIn, FadeInUp } from 'react-native-reanimated'
import { useRouter } from 'expo-router'
import { formatTimestamp } from '@hearthshelf/core'
import { AppText, IconButton, ProgressBar, icons } from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { DUR, SpringPressable } from '@/ui/motion'
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

  return (
    // Mounts when playback starts, so the dock rises into place rather than
    // popping into existence.
    <Animated.View
      entering={FadeInUp.duration(DUR.slow)}
      style={[styles.wrap, { bottom: bottomOffset }]}
      pointerEvents="box-none"
    >
      <ProgressBar progress={progress} height={2} style={styles.progress} />
      <View style={styles.bar}>
        <Pressable style={styles.tap} onPress={() => router.push('/player')}>
          {nowPlaying.artworkUrl ? (
            <Image source={{ uri: nowPlaying.artworkUrl }} style={styles.cover} />
          ) : (
            <View style={styles.cover} />
          )}
          <View style={styles.meta}>
            <AppText variant="label" numberOfLines={1}>
              {nowPlaying.title}
            </AppText>
            <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
              {formatTimestamp(elapsed)} / {formatTimestamp(total)}
            </AppText>
          </View>
        </Pressable>
        <IconButton
          name={icons.rewind}
          size={24}
          color={colors.textMuted}
          onPress={() => jumpBy(-15)}
        />
        <SpringPressable onPress={togglePlay} style={styles.play} scaleTo={0.88}>
          <Animated.View key={isPlaying ? 'pause' : 'play'} entering={FadeIn.duration(DUR.fast)}>
            <Icon name={isPlaying ? icons.pause : icons.play} size={30} color={colors.onAccent} />
          </Animated.View>
        </SpringPressable>
        <IconButton
          name={icons.forward}
          size={24}
          color={colors.textMuted}
          onPress={() => jumpBy(30)}
        />
      </View>
    </Animated.View>
  )
}

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
    cover: { width: 42, height: 42, borderRadius: 8, backgroundColor: colors.high },
    meta: { flex: 1, minWidth: 0 },
    play: {
      width: 42,
      height: 42,
      borderRadius: 21,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
    },
    progress: {
      width: '100%',
      borderRadius: 0,
    },
  })
