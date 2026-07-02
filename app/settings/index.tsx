/**
 * Settings menu - the grouped drill-down list. Mirrors the WebApp settings IA
 * (You / Listening / Reading / HearthShelf); each row pushes a dedicated panel
 * screen (see the sibling files + _layout.tsx). Replaces the old single-scroll
 * accordion for a smoother, more native feel.
 */
import { useUser } from '@clerk/expo'
import { useMemo } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useRouter, type Href } from 'expo-router'
import { AppText } from '@/ui/primitives'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { Icon, type IconName } from '@/ui/icons'
import { SettingsGroup, SettingsLabel, SettingsRow } from '@/ui/settingsControls'

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
      { icon: 'person', title: 'Account', desc: 'Your profile and sign-out.', href: '/settings/account' },
      { icon: 'palette', title: 'Appearance', desc: 'Theme, accent colour, covers.', href: '/settings/appearance' },
    ],
  },
  {
    label: 'Listening',
    items: [
      { icon: 'speed', title: 'Playback', desc: 'Speed, skip, queue, player buttons.', href: '/settings/playback' },
      { icon: 'bedtime', title: 'Sleep timer', desc: 'Rewind, chapter, and fade behaviour.', href: '/settings/sleep' },
      { icon: 'vibration', title: 'Haptics', desc: 'Feedback and intensity on this device.', href: '/settings/haptics' },
    ],
  },
  {
    label: 'Reading',
    items: [{ icon: 'menu-book', title: 'Reading', desc: 'Ebook reader preferences.', href: '/settings/reading' }],
  },
  {
    label: 'HearthShelf',
    items: [
      { icon: 'person', title: 'Social', desc: 'Listening-now sharing and club note pops.', href: '/settings/social' },
      { icon: 'hub', title: 'Connections', desc: 'Hardcover and external links.', href: '/settings/connections' },
      { icon: 'dns', title: 'My servers', desc: 'Switch and manage linked servers.', href: '/settings/servers' },
    ],
  },
]

export default function SettingsMenu() {
  const router = useRouter()
  const { user } = useUser()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const displayName = user?.fullName || user?.username || 'You'
  const email = user?.primaryEmailAddress?.emailAddress ?? ''
  const initial = displayName.charAt(0).toUpperCase()

  return (
    <ScrollView contentContainerStyle={styles.content}>
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
            <AppText variant="caption" color={colors.textMuted} numberOfLines={1} style={{ marginTop: 2 }}>
              {email}
            </AppText>
          ) : null}
        </View>
        <Icon name="chevron-right" size={22} color={colors.textMuted} />
      </Pressable>

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
    </ScrollView>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    content: { padding: spacing.lg, paddingBottom: spacing.xxl, gap: spacing.md },
    userCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
      backgroundColor: colors.card,
      borderRadius: radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      marginBottom: spacing.sm,
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
  })
