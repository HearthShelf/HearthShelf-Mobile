import { useAuth } from '@clerk/expo'
import { ScrollView, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import Constants from 'expo-constants'
import { clearSession, clearLastServerId } from '@/api/session'
import { clearTrack } from '@/player/store'
import { clearAutoSession } from '@/player/autoBridge'
import { AppText, IconButton, Row, Screen, SectionHeader, icons } from '@/ui/primitives'
import { colors, spacing } from '@/ui/theme'
import { type IconName } from '@/ui/icons'

export default function MoreScreen() {
  const { signOut } = useAuth()
  const router = useRouter()

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

  return (
    <Screen>
      <SectionHeader title="More" />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140, gap: spacing.sm }}>
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

const styles = StyleSheet.create({
  aboutRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
})
