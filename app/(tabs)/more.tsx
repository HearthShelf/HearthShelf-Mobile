import { useAuth, useUser } from '@clerk/expo'
import { useMemo } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import Constants from 'expo-constants'
import { clearSession, clearLastServerId } from '@/api/session'
import { clearTrack } from '@/player/store'
import { clearAutoSession } from '@/player/autoBridge'
import { AppText, IconButton, Row, Screen, SectionHeader, icons } from '@/ui/primitives'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { type IconName } from '@/ui/icons'
import { useContentInset } from '@/ui/useContentInset'

export default function MoreScreen() {
  const { signOut } = useAuth()
  const { user } = useUser()
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const contentInset = useContentInset()

  async function handleSignOut() {
    clearTrack()
    clearAutoSession()
    await clearSession()
    await signOut()
    router.replace('/sign-in')
  }

  async function switchServer() {
    // Drop the active session + remembered server so the home connect flow shows
    // the picker again, then bounce through the gate.
    clearTrack()
    clearAutoSession()
    await clearSession()
    await clearLastServerId()
    router.replace('/(tabs)')
  }

  const displayName = user?.fullName || user?.username || 'You'
  const email = user?.primaryEmailAddress?.emailAddress ?? ''
  const initial = displayName.charAt(0).toUpperCase()

  return (
    <Screen>
      <SectionHeader title="More" />
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: contentInset, gap: spacing.sm }}
      >
        <Pressable
          onPress={() => router.push('/settings')}
          style={({ pressed }) => [styles.profileCard, pressed && styles.pressed]}
        >
          <View style={styles.avatar}>
            <AppText variant="mono" color={colors.brandHearth} style={{ fontSize: 18 }}>
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
            ) : null}
          </View>
          <IconButton name={icons.chevronRight} color={colors.textMuted} />
        </Pressable>

        <Group label="Server">
          <SettingRow icon={icons.server} label="Switch server" onPress={switchServer} />
        </Group>

        <Group label="Account">
          <SettingRow icon={icons.signOut} label="Sign out" danger onPress={handleSignOut} />
        </Group>

        <Group label="About">
          <View style={styles.aboutRow}>
            <AppText variant="meta" color={colors.textMuted}>
              HearthShelf Mobile
            </AppText>
            <AppText variant="meta" color={colors.textFaint}>
              v{Constants.expoConfig?.version ?? '0.0.1'}
            </AppText>
          </View>
        </Group>
      </ScrollView>
    </Screen>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  const colors = useColors()
  return (
    <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
      <AppText variant="caption" color={colors.textMuted} style={{ marginLeft: spacing.xs }}>
        {label.toUpperCase()}
      </AppText>
      {children}
    </View>
  )
}

function SettingRow({
  icon,
  label,
  onPress,
  danger,
}: {
  icon: IconName
  label: string
  onPress: () => void
  danger?: boolean
}) {
  const colors = useColors()
  const tint = danger ? colors.destructive : colors.text
  return (
    <Row onPress={onPress}>
      <IconButton name={icon} size={22} color={tint} />
      <AppText variant="label" color={tint} style={{ flex: 1 }}>
        {label}
      </AppText>
      <IconButton name={icons.chevronRight} color={colors.textMuted} />
    </Row>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
  profileCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.accentTile,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
  aboutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  })
