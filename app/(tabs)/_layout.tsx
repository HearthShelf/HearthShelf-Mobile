/**
 * Bottom-tab shell, mirroring the web app's mobile `.mtab`. A custom tab bar
 * (AppTabBar) is used so it picks up the app theme. The floating MiniPlayer is
 * mounted once at the root (MiniPlayerDock), not here, so it also shows on
 * pushed detail routes. The same AppTabBar renders on the full player so the
 * nav stays visible there unless the player goes immersive.
 */
import { Tabs, type BottomTabBarProps } from 'expo-router/js-tabs'
import { View } from 'react-native'
import { useSyncExternalStore } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppTabBar, TAB_BAR_HEIGHT, useNavMode } from '@/ui/AppTabBar'
import { getImmersive, subscribeImmersive } from '@/player/immersive'

function TabBar({ state, navigation }: BottomTabBarProps) {
  const immersive = useSyncExternalStore(subscribeImmersive, getImmersive)
  const activeName = state.routes[state.index]?.name
  const navMode = useNavMode()
  const insets = useSafeAreaInsets()

  // The player's immersive (Car Mode) hides all app chrome, including this nav.
  if (immersive) return null

  return (
    <View
      pointerEvents="box-none"
      style={
        navMode === 'classic'
          ? undefined
          : {
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: TAB_BAR_HEIGHT + insets.bottom,
            }
      }
    >
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
    <Tabs tabBar={(props) => <TabBar {...props} />} screenOptions={{ headerShown: false }}>
      <Tabs.Screen name="index" />
      <Tabs.Screen name="library" />
      <Tabs.Screen name="now" />
      <Tabs.Screen name="stats" />
      <Tabs.Screen name="more" />
    </Tabs>
  )
}
