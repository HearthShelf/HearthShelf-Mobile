/**
 * Presentational bottom tab bar. Used by the tabs layout (driven by the router's
 * navigation state) and by the full player (so the nav stays visible there unless
 * the player is in immersive mode). Purely visual - the caller decides what
 * "active" is and what a tap does.
 */
import { useEffect } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated'
import { Icon, iconFor, icons } from './icons'
import { emitTabReselect } from './tabReselect'
import { haptics } from './haptics'
import { POP_SPRING } from './motion'
import { fonts, MAX_FONT_SCALE, radius } from './theme'
import { useColors } from './ThemeProvider'

export const TAB_BAR_HEIGHT = 60

export interface TabDef {
  name: string
  label: string
  icon: keyof typeof icons
}

export const TABS: TabDef[] = [
  { name: 'index', label: 'Home', icon: 'home' },
  { name: 'library', label: 'Library', icon: 'library' },
  { name: 'now', label: 'Now Playing', icon: 'nowPlaying' },
  { name: 'stats', label: 'Stats', icon: 'stats' },
  { name: 'more', label: 'More', icon: 'more' },
]

export function AppTabBar({
  activeName,
  onPressTab,
}: {
  /** Route name of the active tab, or null when none should read as active. */
  activeName: string | null
  onPressTab: (name: string) => void
}) {
  const insets = useSafeAreaInsets()
  const colors = useColors()
  return (
    <View
      style={[
        styles.bar,
        {
          height: TAB_BAR_HEIGHT + insets.bottom,
          paddingBottom: insets.bottom,
          backgroundColor: colors.popover,
          borderTopColor: colors.hairline,
        },
      ]}
    >
      {TABS.map((meta) => {
        const focused = meta.name === activeName
        const tint = focused ? colors.accent : colors.textMuted
        return (
          <Pressable
            key={meta.name}
            style={({ pressed }) => [styles.tab, pressed && styles.tabPressed]}
            onPress={() => {
              if (focused) {
                // Re-tapping the active tab: ask its root to scroll to top.
                emitTabReselect(meta.name)
              } else {
                haptics.select()
              }
              onPressTab(meta.name)
            }}
          >
            <TabPill focused={focused} activeColor={colors.accentTile}>
              <Icon name={iconFor(meta.icon, focused)} size={22} color={tint} />
            </TabPill>
            <Text
              style={[styles.tabLabel, { color: tint }, focused && styles.tabLabelActive]}
              numberOfLines={1}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
            >
              {meta.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

/** The active-tab pill pops in with the app's standard spring when focused. */
function TabPill({
  focused,
  activeColor,
  children,
}: {
  focused: boolean
  activeColor: string
  children: React.ReactNode
}) {
  const scale = useSharedValue(1)
  useEffect(() => {
    if (focused) {
      scale.value = 0.7
      scale.value = withSpring(1, POP_SPRING)
    }
  }, [focused, scale])
  const animated = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }))
  return (
    <Animated.View style={[styles.pill, focused && { backgroundColor: activeColor }, animated]}>
      {children}
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  // DS: each tab has vertical padding so the pill has room and its rounded ends
  // aren't clipped by the bar's top border; 4px pill->label gap.
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingVertical: 5,
  },
  tabPressed: { opacity: 0.6 },
  // Ember-wash rounded pill behind the active icon (accent @ ~22%). DS: 60x30,
  // fully rounded; overflow:hidden so the corners clip cleanly.
  pill: {
    width: 60,
    height: 30,
    borderRadius: radius.pill,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabLabel: {
    fontSize: 10,
    fontWeight: '600',
    fontFamily: fonts.sans,
    letterSpacing: 0.1,
  },
  tabLabelActive: { fontWeight: '700' },
})
