/**
 * The More tab's popup menu: a bubble anchored to the tab that lists the app's
 * secondary destinations. Tapping More opens this instead of navigating, so
 * reaching Discover, Downloads or the admin surface costs one tap and leaves the
 * current screen mounted behind it. app/(tabs)/_layout.tsx intercepts the More
 * press; MoreMenuHost mounts the bubble at the app root, above every screen and
 * above the mini player dock.
 *
 * The bubble grows out of its bottom-right corner - the corner nearest the tab -
 * so it reads as unfolding from the thing that was tapped. Modelled on
 * docs/redesign/more-menu.html.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Pressable, StyleSheet, View, type ViewStyle } from 'react-native'
import { useRouter, type Href } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
  Easing,
} from 'react-native-reanimated'
import { useConnection } from '@/api/ConnectionProvider'
import { AppText } from './primitives'
import { Icon, icons } from './icons'
import { useBackHandler } from './useBackHandler'
import { getMoreMenuOpen, setMoreMenuOpen, subscribeMoreMenu } from './moreMenuState'
import { haptics } from './haptics'
import {
  BUBBLE_CLOSE_MS,
  BUBBLE_ROW_FADE_MS,
  BUBBLE_SPRING,
  BUBBLE_STAGGER_DELAY_MS,
  BUBBLE_STAGGER_MS,
  useReducedMotion,
} from './motion'
import {
  FLOATING_PILL_CLEARANCE,
  TAB_BAR_HEIGHT,
  VNAV_WIDTH,
  useNavMode,
  type NavMode,
} from './AppTabBar'
import { radius, spacing, type Palette } from './theme'
import { useColors } from './ThemeProvider'

const BUBBLE_WIDTH = 232
/** Start scale: small enough to read as a point at the corner rather than as an
 *  already-visible rectangle (design.md). */
const START_SCALE = 0.04

interface MenuEntry {
  id: string
  label: string
  icon: keyof typeof icons
  href: Href
  /** Dividers are derived from group changes, so omitting an entry can never
   *  leave a stray divider behind. */
  group: 1 | 2 | 3
  /** False for destinations whose screens don't exist on this platform yet, and
   *  for entries the current role can't use. Those rows are omitted entirely. */
  available: boolean
}

/**
 * Every destination in display order. `available` hides a row whose screen does
 * not exist on this platform, or that the current role cannot use.
 */
function buildEntries(isAdmin: boolean): MenuEntry[] {
  return [
    {
      id: 'discover',
      label: 'Discover',
      icon: 'sparkle',
      href: '/discover?from=more',
      group: 1,
      available: true,
    },
    {
      id: 'questgiver',
      label: 'QuestGiver',
      icon: 'questGiver',
      href: '/questgiver',
      group: 1,
      available: true,
    },
    {
      id: 'downloads',
      label: 'Downloads',
      icon: 'download',
      href: '/settings/storage',
      group: 2,
      available: true,
    },
    {
      id: 'history',
      label: 'History',
      icon: 'history',
      href: '/history',
      group: 2,
      available: true,
    },
    {
      id: 'collections',
      label: 'Collections',
      icon: 'collections',
      href: '/collections',
      group: 2,
      available: true,
    },
    {
      id: 'playlists',
      label: 'Playlists',
      icon: 'playlists',
      href: '/playlists',
      group: 2,
      available: true,
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: 'settings',
      href: '/settings',
      group: 3,
      available: true,
    },
    {
      id: 'server-settings',
      label: 'Server Settings',
      icon: 'serverSettings',
      href: '/settings/admin',
      group: 3,
      available: isAdmin,
    },
  ]
}

/**
 * Where the bubble sits per nav treatment. All three navs live at the bottom, so
 * the anchor rule (grow from the bottom-right corner) is the same everywhere -
 * only the offset differs. The vertical rail hugs the right edge, so the bubble
 * clears it sideways rather than upward.
 */
function anchorFor(mode: NavMode, bottomInset: number): ViewStyle {
  if (mode === 'floating-vertical') {
    return { right: VNAV_WIDTH + spacing.md, bottom: bottomInset + spacing.lg }
  }
  const barHeight = mode === 'classic' ? TAB_BAR_HEIGHT : FLOATING_PILL_CLEARANCE
  return { right: spacing.md, bottom: bottomInset + barHeight + spacing.sm }
}

/**
 * Mounts the bubble at the app root, after the mini player dock, so it draws
 * over it. Rendering it inside the tabs layout put it earlier in the root's
 * child order, and on Android the dock's floating card (elevation 12) also
 * outranked it - either way the mini player showed through the menu.
 */
export function MoreMenuHost() {
  const open = useSyncExternalStore(subscribeMoreMenu, getMoreMenuOpen)
  return <MoreMenu open={open} onClose={() => setMoreMenuOpen(false)} />
}

