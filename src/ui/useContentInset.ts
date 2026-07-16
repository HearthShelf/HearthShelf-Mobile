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
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { MINI_PLAYER_HEIGHT } from '@/player/MiniPlayer'
import { miniPlayerHiddenOn, hasBottomTabBar } from '@/player/MiniPlayerDock'
import { FLOATING_PILL_CLEARANCE, useNavMode } from './AppTabBar'
import { spacing } from './theme'

export function useContentInset(): number {
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const { nowPlaying } = useSyncExternalStore(subscribe, getState)
  const hideMiniPlayer = useSyncExternalStore(
    subscribeSettings,
    () => getSettingsState().hideMiniPlayer
  )
  const mode = useNavMode()
  const onTabScreen = hasBottomTabBar(pathname)
  const miniVisible = nowPlaying !== null && !hideMiniPlayer && !miniPlayerHiddenOn(pathname)

  // Classic reserves its bar via the navigator (scene is already inset), so
  // content only adds a comfortable margin + mini-player clearance. Floating
  // modes reserve nothing, so content must clear the safe area itself, plus the
  // horizontal pill's floating footprint (the vertical column sits to the side).
  const floating = onTabScreen && mode !== 'classic'
  const navClearance = floating
    ? insets.bottom + (mode === 'floating-horizontal' ? FLOATING_PILL_CLEARANCE : 0)
    : onTabScreen
      ? 0
      : insets.bottom

  return spacing.xl + (miniVisible ? MINI_PLAYER_HEIGHT + spacing.sm : 0) + navClearance
}

/**
 * Clearance for screens that render their OWN fixed tab bar as a layout sibling
 * (item/series/player detail routes, pushed above the tabs navigator). The tab
 * bar already stops the scroll view, so content only needs to clear the mini
 * player that docks just above that bar.
 */
export function useMiniPlayerInset(): number {
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const { nowPlaying } = useSyncExternalStore(subscribe, getState)
  const hideMiniPlayer = useSyncExternalStore(
    subscribeSettings,
    () => getSettingsState().hideMiniPlayer
  )
  const mode = useNavMode()
  const miniVisible = nowPlaying !== null && !hideMiniPlayer && !miniPlayerHiddenOn(pathname)
  // These routes mount their own AppTabBar sibling. Classic reserves a laid-out
  // band (already stops the scroll); floating modes float over content, so clear
  // the safe area + the horizontal pill's footprint here.
  const navClearance =
    mode === 'classic'
      ? 0
      : insets.bottom + (mode === 'floating-horizontal' ? FLOATING_PILL_CLEARANCE : 0)
  return spacing.xl + (miniVisible ? MINI_PLAYER_HEIGHT + spacing.sm : 0) + navClearance
}
