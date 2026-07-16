/**
 * Bottom-tab shell, mirroring the web app's mobile `.mtab`. A custom tab bar
 * (AppTabBar) is used so it picks up the app theme. The floating MiniPlayer is
 * mounted once at the root (MiniPlayerDock), not here, so it also shows on
 * pushed detail routes. The same AppTabBar renders on the full player so the
 * nav stays visible there unless the player goes immersive.
 */
import { Tabs, type BottomTabBarProps, type BottomTabNavigationOptions } from 'expo-router/js-tabs'
import { View } from 'react-native'
import { useSyncExternalStore } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppTabBar, TAB_BAR_HEIGHT, useNavMode } from '@/ui/AppTabBar'
import { getImmersive, subscribeImmersive } from '@/player/immersive'
import { LIFT, useReducedMotion } from '@/ui/motion'

type SceneStyleInterpolator = NonNullable<BottomTabNavigationOptions['sceneStyleInterpolator']>
type TransitionSpec = NonNullable<BottomTabNavigationOptions['transitionSpec']>

/**
 * Shelf Lift micro dose: the incoming tab scene fades in while settling
 * 8px -> 0; the outgoing scene sinks + fades symmetrically. `progress` is a
 * plain RN Animated.Value that runs -1/1 (inactive) -> 0 (active), so a
 * single interpolation covers both directions. The custom tab bar and the
 * root-mounted MiniPlayerDock live outside the scenes and never move.
 */
const liftSceneInterpolator: SceneStyleInterpolator = ({ current }) => ({
  sceneStyle: {
    opacity: current.progress.interpolate({
      inputRange: [-1, 0, 1],
      outputRange: [0, 1, 0],
    }),
    transform: [
      {
        translateY: current.progress.interpolate({
          inputRange: [-1, 0, 1],
          outputRange: [LIFT.micro.distance, 0, LIFT.micro.distance],
        }),
      },
    ],
  },
})

const liftTransitionSpec: TransitionSpec = {
  animation: 'timing',
  config: { duration: LIFT.micro.duration },
}

// Reduce Motion: zero displacement, opacity-only over the zero dose duration.
const fadeSceneInterpolator: SceneStyleInterpolator = ({ current }) => ({
  sceneStyle: {
    opacity: current.progress.interpolate({
      inputRange: [-1, 0, 1],
      outputRange: [0, 1, 0],
    }),
  },
})

const fadeTransitionSpec: TransitionSpec = {
  animation: 'timing',
  config: { duration: LIFT.zero.duration },
}

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
  const reducedMotion = useReducedMotion()
  return (
    <Tabs
      tabBar={(props) => <TabBar {...props} />}
      screenOptions={{
        headerShown: false,
        sceneStyleInterpolator: reducedMotion ? fadeSceneInterpolator : liftSceneInterpolator,
        transitionSpec: reducedMotion ? fadeTransitionSpec : liftTransitionSpec,
      }}
    >
      <Tabs.Screen name="index" />
      <Tabs.Screen name="library" />
      <Tabs.Screen name="now" />
      <Tabs.Screen name="stats" />
      <Tabs.Screen name="more" />
    </Tabs>
  )
}
