/**
 * Bottom-tab shell, mirroring the web app's mobile `.mtab`. A custom tab bar
 * (AppTabBar) is used so it picks up the app theme and so the floating MiniPlayer
 * can dock just above it (rendered here, not per-screen, so it persists across
 * tabs). The same AppTabBar renders on the full player so the nav stays visible
 * there unless the player goes immersive.
 */
import { Tabs, type BottomTabBarProps } from 'expo-router/js-tabs'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useSyncExternalStore } from 'react'
import { AppTabBar, TAB_BAR_HEIGHT } from '@/ui/AppTabBar'
import { MiniPlayer } from '@/player/MiniPlayer'
import { getState, subscribe } from '@/player/store'

function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets()
  const { nowPlaying } = useSyncExternalStore(subscribe, getState)
  const barHeight = TAB_BAR_HEIGHT + insets.bottom
  // Hide the docked mini-player when the Now Playing tab is active - the tab is
  // itself a player surface, so the mini-bar would be redundant. Also hide it on
  // Home while something plays: the hero there IS the live player.
  const activeName = state.routes[state.index]?.name
  const hideMini = activeName === 'now' || (activeName === 'index' && nowPlaying !== null)

  return (
    <View pointerEvents="box-none">
      {!hideMini && <MiniPlayer bottomOffset={barHeight} />}
      <AppTabBar
        activeName={activeName ?? null}
        onPressTab={(name) => {
          const route = state.routes.find((r) => r.name === name)
          if (!route) return
          const focused = state.routes[state.index]?.name === name
          const event = navigation.emit({
            type: 'tabPress',
            target: route.key,
            canPreventDefault: true,
          })
          if (!focused && !event.defaultPrevented) navigation.navigate(name)
        }}
      />
    </View>
  )
}

export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="library" />
      <Tabs.Screen name="now" />
      <Tabs.Screen name="stats" />
      <Tabs.Screen name="more" />
    </Tabs>
  )
}
