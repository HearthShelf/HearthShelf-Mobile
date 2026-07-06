/**
 * Now Playing tab. When something is loaded, the tab IS the full player
 * (rendered inline via PlayerSurface). When nothing is loaded, it tries to drop
 * you straight into the player on your most-recent in-progress book - loaded
 * PAUSED, so no audio starts on tab open. Only when there is genuinely nothing
 * to resume do we show a small "nothing playing" screen.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { getItemsInProgress } from '@/api/abs'
import { playItemById } from '@/player/playback'
import { getState, subscribe, requestSeek } from '@/player/store'
import { getProgressState } from '@/store/progress'
import { AppText, Screen } from '@/ui/primitives'
import { spacing } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { useBackHandler } from '@/ui/useBackHandler'
import { PlayerSurface } from '../player'

export default function NowPlayingTab() {
  const { nowPlaying } = useSyncExternalStore(subscribe, getState)

  // Something loaded -> the tab IS the real player.
  if (nowPlaying) return <PlayerSurface embedded />
  // Nothing loaded -> try to land in the player on the last book (paused).
  return <IdleResolver />
}

/**
 * Idle: fetch the most-recent in-progress book and load it PAUSED so the tab
 * re-renders into the real player. ABS returns items-in-progress newest-activity
 * first, so [0] is the last book. If there's nothing to resume (or it fails to
 * load), fall back to a small empty screen.
 */
function IdleResolver() {
  const router = useRouter()
  const colors = useColors()
  const [phase, setPhase] = useState<'loading' | 'empty'>('loading')
  // Guard so a re-render mid-resolve can't kick off a second load.
  const started = useRef(false)

  // Non-home tab: hardware back returns to Home rather than exiting the app.
  useBackHandler(
    useCallback(() => {
      router.replace('/(tabs)')
      return true
    }, [router]),
  )

  useEffect(() => {
    if (started.current) return
    started.current = true
    let cancelled = false
    void (async () => {
      try {
        const items = await getItemsInProgress()
        const last = items[0]
        if (!last) {
          if (!cancelled) setPhase('empty')
          return
        }
        // Load paused at the saved spot; setting nowPlaying re-renders this tab
        // into <PlayerSurface embedded /> (so this component unmounts).
        const saved = getProgressState().byId.get(last.id)
        await playItemById(last.id, false)
        if (!saved?.isFinished && (saved?.currentTime ?? 0) > 0) requestSeek(saved!.currentTime)
      } catch {
        if (!cancelled) setPhase('empty')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Screen>
      <View style={styles.center}>
        {phase === 'loading' ? (
          <AppText variant="meta" color={colors.textMuted}>
            Warming up the hearth...
          </AppText>
        ) : (
          <>
            <AppText variant="title" style={styles.centerText}>
              Nothing playing
            </AppText>
            <AppText variant="meta" color={colors.textMuted} style={styles.centerText}>
              Start a book from your library and it will show up here.
            </AppText>
          </>
        )}
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.xl,
  },
  centerText: { textAlign: 'center' },
})
