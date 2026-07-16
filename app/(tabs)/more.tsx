/**
 * The More tab IS the settings menu - no "More > Settings > section" double hop.
 * One account hero card at the top, then the grouped drill-down (each row pushes
 * a dedicated panel in app/settings/*), and finally a single admin-only door to
 * Server Admin. Everyday users never see the admin section, so their menu stays
 * short; admins get one entrance into the deeper server management UI.
 *
 * The old dedicated settings menu (app/settings/index.tsx) is gone; its groups
 * live here now, and app/settings only holds the detail panels + native-header
 * stack. Keeping the menu on the tab removes a whole navigation level.
 */
import { useUser } from '@clerk/expo'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native'
import { useFocusEffect, useRouter, type Href } from 'expo-router'
import Constants from 'expo-constants'
import { useConnection } from '@/api/ConnectionProvider'
import { getClubs } from '@/api/clubs'
import { getSettingsState, setSetting, subscribeSettings } from '@/store/settings'
import { AppText, Screen, SectionHeader } from '@/ui/primitives'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { Icon, type IconName } from '@/ui/icons'
import { SettingsGroup, SettingsLabel, SettingsRow, SettingsToggle } from '@/ui/settingsControls'
import { useContentInset } from '@/ui/useContentInset'
import { useBackHandler } from '@/ui/useBackHandler'
import { onTabReselect } from '@/ui/tabReselect'

interface MenuItem {
  icon: IconName
  title: string
  desc: string
  href: Href
}

interface MenuItemEx extends MenuItem {
  /** Extra fuzzy-match terms for settings search (synonyms, sub-setting names). */
  keywords?: string[]
}

const GROUPS: { label: string; items: MenuItemEx[] }[] = [
  {
    label: 'You',
    items: [
      {
        icon: 'palette',
        title: 'Appearance & feel',
        desc: 'Theme, accent colour, covers, haptics.',
        href: '/settings/appearance',
        keywords: ['dark mode', 'light', 'oled', 'accent', 'color', 'colour', 'vibration', 'haptics', 'feedback'],
      },
      {
        icon: 'notifications',
        title: 'Notifications',
        desc: 'Release alerts and the books you follow.',
        href: '/settings/notifications',
        keywords: ['push', 'alerts', 'follow'],
      },
    ],
  },
  {
    label: 'Playback',
    items: [
      {
        icon: 'speed',
        title: 'Player',
        desc: 'Background, speed, skip, buttons.',
        href: '/settings/playback',
        keywords: ['speed', 'skip forward', 'skip back', 'hotspots', 'carousel', 'buttons', 'crossfade'],
      },
      {
        icon: 'bedtime',
        title: 'Sleep timer',
        desc: 'Rewind, fade, warning beeps, shake.',
        href: '/settings/sleep',
        keywords: ['sleep', 'rewind', 'fade', 'beep', 'shake', 'chapter', 'auto timer', 'quiet hours'],
      },
      {
        icon: 'queue-music',
        title: 'Queue',
        desc: 'Mode, Auto rules, and hidden shelves.',
        href: '/settings/queue',
        keywords: ['up next', 'auto', 'manual', 'rules', 'hidden', 'not right now'],
      },
      {
        icon: 'download',
        title: 'Downloads & storage',
        desc: 'Offline books, auto-download, space used.',
        href: '/settings/storage',
        keywords: ['offline', 'download', 'storage', 'space', 'cache'],
      },
    ],
  },
  {
    label: 'Reading',
    items: [
      {
        icon: 'menu-book',
        title: 'Reading',
        desc: 'Ebook reader preferences.',
        href: '/settings/reading',
        keywords: ['ebook', 'reader', 'font', 'typeface', 'text size', 'theme', 'layout'],
      },
    ],
  },
  {
    label: 'Community',
    items: [
      {
        icon: 'groups',
        title: 'Sharing & clubs',
        desc: 'Sharing, book clubs, and note pops.',
        href: '/settings/community',
        keywords: ['share', 'clubs', 'notes', 'pops', 'search', 'beyond your library'],
      },
      {
        icon: 'hub',
        title: 'Integrations',
        desc: 'Hardcover, Goodreads import, external links.',
        href: '/settings/integrations',
        keywords: ['hardcover', 'goodreads', 'audible', 'import', 'external links'],
      },
    ],
  },
  {
    label: 'Account',
    items: [
      {
        icon: 'dns',
        title: 'My servers',
        desc: 'Switch and manage linked servers.',
        href: '/settings/servers',
        keywords: ['server', 'default', 'link', 'connect'],
      },
    ],
  },
]

