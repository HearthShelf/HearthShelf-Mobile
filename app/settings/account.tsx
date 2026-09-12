/**
 * Account & HearthShelf Account. Reached from the profile card / menu. Mirrors the
 * WebApp's AccountSettings.tsx scope (profile note, real Clerk identity fields,
 * sign out) - password/SSO management stays in Clerk's hosted UI for now, so this
 * is a read view + sign out rather than a form. Header comes from settings/_layout.
 */
import { useMemo } from 'react'
import { useAuth } from '@/auth/useAuth'
import { useRouter } from 'expo-router'
import { StyleSheet, View } from 'react-native'
import { clearSession } from '@/api/session'
import { clearAudibleCache } from '@/api/absAudible'
import { clearTrack } from '@/player/store'
import { clearAutoSession } from '@/player/autoBridge'
import { stopQueueSync } from '@/player/queueSync'
import { clearSubscriptions } from '@/player/subscriptions'
import { resetPushRegistration } from '@/player/pushRegister'
import { AppText } from '@/ui/primitives'
import { MyAvatar } from '@/ui/MyAvatar'
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
  const { user, signOut } = useAuth()
  const settings = useSyncExternalStore(subscribeSettings, getSettingsState)
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const displayName = user?.fullName || user?.username || 'You'
  const email = user?.primaryEmailAddress?.emailAddress ?? 'Not set'
  const memberSince = fmtDay(user?.createdAt)

  async function handleSignOut() {
    if (
      !(await confirm({
        title: 'Sign out',
        message:
          'Sign out of HearthShelf on this device? Your downloads stay, but you’ll need to sign in again.',
        confirmLabel: 'Sign out',
      }))
    )
      return
    clearTrack()
    clearAutoSession()
    stopQueueSync()
    clearAudibleCache()
    clearSubscriptions()
    resetPushRegistration()
    await clearSession()
    await signOut()
    router.replace('/sign-in')
  }

  return (
    <SettingsPanel>
      <View style={styles.heroCard}>
        <MyAvatar size={72} name={displayName} hue={colors.accentTile} />
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
          desc="Your uploaded photo, or your Gravatar. Upload one from the web app."
          control={<MyAvatar size={34} name={displayName} hue={colors.accentTile} />}
        />
        <SettingsRow
          icon="public"
          title="Use Gravatar"
          desc="Show your Gravatar when no profile photo is uploaded."
          control={
            <SettingsToggle
              // Unset means on: the server falls back to Gravatar unless the
              // user has explicitly turned it off.
              on={settings.useGravatar !== false}
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
  })
