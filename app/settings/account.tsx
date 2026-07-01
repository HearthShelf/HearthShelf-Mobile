/**
 * Account & HearthShelf Account. Reached from the profile card on My Settings.
 * Mirrors the WebApp's AccountSettings.tsx scope (profile photo note, real
 * Clerk identity fields, sign out) - password/SSO management and avatar
 * upload stay in Clerk's own hosted UI for now, so this is a read view + sign
 * out rather than a form.
 */
import { useAuth, useUser } from '@clerk/expo'
import { useRouter } from 'expo-router'
import { StyleSheet, View } from 'react-native'
import { clearSession } from '@/api/session'
import { clearTrack } from '@/player/store'
import { clearAutoSession } from '@/player/autoBridge'
import { stopQueueSync } from '@/player/queueSync'
import { AppText, IconButton, Screen } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { colors, radius, spacing } from '@/ui/theme'
import { SettingsGroup, SettingsRow } from '@/ui/settingsControls'

function fmtDay(d: Date | null | undefined): string {
  if (!d) return '-'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function AccountScreen() {
  const router = useRouter()
  const { user } = useUser()
  const { signOut } = useAuth()

  const displayName = user?.fullName || user?.username || 'You'
  const email = user?.primaryEmailAddress?.emailAddress ?? 'Not set'
  const memberSince = fmtDay(user?.createdAt)
  const initial = displayName.charAt(0).toUpperCase()

  async function handleSignOut() {
    clearTrack()
    clearAutoSession()
    stopQueueSync()
    await clearSession()
    await signOut()
    router.replace('/sign-in')
  }

  return (
    <Screen>
      <View style={styles.header}>
        <IconButton name={icons.back} onPress={() => router.back()} style={styles.headerBtn} />
        <AppText variant="title">Account</AppText>
      </View>

      <View style={styles.content}>
        <View style={styles.heroCard}>
          <View style={styles.avatar}>
            <AppText variant="mono" color={colors.brandHearth} style={{ fontSize: 24 }}>
              {initial}
            </AppText>
          </View>
          <AppText variant="title" style={{ marginTop: spacing.md }}>
            {displayName}
          </AppText>
          <AppText variant="meta" color={colors.textMuted} style={{ marginTop: 2 }}>
            {email}
          </AppText>
        </View>

        <SettingsGroup>
          <SettingsRow icon="badge" title="Account type" desc="HearthShelf account" />
          <SettingsRow icon="calendar-today" title="Member since" desc={memberSince} last />
        </SettingsGroup>

        <SettingsGroup>
          <SettingsRow icon="logout" title="Sign out" danger onPress={handleSignOut} last />
        </SettingsGroup>
      </View>
    </Screen>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  headerBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: { padding: spacing.lg, gap: spacing.lg },
  heroCard: { alignItems: 'center', paddingVertical: spacing.xl },
  avatar: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: colors.accentTile,
    alignItems: 'center',
    justifyContent: 'center',
  },
})