export default function MoreScreen() {
  const router = useRouter()
  const { user } = useUser()
  const { activeRole } = useConnection()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const contentInset = useContentInset()
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)

  const scrollRef = useRef<ScrollView>(null)
  // Re-tapping the More tab while already on it scrolls back to the top.
  useEffect(
    () => onTabReselect('more', () => scrollRef.current?.scrollTo({ y: 0, animated: true })),
    [],
  )

  // Non-home tab: hardware back returns to Home rather than exiting the app.
  useBackHandler(
    useCallback(() => {
      router.replace('/(tabs)')
      return true
    }, [router]),
  )

  // Show the "Book Clubs" shortcut only when the reader is actually in a club
  // (and hasn't turned the feature off). Refetched each time More regains focus.
  const [clubCount, setClubCount] = useState(0)
  useFocusEffect(
    useCallback(() => {
      if (!s.clubsEnabled) {
        setClubCount(0)
        return
      }
      let cancelled = false
      void getClubs().then((res) => {
        if (!cancelled) setClubCount(res.enabled ? res.mine.length : 0)
      })
      return () => {
        cancelled = true
      }
    }, [s.clubsEnabled]),
  )

  const displayName = user?.fullName || user?.username || 'You'
  const email = user?.primaryEmailAddress?.emailAddress ?? ''
  const initial = displayName.charAt(0).toUpperCase()

  // Settings search: fuzzy-match a row's title, description, and synonym
  // keywords, then show only the groups with a hit. 17 settings routes is a long
  // enough list to warrant this.
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const filteredGroups = useMemo(() => {
    if (!needle) return GROUPS
    const hit = (it: MenuItemEx) =>
      it.title.toLowerCase().includes(needle) ||
      it.desc.toLowerCase().includes(needle) ||
      (it.keywords ?? []).some((k) => k.includes(needle))
    return GROUPS.map((g) => ({ ...g, items: g.items.filter(hit) })).filter((g) => g.items.length > 0)
  }, [needle])

  return (
    <Screen>
      <SectionHeader title="More" />
      <ScrollView
        ref={scrollRef}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          padding: spacing.lg,
          paddingBottom: contentInset,
          gap: spacing.md,
        }}
      >
        <View style={styles.searchPill}>
          <Icon name="search" size={18} color={colors.textMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search settings"
            placeholderTextColor={colors.textFaint}
            style={styles.searchInput}
            autoCorrect={false}
            autoCapitalize="none"
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8}>
              <Icon name="close" size={18} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>

        {needle ? (
          filteredGroups.length === 0 ? (
            <AppText
              variant="meta"
              color={colors.textMuted}
              style={{ textAlign: 'center', paddingVertical: spacing.xl }}
            >
              No settings match "{query.trim()}".
            </AppText>
          ) : (
            filteredGroups.map((group) => (
              <View key={group.label}>
                <SettingsLabel>{group.label}</SettingsLabel>
                <SettingsGroup>
                  {group.items.map((item, i) => (
                    <SettingsRow
                      key={item.title}
                      icon={item.icon}
                      title={item.title}
                      desc={item.desc}
                      onPress={() => router.push(item.href)}
                      last={i === group.items.length - 1}
                    />
                  ))}
                </SettingsGroup>
              </View>
            ))
          )
        ) : (
          <>
        <Pressable
          onPress={() => router.push('/settings/account')}
          style={({ pressed }) => [styles.userCard, pressed && styles.pressed]}
        >
          <View style={styles.avatar}>
            <AppText variant="mono" color={colors.brandHearth} style={{ fontSize: 19 }}>
              {initial}
            </AppText>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <AppText variant="label" numberOfLines={1}>
              {displayName}
            </AppText>
            {email ? (
              <AppText
                variant="caption"
                color={colors.textMuted}
                numberOfLines={1}
                style={{ marginTop: 2 }}
              >
                {email}
              </AppText>
            ) : (
              <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
                Account & sign-out
              </AppText>
            )}
          </View>
          <Icon name="chevron-right" size={22} color={colors.textMuted} />
        </Pressable>

        {s.clubsEnabled && clubCount > 0 ? (
          <SettingsGroup>
            <SettingsRow
              icon="groups"
              title="Book Clubs"
              desc={`${clubCount} ${clubCount === 1 ? 'club' : 'clubs'} you're in.`}
              onPress={() => router.push('/club?from=more')}
              last
            />
          </SettingsGroup>
        ) : null}

        {GROUPS.map((group) => (
          <View key={group.label}>
            <SettingsLabel>{group.label}</SettingsLabel>
            <SettingsGroup>
              {group.items.map((item, i) => (
                <SettingsRow
                  key={item.title}
                  icon={item.icon}
                  title={item.title}
                  desc={item.desc}
                  onPress={() => router.push(item.href)}
                  last={i === group.items.length - 1}
                />
              ))}
            </SettingsGroup>
          </View>
        ))}

        {activeRole === 'admin' ? (
          <View>
            <SettingsLabel>Administration</SettingsLabel>
            <SettingsGroup>
              <SettingsRow
                icon="admin-panel-settings"
                title="Server Admin"
                desc="Manage this server, its users, and libraries."
                onPress={() => router.push('/settings/admin')}
                last
              />
            </SettingsGroup>
          </View>
        ) : null}

        <View key="Advanced">
          <SettingsLabel>Advanced</SettingsLabel>
          <SettingsGroup>
            <SettingsRow
              icon="sync"
              title="Sync settings"
              desc="Use cloud synced settings. Turn off to keep settings local."
              control={
                <SettingsToggle
                  on={s.useSharedSettings}
                  onChange={(v) => setSetting('useSharedSettings', v)}
                />
              }
            />
            {/* TEMP diagnostics dump - remove with app/settings/diagnostics.tsx */}
            <SettingsRow
              icon="bug-report"
              title="Diagnostics"
              desc="Device + layout info dump to copy out."
              onPress={() => router.push('/settings/diagnostics')}
              last
            />
          </SettingsGroup>
        </View>

        <View style={styles.aboutRow}>
          <AppText variant="meta" color={colors.textMuted}>
            HearthShelf Mobile
          </AppText>
          <AppText variant="meta" color={colors.textFaint}>
            {(Constants.expoConfig?.extra?.fullVersion as string | undefined) ??
              Constants.expoConfig?.version ??
              'DEV BUILD'}
          </AppText>
        </View>
          </>
        )}
      </ScrollView>
    </Screen>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    userCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
      backgroundColor: colors.card,
      borderRadius: radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    pressed: { opacity: 0.7 },
    searchPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    searchInput: {
      flex: 1,
      paddingVertical: spacing.sm + 2,
      color: colors.text,
      fontSize: 15,
    },
    avatar: {
      width: 52,
      height: 52,
      borderRadius: 26,
      backgroundColor: colors.accentTile,
      alignItems: 'center',
      justifyContent: 'center',
    },
    aboutRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      marginTop: spacing.xs,
    },
  })
