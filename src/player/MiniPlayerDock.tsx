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

/** Screens whose bottom edge is a tab bar (their own copy or the tabs shell);
 *  the dock floats above it. Auth and admin have no bottom nav. */
export function hasBottomTabBar(pathname: string): boolean {
  return !(pathname.startsWith('/settings/admin') || pathname.startsWith('/sign-in'))
}

export function MiniPlayerDock() {
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const { nowPlaying } = useSyncExternalStore(subscribe, getState)
  const immersive = useSyncExternalStore(subscribeImmersive, getImmersive)
  const floatingNav = useSyncExternalStore(subscribeSettings, () => getSettingsState().floatingNav)
  const orientation = useSyncExternalStore(
    subscribeSettings,
    () => getSettingsState().floatingNavOrientation
  )
  if (!nowPlaying || immersive || miniPlayerHiddenOn(pathname)) return null
  const hasTabBar = hasBottomTabBar(pathname)
  // With a vertical floating column, the nav hugs the bottom-right instead of
  // spanning the width, so the mini player drops to the bottom and only insets
  // its right side to clear the column (width + its right margin).
  const vertical = hasTabBar && floatingNav && orientation === 'vertical'
  // Sit the docked mini-player flush on TOP of the tab bar. The classic tab bar
  // already reserves the bottom safe-area inset internally (its own
  // paddingBottom), so its top edge is TAB_BAR_HEIGHT above the inset zone - we
  // must NOT add insets.bottom again here or the bar floats a home-indicator's
  // height too high, leaving a strip of dead space above the tab bar. When there
  // is no tab bar (or a vertical floating column), the bar drops to the bottom
  // and DOES clear the safe-area inset itself.
  const offset = hasTabBar && !vertical ? TAB_BAR_HEIGHT : insets.bottom
  const rightInset = vertical ? VNAV_WIDTH + spacing.md : 0
  // With the floating pill nav, the mini player becomes a rounded floating card
  // (side margins + shadow) to match; with the classic docked tab bar it stays
  // flush and square-topped, sitting directly on the bar.
  return (
    <MiniPlayer bottomOffset={offset} rightInset={rightInset} floating={floatingNav && hasTabBar} />
  )
}
