/**
 * Bottom padding for scrollable content: comfortable clearance, plus room for
 * the docked mini player when it's visible on this screen (so it never covers
 * the last row), plus the safe-area bottom on screens without a tab bar.
 * Replaces the hardcoded `paddingBottom: 140` sprinkled across screens.
 */
import { useSyncExternalStore } from 'react'
import { usePathname } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { getState, subscribe } from '@/player/store'
import { MINI_PLAYER_HEIGHT } from '@/player/MiniPlayer'
import { miniPlayerHiddenOn, hasBottomTabBar } from '@/player/MiniPlayerDock'
import { spacing } from './theme'

export function useContentInset(): number {
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const { nowPlaying } = useSyncExternalStore(subscribe, getState)
  const miniVisible = nowPlaying !== null && !miniPlayerHiddenOn(pathname)
  return (
    spacing.xl +
    (miniVisible ? MINI_PLAYER_HEIGHT + spacing.sm : 0) +
    (hasBottomTabBar(pathname) ? 0 : insets.bottom)
  )
}

/**
 * Clearance for screens that render their OWN fixed tab bar as a layout sibling
 * (item/series/player detail routes, pushed above the tabs navigator). The tab
 * bar already stops the scroll view, so content only needs to clear the mini
 * player that docks just above that bar.
 */
export function useMiniPlayerInset(): number {
  const pathname = usePathname()
  const { nowPlaying } = useSyncExternalStore(subscribe, getState)
  const miniVisible = nowPlaying !== null && !miniPlayerHiddenOn(pathname)
  return spacing.xl + (miniVisible ? MINI_PLAYER_HEIGHT + spacing.sm : 0)
}
