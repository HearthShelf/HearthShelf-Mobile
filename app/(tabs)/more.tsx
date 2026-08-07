/**
 * The More tab renders nothing. Inside the tabs shell its press is intercepted
 * (app/(tabs)/_layout.tsx) and opens the MoreMenu bubble instead of navigating,
 * so this component is never reached by that path. The route still has to exist:
 * both tab bars iterate route names, and 'more' must be a registered
 * Tabs.Screen to appear among them.
 *
 * Pushed routes (player, search, item detail...) render their own AppTabBar and
 * navigate by route name, so their More press DOES land here. Those arrivals ask
 * for the menu and bounce to Home, which is where the bubble actually renders.
 *
 * The settings list this tab used to show now lives at app/settings/index.tsx as
 * a pushed route, reached from the menu's Settings entry.
 */
import { useEffect } from 'react'
import { Redirect } from 'expo-router'
import { setMoreMenuOpen } from '@/ui/moreMenuState'

export default function MoreTabStub() {
  useEffect(() => {
    setMoreMenuOpen(true)
  }, [])
  return <Redirect href="/(tabs)" />
}