export function MoreMenu({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const insets = useSafeAreaInsets()
  const navMode = useNavMode()
  const reducedMotion = useReducedMotion()
  const { activeRole } = useConnection()

  // Rebuilt per render, so a role or server change is reflected the next time
  // the menu opens without needing a restart.
  const entries = useMemo(
    () => buildEntries(activeRole === 'admin').filter((e) => e.available),
    [activeRole],
  )

  // The bubble has to outlive `open` going false so the close animation can run;
  // `mounted` drops it once that finishes.
  const [mounted, setMounted] = useState(open)
  const progress = useSharedValue(open ? 1 : 0)

  useEffect(() => {
    if (open) {
      setMounted(true)
      progress.value = reducedMotion ? 1 : withSpring(1, BUBBLE_SPRING)
      return
    }
    if (reducedMotion) {
      progress.value = 0
      setMounted(false)
      return
    }
    progress.value = withTiming(0, {
      duration: BUBBLE_CLOSE_MS,
      easing: Easing.bezier(0.4, 0, 0.7, 0.4),
    })
    const t = setTimeout(() => setMounted(false), BUBBLE_CLOSE_MS)
    return () => clearTimeout(t)
  }, [open, reducedMotion, progress])

  // Android back closes the menu without reaching the router.
  useBackHandler(() => {
    onClose()
    return true
  }, open)

  // ONE spring per axis from start to rest - no intermediate waypoints, which
  // would restart the easing mid-growth and read as a stall (design.md).
  const bubbleStyle = useAnimatedStyle(() => ({
    opacity: progress.value === 0 ? 0 : Math.min(1, progress.value / 0.14),
    // `transformOrigin: 'bottom right'` on the bubble style does the corner
    // anchoring, so this is a plain scale.
    transform: [{ scale: START_SCALE + (1 - START_SCALE) * progress.value }],
  }))

  if (!mounted) return null

  const select = (href: Href) => {
    haptics.select()
    onClose()
    router.push(href)
  }

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Pressable
        style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
        onPress={onClose}
        accessibilityLabel="Close menu"
      />
      <Animated.View
        style={[styles.bubble, anchorFor(navMode, insets.bottom), bubbleStyle]}
        accessibilityRole="menu"
        accessibilityLabel="More"
      >
        {entries.map((entry, i) => {
          const prev = entries[i - 1]
          // Rows nearest the growth corner (the last ones) reveal first, so the
          // stagger travels outward with the box's edge.
          const rank = entries.length - 1 - i
          return (
            <View key={entry.id}>
              {prev && prev.group !== entry.group ? <View style={styles.divider} /> : null}
              <MenuRow
                entry={entry}
                rank={rank}
                hero={i === 0}
                open={open}
                reducedMotion={reducedMotion}
                styles={styles}
                colors={colors}
                onPress={() => select(entry.href)}
              />
            </View>
          )
        })}
      </Animated.View>
    </View>
  )
}

/** One destination row. Fades and settles in on a delay derived from its
 *  distance from the growth corner. */
function MenuRow({
  entry,
  rank,
  hero,
  open,
  reducedMotion,
  styles,
  colors,
  onPress,
}: {
  entry: MenuEntry
  rank: number
  hero: boolean
  open: boolean
  reducedMotion: boolean
  styles: ReturnType<typeof makeStyles>
  colors: Palette
  onPress: () => void
}) {
  const shown = useSharedValue(reducedMotion || !open ? 1 : 0)

  useEffect(() => {
    if (reducedMotion) {
      shown.value = 1
      return
    }
    if (open) {
      shown.value = withDelay(
        rank * BUBBLE_STAGGER_MS + BUBBLE_STAGGER_DELAY_MS,
        withTiming(1, { duration: BUBBLE_ROW_FADE_MS, easing: Easing.out(Easing.quad) }),
      )
    }
  }, [open, reducedMotion, rank, shown])

  const style = useAnimatedStyle(() => ({
    opacity: shown.value,
    transform: [{ translateX: (1 - shown.value) * 6 }, { translateY: (1 - shown.value) * 3 }],
  }))

  return (
    <Animated.View style={style}>
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={onPress}
        accessibilityRole="menuitem"
        accessibilityLabel={entry.label}
      >
        <View style={[styles.rowIcon, hero && { backgroundColor: colors.accentWash }]}>
          <Icon
            name={icons[entry.icon]}
            size={16}
            color={hero ? colors.accent : colors.textMuted}
          />
        </View>
        <AppText variant="label" numberOfLines={1} style={styles.rowLabel}>
          {entry.label}
        </AppText>
      </Pressable>
    </Animated.View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    bubble: {
      position: 'absolute',
      width: BUBBLE_WIDTH,
      backgroundColor: colors.sheet,
      borderRadius: radius.sheet,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      padding: spacing.sm,
      // Grow from the corner nearest the More tab.
      transformOrigin: 'bottom right',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 18 },
      shadowOpacity: 0.55,
      shadowRadius: 44,
      elevation: 18,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md - 1,
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.sm + 2,
      borderRadius: radius.row,
    },
    rowPressed: { backgroundColor: colors.fill },
    rowIcon: {
      width: 28,
      height: 28,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.fill,
    },
    rowLabel: { flex: 1, minWidth: 0 },
    divider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.hairline,
      marginVertical: spacing.xs + 1,
      marginHorizontal: spacing.sm,
    },
  })
