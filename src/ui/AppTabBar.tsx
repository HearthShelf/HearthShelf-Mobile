/**
 * Presentational bottom navigation. Used by the tabs layout (driven by the
 * router's navigation state) and by the full player (so the nav stays visible
 * there unless the player is in immersive mode). Purely visual - the caller
 * decides what "active" is and what a tap does.
 *
 * Two treatments, chosen by the device-scoped `floatingNav` setting (Appearance):
 *  - Classic: the full-width bar with all five tabs (default).
 *  - Floating pill: a glass icon pill (Home / Now / Library / More) - an
 *    icon-focused A/B test. Stats loses its pinned spot and lives under More.
 * Both reserve the same layout footprint (TAB_BAR_HEIGHT + safe area), so the
 * mini player and content insets are identical either way - the pill just floats
 * inside that band instead of filling it.
 */
import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from 'react-native'
import { useSyncExternalStore } from 'react'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  Easing,
} from 'react-native-reanimated'
import { LinearGradient } from 'expo-linear-gradient'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { Icon, iconFor, icons } from './icons'
import { emitTabReselect } from './tabReselect'
import { haptics } from './haptics'
import { POP_SPRING } from './motion'
import { fonts, MAX_FONT_SCALE, radius, spacing, withAlpha, type Palette } from './theme'
import { useColors } from './ThemeProvider'

// Apple "liquid glass" glide: a softer, more fluid spring than the app's POP so
// the active lozenge flows between destinations instead of snapping. Slightly
// overdamped-forgiving (low stiffness, healthy damping) reads as liquid, not
// bouncy plastic.
const GLASS_SPRING = { damping: 18, stiffness: 210, mass: 0.9 } as const

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

/** The four destinations pinned to the floating pill, in display order. Stats is
 *  intentionally absent - it lives under More (reachable in one more tap). */
const PILL_TABS: TabDef[] = [
  { name: 'index', label: 'Home', icon: 'home' },
  { name: 'now', label: 'Now', icon: 'nowPlaying' },
  { name: 'library', label: 'Library', icon: 'library' },
  { name: 'more', label: 'More', icon: 'more' },
]

/**
 * Resolve a pushed screen's `from` route param to the tab route name that should
 * read as active while that screen is open (D-NAV). Callers pass a human tab name
 * (e.g. 'home', 'library') matching the tab they navigated from; 'home' maps to
 * the router's 'index' route. Unknown/missing values fall back to `fallback`.
 */
export function tabFromParam(from: string | undefined, fallback: string): string {
  const v = from ?? fallback
  return v === 'home' ? 'index' : v
}

export function AppTabBar({
  activeName,
  onPressTab,
}: {
  /** Route name of the active tab, or null when none should read as active. */
  activeName: string | null
  onPressTab: (name: string) => void
}) {
  const floatingNav = useSyncExternalStore(subscribeSettings, () => getSettingsState().floatingNav)
  return floatingNav ? (
    <FloatingPillNav activeName={activeName} onPressTab={onPressTab} />
  ) : (
    <ClassicTabBar activeName={activeName} onPressTab={onPressTab} />
  )
}

/** Shared tap handling: re-tapping the active tab emits a scroll-to-top signal;
 *  a fresh tab ticks a selection haptic. Both then forward to the caller. */
function handleTabPress(name: string, focused: boolean, onPressTab: (name: string) => void) {
  if (focused) emitTabReselect(name)
  else haptics.select()
  onPressTab(name)
}

// ---- Classic full-width bar ----

