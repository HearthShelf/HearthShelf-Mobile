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
import { TAB_BAR_HEIGHT } from '@/ui/AppTabBar'
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
 *  the dock floats above it. Search, group, settings, and auth have no bottom nav. */
export function hasBottomTabBar(pathname: string): boolean {
  return !(
    pathname.startsWith('/search') ||
    pathname.startsWith('/group') ||
    pathname.startsWith('/settings') ||
    pathname.startsWith('/sign-in')
  )
}

export function MiniPlayerDock() {
  const pathname = usePathname()
  const insets = useSafeAreaInsets()
  const { nowPlaying } = useSyncExternalStore(subscribe, getState)
  const immersive = useSyncExternalStore(subscribeImmersive, getImmersive)
  if (!nowPlaying || immersive || miniPlayerHiddenOn(pathname)) return null
  const offset = (hasBottomTabBar(pathname) ? TAB_BAR_HEIGHT : 0) + insets.bottom
  return <MiniPlayer bottomOffset={offset} />
}
