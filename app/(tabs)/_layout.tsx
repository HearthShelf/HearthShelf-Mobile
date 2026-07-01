/**
 * Bottom-tab shell, mirroring the web app's mobile `.mtab`. A custom tab bar is
 * used so it picks up the app theme and so the floating MiniPlayer can dock just
 * above it (rendered here, not per-screen, so it persists across tabs).
 */
import { Tabs, type BottomTabBarProps } from 'expo-router/js-tabs'
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon, iconFor, icons } from '@/ui/icons'
import { AppText } from '@/ui/primitives'
import { MiniPlayer } from '@/player/MiniPlayer'
import { colors, radius, spacing } from '@/ui/theme'

const TAB_BAR_HEIGHT = 60

const TABS: { name: string; label: string; icon: keyof typeof icons }[] = [
  { name: 'index', label: 'Home', icon: 'home' },
  { name: 'library', label: 'Library', icon: 'library' },
  { name: 'now', label: 'Now Playing', icon: 'nowPlaying' },
  { name: 'stats', label: 'Stats', icon: 'stats' },
  { name: 'more', label: 'More', icon: 'more' },
]

function TabBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets()
  const barHeight = TAB_BAR_HEIGHT + insets.bottom
  // Hide the docked mini-player when the Now Playing tab is active - the tab is
  // itself a player surface, so the mini-bar would be redundant (matches the
  // prototype's showMini rule).
  const activeName = state.routes[state.index]?.name
  const hideMini = activeName === 'now'

  return (
    <View pointerEvents="box-none">
      {!hideMini && <MiniPlayer bottomOffset={barHeight} />}
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
              <View style={[styles.pill, focused && styles.pillActive]}>
                <Icon name={iconFor(meta.icon, focused)} size={23} color={tint} />
              </View>
              <AppText variant="caption" color={tint} numberOfLines={1}>
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
      <Tabs.Screen name="now" />
      <Tabs.Screen name="stats" />
      <Tabs.Screen name="more" />
    </Tabs>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: colors.popover,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.hairline,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 3,
    paddingTop: spacing.sm,
  },
  // Ember-wash rounded pill behind the active icon (accent @ ~22%).
  pill: {
    width: 60,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillActive: { backgroundColor: colors.accentTile },
})