function ClassicTabBar({
  activeName,
  onPressTab,
}: {
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
            onPress={() => handleTabPress(meta.name, focused, onPressTab)}
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

// ---- Floating glass icon pill ----

/**
 * A centered glass pill floating inside the same bottom band the classic bar
 * would occupy - an MUI-3 floating toolbar in ember glass. Icon-focused:
 * inactive items are icon-only; the active item reveals its label while a single
 * ember lozenge glides between destinations (Apple liquid-glass motion). The
 * container is transparent to touches (content shows beneath the pill), so only
 * the pill's own buttons are tappable.
 */
function FloatingPillNav({
  activeName,
  onPressTab,
}: {
  activeName: string | null
  onPressTab: (name: string) => void
}) {
  const insets = useSafeAreaInsets()
  const colors = useColors()
  const styles = makePillStyles(colors)

  // Per-item measured rects (x within the pill row + width), keyed by tab name.
  // The active lozenge glides to the focused item's rect - the liquid-glass move.
  const [rects, setRects] = useState<Record<string, { x: number; w: number }>>({})
  const onItemLayout = (name: string) => (e: LayoutChangeEvent) => {
    const { x, width } = e.nativeEvent.layout
    setRects((prev) => {
      const cur = prev[name]
      if (cur && cur.x === x && cur.w === width) return prev
      return { ...prev, [name]: { x, w: width } }
    })
  }

  const indX = useSharedValue(0)
  const indW = useSharedValue(0)
  const indOpacity = useSharedValue(0)
  const placed = useRef(false)
  const target = activeName ? rects[activeName] : undefined
  useEffect(() => {
    if (!target) return
    // First placement snaps into position and fades in (no glide from 0);
    // every focus change after that flows with the liquid-glass spring.
    if (!placed.current) {
      placed.current = true
      indX.value = target.x
      indW.value = target.w
      indOpacity.value = withTiming(1, { duration: 160, easing: Easing.out(Easing.quad) })
    } else {
      indX.value = withSpring(target.x, GLASS_SPRING)
      indW.value = withSpring(target.w, GLASS_SPRING)
    }
  }, [target?.x, target?.w, indX, indW, indOpacity])

  const indicator = useAnimatedStyle(() => ({
    transform: [{ translateX: indX.value }],
    width: indW.value,
    opacity: indOpacity.value,
  }))

  return (
    <View
      style={[
        styles.band,
        { height: TAB_BAR_HEIGHT + insets.bottom, paddingBottom: insets.bottom },
      ]}
      pointerEvents="box-none"
    >
      <View style={styles.pill}>
        {/* Frosted-glass sheen: a soft top-to-bottom specular highlight over the
            translucent base, so the slab reads as glass, not a flat card. */}
        <LinearGradient
          pointerEvents="none"
          colors={[withAlpha('#ffffff', 0.14), 'transparent', withAlpha('#000000', 0.06)]}
          locations={[0, 0.55, 1]}
          style={styles.sheen}
        />
        {/* The gliding active lozenge, drawn beneath the items. */}
        <Animated.View pointerEvents="none" style={[styles.indicator, indicator]} />
        {PILL_TABS.map((meta) => {
          const focused = meta.name === activeName
          return (
            <PillItem
              key={meta.name}
              meta={meta}
              focused={focused}
              colors={colors}
              onLayout={onItemLayout(meta.name)}
              onPress={() => handleTabPress(meta.name, focused, onPressTab)}
            />
          )
        })}
      </View>
    </View>
  )
}

/**
 * One pill destination. The active lozenge is drawn by the parent (it glides),
 * so an item only animates its own contents: the icon settles with a fluid
 * spring and the label reveals with a width + fade as it becomes active.
 */
function PillItem({
  meta,
  focused,
  colors,
  onLayout,
  onPress,
}: {
  meta: TabDef
  focused: boolean
  colors: Palette
  onLayout: (e: LayoutChangeEvent) => void
  onPress: () => void
}) {
  const styles = makePillStyles(colors)
  // Icon pop when this item gains focus (the "grab" of liquid glass).
  const scale = useSharedValue(1)
  // 0 = inactive, 1 = active. Drives label reveal + icon tint blend timing.
  const on = useSharedValue(focused ? 1 : 0)
  useEffect(() => {
    on.value = withTiming(focused ? 1 : 0, { duration: 220, easing: Easing.out(Easing.cubic) })
    if (focused) {
      scale.value = 0.82
      scale.value = withSpring(1, GLASS_SPRING)
    }
  }, [focused, on, scale])

  const iconStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }))
  const labelStyle = useAnimatedStyle(() => ({
    opacity: on.value,
    transform: [{ translateX: (1 - on.value) * -6 }],
  }))
  const tint = focused ? colors.accent : colors.textFaint
  return (
    <Pressable onPress={onPress} hitSlop={4} onLayout={onLayout}>
      <View style={styles.item}>
        <Animated.View style={iconStyle}>
          <Icon name={iconFor(meta.icon, focused)} size={20} color={tint} />
        </Animated.View>
        {focused ? (
          <Animated.View style={labelStyle}>
            <Text style={styles.itemLabel} numberOfLines={1} maxFontSizeMultiplier={MAX_FONT_SCALE}>
              {meta.label}
            </Text>
          </Animated.View>
        ) : null}
      </View>
    </Pressable>
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

// Pill geometry, named so the gliding indicator can line up with the items.
const PILL_PAD = spacing.xs + 1 // padding inside the glass slab
const ITEM_H_PAD = spacing.md - 1
const ITEM_V_PAD = spacing.sm + 2

const makePillStyles = (colors: Palette) =>
  StyleSheet.create({
    // Fills the same footprint as the classic bar, but is transparent and lets
    // touches through except on the pill; the pill is centered along the bottom.
    band: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    // MUI-3 floating toolbar: a compact, fully-rounded slab, lifted off the
    // content with a soft shadow and a hairline edge; overflow-clipped so the
    // sheen + gliding lozenge stay inside its rounded corners.
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      padding: PILL_PAD,
      borderRadius: radius.pill,
      backgroundColor: withAlpha(colors.elevated, 0.92),
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha('#ffffff', 0.12),
      overflow: 'hidden',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 14 },
      shadowOpacity: 0.5,
      shadowRadius: 30,
      elevation: 14,
    },
    // Specular glass highlight across the whole slab.
    sheen: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
    },
    // The gliding active lozenge: an ember-wash chip that flows between items.
    // left/top/bottom match the item box so it sits exactly behind the active
    // item; x + width are animated. A hairline accent edge gives it a lit rim.
    indicator: {
      position: 'absolute',
      left: PILL_PAD,
      top: PILL_PAD,
      bottom: PILL_PAD,
      borderRadius: radius.pill,
      backgroundColor: colors.accentTile,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha(colors.accent, 0.35),
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs + 2,
      paddingHorizontal: ITEM_H_PAD,
      paddingVertical: ITEM_V_PAD,
      borderRadius: radius.pill,
    },
    itemLabel: {
      fontSize: 12,
      fontWeight: '700',
      fontFamily: fonts.sans,
      color: colors.accent,
      letterSpacing: 0.2,
    },
  })
