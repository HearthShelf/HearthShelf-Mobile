/**
 * Now Playing tab. When something is playing, the tab IS the full player
 * (rendered inline via PlayerSurface) - not a splash that punts to /player. When
 * nothing is playing it shows a calm hearth empty state that offers to resume the
 * last book (the "resume last book" affordance the web app's home hero has).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { ImageBackground, StyleSheet, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import { useRouter } from 'expo-router'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { coverHue } from '@hearthshelf/core'
import { coverUrl, getItemsInProgress, itemAuthor, itemTitle } from '@/api/abs'
import { playItemById } from '@/player/playback'
import { AppText, Cover, PrimaryButton, Screen, icons } from '@/ui/primitives'
import { DUR } from '@/ui/motion'
import { radius, spacing } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { useBackHandler } from '@/ui/useBackHandler'
import { getState, subscribe, requestSeek } from '@/player/store'
import { getProgressState } from '@/store/progress'
import { PlayerSurface } from '../player'

const HEARTH = require('../../assets/images/sitting-in-the-hearth.webp')

export default function NowPlayingTab() {
  const { nowPlaying } = useSyncExternalStore(subscribe, getState)

  // Playing -> show the real player inline; otherwise the hearth resume state.
  if (nowPlaying) return <PlayerSurface embedded />
  return <EmptyState />
}

/**
 * Empty state over the hearth scene. Offers to resume the most-recent in-progress
 * book (ABS returns items-in-progress newest-activity first, so [0] is the last
 * book). Falls back to calm copy when there is genuinely nothing to resume.
 */
function EmptyState() {
  const router = useRouter()
  const colors = useColors()
  const [last, setLast] = useState<ABSLibraryItem | null>(null)
  const [loading, setLoading] = useState(true)

  // Non-home tab: hardware back returns to Home rather than exiting the app.
  useBackHandler(
    useCallback(() => {
      router.replace('/(tabs)')
      return true
    }, [router]),
  )

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const items = await getItemsInProgress()
        if (!cancelled) setLast(items[0] ?? null)
      } catch {
        if (!cancelled) setLast(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const resume = async () => {
    if (!last) return
    try {
      const saved = getProgressState().byId.get(last.id)
      await playItemById(last.id)
      if (!saved?.isFinished && (saved?.currentTime ?? 0) > 0) requestSeek(saved!.currentTime)
      // Stay on this tab - it re-renders the inline <PlayerSurface embedded /> now
      // that nowPlaying is set. Pushing /player would stack a second (non-embedded)
      // player on top, which is where the stray "minimize" button came from.
    } catch {
      // If the session can't start, drop the user on the item so they can retry.
      router.push(`/item/${last.id}`)
    }
  }

  return (
    <Screen>
      <HearthBackground>
        <View style={styles.centerBlock}>
          {last ? (
            <Animated.View
              entering={FadeIn.duration(DUR.base)}
              style={{ alignItems: 'center', gap: spacing.md }}
            >
              <Cover
                uri={coverUrl(last.id)}
                itemId={last.id}
                width={132}
                aspectRatio={2 / 3}
                radius={radius.tile}
                fallback={{
                  hue: coverHue(last.id),
                  initial: itemTitle(last).charAt(0).toUpperCase(),
                }}
              />
              <View style={styles.resumeMeta}>
                <AppText variant="caption" color={colors.accent}>
                  PICK UP WHERE YOU LEFT OFF
                </AppText>
                <AppText variant="title" numberOfLines={2} style={styles.centerText}>
                  {itemTitle(last)}
                </AppText>
                <AppText variant="meta" color={colors.textMuted} numberOfLines={1}>
                  {itemAuthor(last)}
                </AppText>
              </View>
              <PrimaryButton label="Resume last book" icon={icons.play} onPress={resume} />
            </Animated.View>
          ) : (
            <>
              <AppText variant="title" style={styles.centerText}>
                Nothing playing
              </AppText>
              <AppText variant="meta" color={colors.textMuted} style={styles.centerText}>
                {loading
                  ? 'Warming up the hearth...'
                  : 'Start a book from your library and it will show up here.'}
              </AppText>
            </>
          )}
        </View>
      </HearthBackground>
    </Screen>
  )
}

/** Full-bleed hearth image with a bottom-weighted scrim for text legibility. */
function HearthBackground({ children }: { children: React.ReactNode }) {
  const colors = useColors()
  return (
    <ImageBackground source={HEARTH} resizeMode="cover" style={styles.bg}>
      <LinearGradient
        colors={['rgba(27,26,24,0.35)', 'rgba(27,26,24,0.72)', colors.scaffold]}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />
      {children}
    </ImageBackground>
  )
}

const styles = StyleSheet.create({
  bg: { flex: 1, justifyContent: 'center' },
  centerBlock: {
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  resumeMeta: { alignItems: 'center', gap: spacing.xs },
  centerText: { textAlign: 'center' },
})
