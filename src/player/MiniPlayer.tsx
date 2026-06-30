/**
 * Floating mini-player, docked just above the bottom tab bar app-wide. Mirrors
 * the web `.playbar` mobile treatment: rounded card, cover + title + progress,
 * tap to open the full player. Reads the same store the car drives.
 */
import { useSyncExternalStore } from 'react'
import { Image, Pressable, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { formatTimestamp } from '@hearthshelf/core'
import { AppText, IconButton, ProgressBar, icons } from '@/ui/primitives'
import { colors, radius, shadow, spacing } from '@/ui/theme'
import { getState, subscribe, togglePlay, jumpBy } from './store'

export function MiniPlayer({ bottomOffset = 0 }: { bottomOffset?: number }) {
  const router = useRouter()
  const { nowPlaying, isPlaying, position } = useSyncExternalStore(subscribe, getState)
  if (!nowPlaying) return null

  const progress = nowPlaying.duration > 0 ? position / nowPlaying.duration : 0

  return (
    <View style={[styles.wrap, { bottom: bottomOffset + spacing.sm }]} pointerEvents="box-none">
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
              {formatTimestamp(position)} / {formatTimestamp(nowPlaying.duration)}
            </AppText>
          </View>
        </Pressable>
        <IconButton name={icons.rewind} size={24} color={colors.textMuted} onPress={() => jumpBy(-15)} />
        <IconButton
          name={isPlaying ? icons.pause : icons.play}
          size={30}
          onPress={togglePlay}
          style={styles.play}
        />
        <IconButton name={icons.forward} size={24} color={colors.textMuted} onPress={() => jumpBy(30)} />
      </View>
      <ProgressBar progress={progress} height={2} style={styles.progress} />
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: spacing.sm,
    right: spacing.sm,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.sm,
    paddingRight: spacing.xs,
    paddingVertical: spacing.sm,
    backgroundColor: colors.highest,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
    ...shadow.lift,
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
  },
  progress: {
    marginHorizontal: spacing.lg,
    marginTop: -1,
  },
})
