/**
 * Bottom-tab shell, mirroring the web app's mobile `.mtab`. A custom tab bar is
 * used so it picks up the app theme and so the floating MiniPlayer can dock just
 * above it (rendered here, not per-screen, so it persists across tabs).
 */
import { Tabs, type BottomTabBarProps } from 'expo-router/js-tabs'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon, icons } from '@/ui/icons'
import { AppText } from '@/ui/primitives'
import { MiniPlayer } from '@/player/MiniPlayer'
import { colors, spacing } from '@/ui/theme'

const TAB_BAR_HEIGHT = 56

const TABS: { name: string; label: string; icon: keyof typeof icons }[] = [
  { name: 'index', label: 'Home', icon: 'home' },
  { name: 'library', label: 'Library', icon: 'library' },
  { name: 'more', label: 'More', icon: 'more' },
]

function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets()
  const barHeight = TAB_BAR_HEIGHT + insets.bottom

  return (
    <View pointerEvents="box-none">
      <MiniPlayer bottomOffset={barHeight} />
      <View style={[styles.bar, { height: barHeight, paddingBottom: insets.bottom }]}>
        {state.routes.map((route, index) => {
          const meta = TABS.find((t) => t.name === route.name)
          if (!meta) return null
          const focused = state.index === index
          const tint = focused ? colors.accent : colors.textMuted
          return (
            <Pressable
              key={route.key}
              style={styles.tab}
              onPress={() => {
                const event = navigation.emit({
                  type: 'tabPress',
                  target: route.key,
                  canPreventDefault: true,
                })
                if (!focused && !event.defaultPrevented) navigation.navigate(route.name)
              }}
            >
              <Icon name={icons[meta.icon]} size={24} color={tint} />
              <AppText variant="caption" color={tint}>
                {meta.label}
              </AppText>
            </Pressable>
          )
        })}
      </View>
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
      <Tabs.Screen name="more" />
    </Tabs>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.lowest,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.hairline,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    paddingTop: spacing.sm,
  },
})
