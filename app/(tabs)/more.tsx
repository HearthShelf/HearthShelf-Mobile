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
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
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

interface MenuItem {
  icon: IconName
  title: string
  desc: string
  href: Href
}

const GROUPS: { label: string; items: MenuItem[] }[] = [
  {
    label: 'You',
    items: [
      {
        icon: 'palette',
        title: 'Appearance',
        desc: 'Theme, accent colour, covers.',
        href: '/settings/appearance',
      },
      {
        icon: 'notifications',
        title: 'Notifications',
        desc: 'Release alerts and the books you follow.',
        href: '/settings/notifications',
      },
    ],
  },
  {
    label: 'Playback',
    items: [
      {
        icon: 'speed',
        title: 'Player',
        desc: 'Background, speed, skip, buttons, queue.',
        href: '/settings/playback',
      },
      {
        icon: 'bedtime',
        title: 'Sleep timer',
        desc: 'Rewind, chapter, and fade behaviour.',
        href: '/settings/sleep',
      },
      {
        icon: 'download',
        title: 'Downloads & storage',
        desc: 'Offline books, auto-download, space used.',
        href: '/settings/storage',
      },
      {
        icon: 'vibration',
        title: 'Haptics',
        desc: 'Feedback and intensity on this device.',
        href: '/settings/haptics',
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
      },
    ],
  },
  {
    label: 'Sharing & services',
    items: [
      {
        icon: 'groups',
        title: 'Community',
        desc: 'Sharing, book clubs, and note pops.',
        href: '/settings/community',
      },
      {
        icon: 'hub',
        title: 'Integrations',
        desc: 'Hardcover, Goodreads import, external links.',
        href: '/settings/integrations',
      },
      {
        icon: 'search',
        title: 'Search',
        desc: 'How far search reaches beyond your library.',
        href: '/settings/search',
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

  return (
    <Screen>
      <SectionHeader title="More" />
      <ScrollView
        contentContainerStyle={{
          padding: spacing.lg,
          paddingBottom: contentInset,
          gap: spacing.md,
        }}
      >
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
              onPress={() => router.push('/club')}
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

        <View key="Sync">
          <SettingsLabel>Sync</SettingsLabel>
          <SettingsRow
            icon="sync"
            title="Sync settings"
            desc="Use cloud synced settings. Turn off to keep settings local."
            last
            control={
              <SettingsToggle
                on={s.useSharedSettings}
                onChange={(v) => setSetting('useSharedSettings', v)}
              />
            }
          />
        </View>

        {/* TEMP diagnostics dump - remove this block with app/settings/diagnostics.tsx */}
        <View key="Diagnostics">
          <SettingsLabel>Debug</SettingsLabel>
          <SettingsGroup>
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
