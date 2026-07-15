/**
 * Now Playing tab. When something is loaded, the tab IS the full player
 * (rendered inline via PlayerSurface). When nothing is loaded, it tries to drop
 * you straight into the player on your most-recent in-progress book - loaded
 * PAUSED, so no audio starts on tab open. Only when there is genuinely nothing
 * to resume do we show a small "nothing playing" screen.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import { useRouter } from 'expo-router'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { getItemsInProgress, getLibraries, getPersonalized } from '@/api/abs'
import { playItemById } from '@/player/playback'
import { getState, subscribe } from '@/player/store'
import { getProgressState, subscribeProgress, refreshProgress } from '@/store/progress'
import { AppText, Screen, PrimaryButton, icons } from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { BookTile } from '@/ui/BookTile'
import { haptics } from '@/ui/haptics'
import { spacing } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { useBackHandler } from '@/ui/useBackHandler'
import { adaptiveShelfTileWidth } from '@/ui/responsive'
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
        // Make sure the shared progress store is populated before we resume. On
        // a cold app reload this tab can run before Home loads progress, leaving
        // the store empty - then playItemById would have no saved spot to fall
        // back to and could resume (and sync) from 0, wiping real progress.
        if (getProgressState().byId.size === 0) await refreshProgress().catch(() => {})
        const items = await getItemsInProgress()
        const last = items[0]
        if (!last) {
          if (!cancelled) setPhase('empty')
          return
        }
        // Load paused at the saved spot; setting nowPlaying re-renders this tab
        // into <PlayerSurface embedded /> (so this component unmounts).
        // playItemById resolves the resume position itself (play session, else
        // the saved media-progress spot now guaranteed to be loaded).
        await playItemById(last.id, false)
      } catch {
        if (!cancelled) setPhase('empty')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (phase === 'loading') {
    return (
      <Screen>
        <View style={styles.center}>
          <AppText variant="meta" color={colors.textMuted}>
            Warming up the hearth...
          </AppText>
        </View>
      </Screen>
    )
  }
  return <EmptyPlayer />
}

/**
 * The designed empty-player state: a hearth flame, "Nothing on the hearth", a
 * few pick-up-a-book mini tiles (best-effort from the personalized feed), and a
 * Browse library CTA. Only shown when there is genuinely nothing to resume.
 */
function EmptyPlayer() {
  const router = useRouter()
  const colors = useColors()
  const { width } = useWindowDimensions()
  const tileWidth = adaptiveShelfTileWidth(width)
  const progressById = useSyncExternalStore(subscribeProgress, getProgressState).byId
  const [picks, setPicks] = useState<ABSLibraryItem[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const libs = await getLibraries()
        const lib = libs.find((l) => l.mediaType === 'book') ?? libs[0]
        if (!lib) return
        const shelves = await getPersonalized(lib.id)
        const shelf =
          shelves.find((s) => s.type === 'book' && s.entities.length > 0) ??
          shelves.find((s) => s.type === 'book')
        if (!cancelled && shelf && shelf.type === 'book') setPicks(shelf.entities.slice(0, 3))
      } catch {
        // Best-effort; the CTA still stands on its own.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Screen>
      <View style={styles.emptyWrap}>
        <View style={[styles.flameChip, { backgroundColor: colors.accentWash }]}>
          <Icon name={icons.flame} size={38} color={colors.brandHearth} />
        </View>
        <AppText variant="title" style={styles.centerText}>
          Nothing on the hearth
        </AppText>
        <AppText variant="meta" color={colors.textMuted} style={styles.centerText}>
          Pick a book and it will be waiting right here.
        </AppText>

        {picks.length > 0 ? (
          <View style={styles.picks}>
            {picks.map((item) => {
              const p = progressById.get(item.id)
              return (
                <BookTile
                  key={item.id}
                  item={item}
                  width={tileWidth}
                  from="now"
                  progress={p?.progress}
                  finished={p?.isFinished === true}
                  onQuickPlay={() => {
                    haptics.transport()
                    void playItemById(item.id)
                      .then(() => router.push('/player'))
                      .catch(() => router.push(`/item/${item.id}?from=now`))
                  }}
                />
              )
            })}
          </View>
        ) : null}

        <PrimaryButton
          label="Browse your library"
          icon={icons.library}
          onPress={() => router.replace('/(tabs)/library')}
          style={{ marginTop: spacing.xl }}
        />
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
  emptyWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  flameChip: {
    width: 72,
    height: 72,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  picks: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.xl,
  },
})
