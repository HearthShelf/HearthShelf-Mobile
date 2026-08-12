/**
 * The More tab renders nothing. Inside the tabs shell its press is intercepted
 * (app/(tabs)/_layout.tsx) and opens the MoreMenu bubble instead of navigating,
 * so this component is never reached by that path. The route still has to exist:
 * both tab bars iterate route names, and 'more' must be a registered
 * Tabs.Screen to appear among them.
 *
 * Pushed routes (player, search, item detail...) intercept More the same way via
 * useGoToTab, so they no longer land here either - the bubble opens over the
 * screen you are on instead of bouncing you to Home first. What still reaches
 * this stub is a direct navigation to /(tabs)/more (deep link, restored state),
 * which opens the menu and sends you somewhere renderable.
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
