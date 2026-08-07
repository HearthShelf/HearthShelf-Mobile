/**
 * Route-aware dock for the floating mini player, mounted once in the root
 * layout so it shows on every screen while a book plays - detail pages,
 * search, author/narrator groups - not just the tab screens. Hidden only on
 * surfaces that are themselves a player (the full player, the Now Playing
 * tab, Home's live hero) and in settings.
 */
import { useSyncExternalStore } from 'react'
import { usePathname } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { TAB_BAR_HEIGHT, VNAV_WIDTH } from '@/ui/AppTabBar'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { spacing } from '@/ui/theme'
import { getState, subscribe } from './store'
import { getImmersive, subscribeImmersive } from './immersive'
import { MiniPlayer } from './MiniPlayer'

/** Screens that keep the mini player hidden. Shared with useContentInset so
 *  content padding always agrees with what's actually docked. */
export function miniPlayerHiddenOn(pathname: string): boolean {
  return (
    pathname === '/player' ||
    pathname === '/now' ||
    pathname === '/' ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/sign-in')
  )
}

/**
 * Screens whose bottom edge is a tab bar - either the tabs shell itself or a
 * pushed route that mounts its own AppTabBar (item, series, search, player...).
 * The dock floats above that bar, and useContentInset counts on the bar to stop
 * the scroll.
 *
 * Routes listed here render NO bottom nav, so nothing reserves that band for
 * them: the dock drops to the safe area and content has to clear it itself.
 * A pushed route without an AppTabBar must be added here, or its last rows end
 * up under the mini player.
 */
const NO_TAB_BAR = ['/settings/admin', '/sign-in']

export function hasBottomTabBar(pathname: string): boolean {
  return !NO_TAB_BAR.some((p) => pathname === p || pathname.startsWith(p + '/'))
}

export function MiniPlayerDock() {
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const { nowPlaying } = useSyncExternalStore(subscribe, getState)
  const immersive = useSyncExternalStore(subscribeImmersive, getImmersive)
  const floatingNav = useSyncExternalStore(subscribeSettings, () => getSettingsState().floatingNav)
  const hideMiniPlayer = useSyncExternalStore(
    subscribeSettings,
    () => getSettingsState().hideMiniPlayer,
  )
  const orientation = useSyncExternalStore(
    subscribeSettings,
    () => getSettingsState().floatingNavOrientation,
  )
  if (!nowPlaying || immersive || hideMiniPlayer || miniPlayerHiddenOn(pathname)) return null
  const hasTabBar = hasBottomTabBar(pathname)
  // With a vertical floating column, the nav hugs the bottom-right instead of
  // spanning the width, so the mini player drops to the bottom and only insets
  // its right side to clear the column (width + its right margin).
  const vertical = hasTabBar && floatingNav && orientation === 'vertical'
  const offset = (hasTabBar && !vertical ? TAB_BAR_HEIGHT : 0) + insets.bottom
  const rightInset = vertical ? VNAV_WIDTH + spacing.md : 0
  // With the floating pill nav, the mini player becomes a rounded floating card
  // (side margins + shadow) to match; with the classic docked tab bar it stays
  // flush and square-topped, sitting directly on the bar.
  return (
    <MiniPlayer bottomOffset={offset} rightInset={rightInset} floating={floatingNav && hasTabBar} />
  )
}
