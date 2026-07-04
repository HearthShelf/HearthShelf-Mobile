/**
 * Account & HearthShelf Account. Reached from the profile card / menu. Mirrors the
 * WebApp's AccountSettings.tsx scope (profile note, real Clerk identity fields,
 * sign out) - password/SSO management stays in Clerk's hosted UI for now, so this
 * is a read view + sign out rather than a form. Header comes from settings/_layout.
 */
import { useMemo } from 'react'
import { useAuth, useUser } from '@clerk/expo'
import { useRouter } from 'expo-router'
import { StyleSheet, View } from 'react-native'
import { clearSession } from '@/api/session'
import { clearTrack } from '@/player/store'
import { clearAutoSession } from '@/player/autoBridge'
import { stopQueueSync } from '@/player/queueSync'
import { AppText } from '@/ui/primitives'
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { confirm } from '@/ui/confirm'
import { SettingsPanel, SettingsGroup, SettingsRow } from '@/ui/settingsControls'
import { SettingsToggle } from '@/ui/settingsControls'
import { getSettingsState, setSetting, subscribeSettings } from '@/store/settings'
import { useSyncExternalStore } from 'react'

function fmtDay(d: Date | null | undefined): string {
  if (!d) return '-'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function AccountScreen() {
  const router = useRouter()
  const { user } = useUser()
  const { signOut } = useAuth()
  const settings = useSyncExternalStore(subscribeSettings, getSettingsState)
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const displayName = user?.fullName || user?.username || 'You'
  const email = user?.primaryEmailAddress?.emailAddress ?? 'Not set'
  const memberSince = fmtDay(user?.createdAt)
  const initial = displayName.charAt(0).toUpperCase()

  async function handleSignOut() {
    if (
      !(await confirm({
        title: 'Sign out',
        message: 'Sign out of HearthShelf on this device? Your downloads stay, but you’ll need to sign in again.',
        confirmLabel: 'Sign out',
      }))
    )
      return
    clearTrack()
    clearAutoSession()
    stopQueueSync()
    await clearSession()
    await signOut()
    router.replace('/sign-in')
  }

  return (
    <SettingsPanel>
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
        <SettingsRow
          icon="account-circle"
          title="Profile photo"
          desc="Shown from your HearthShelf account. Mobile upload needs the native image-picker pass."
        />
        <SettingsRow
          icon="public"
          title="Use Gravatar"
          desc="Show your Gravatar when no profile photo is uploaded."
          control={
            <SettingsToggle
              on={settings.useGravatar}
              onChange={(v) => setSetting('useGravatar', v)}
            />
          }
        />
        <SettingsRow icon="badge" title="Account type" desc="HearthShelf account" />
        <SettingsRow icon="calendar-today" title="Member since" desc={memberSince} last />
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow icon="logout" title="Sign out" danger onPress={handleSignOut} last />
      </SettingsGroup>
    </SettingsPanel>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
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
