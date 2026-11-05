/**
 * Settings drill-down stack. `index` is the grouped menu (pushed from the More
 * menu's Settings entry); the rest are its detail panels. Each screen gets a
 * native header, back button, and back-swipe. Header
 * colours track the active theme (useTheme), so the whole flow re-skins with
 * Light/OLED/accent.
 */
import { Stack } from 'expo-router'
import { usePathname, useRouter } from 'expo-router'
import { StyleSheet, View } from 'react-native'
import Constants from 'expo-constants'
import { AppTabBar, useGoToTab } from '@/ui/AppTabBar'
import { BlurTargetView } from 'expo-blur'
import { useScreenBlurTarget } from '@/ui/BlurTarget'
import { AppText } from '@/ui/primitives'
import { useTheme } from '@/ui/ThemeProvider'
import { fonts, spacing } from '@/ui/theme'

/** The running build, shown in the settings header so "what version am I on?"
 *  is answerable without scrolling to the bottom of the list. */
function VersionBadge() {
  const { colors } = useTheme()
  const version =
    (Constants.expoConfig?.extra?.fullVersion as string | undefined) ??
    Constants.expoConfig?.version ??
    'DEV BUILD'
  return (
    <AppText variant="meta" color={colors.textFaint} style={{ marginRight: spacing.md }}>
      {version}
    </AppText>
  )
}

export default function SettingsLayout() {
  const { colors } = useTheme()
  const router = useRouter()
  const pathname = usePathname()
  const hideTabs = pathname.startsWith('/settings/admin')
  const blurTarget = useScreenBlurTarget()

  const goToTab = useGoToTab()

  return (
    <View style={styles.root}>
      <BlurTargetView ref={blurTarget} style={styles.stack}>
        <Stack
          screenOptions={{
            headerShown: true,
            headerStyle: { backgroundColor: colors.scaffold },
            headerTintColor: colors.text,
            headerTitleStyle: { fontFamily: fonts.sans, fontWeight: '700', color: colors.text },
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.scaffold },
            animation: 'slide_from_right',
          }}
        >
          <Stack.Screen
            name="index"
            options={{ title: 'Settings', headerRight: () => <VersionBadge /> }}
          />
          <Stack.Screen name="appearance" options={{ title: 'Appearance & feel' }} />
          <Stack.Screen name="playback" options={{ title: 'Player' }} />
          <Stack.Screen name="sleep" options={{ title: 'Sleep timer' }} />
          <Stack.Screen name="storage" options={{ title: 'Downloads & storage' }} />
          <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
          <Stack.Screen name="community" options={{ title: 'Sharing & clubs' }} />
          <Stack.Screen name="reading" options={{ title: 'Reading' }} />
          <Stack.Screen name="integrations" options={{ title: 'Integrations' }} />
          <Stack.Screen name="account" options={{ title: 'Account' }} />
          <Stack.Screen name="security" options={{ title: 'Sign-in & security' }} />
          <Stack.Screen name="servers" options={{ title: 'My libraries' }} />
          <Stack.Screen name="admin/index" options={{ title: 'Server Admin' }} />
          <Stack.Screen name="admin/stats" options={{ title: 'Stats' }} />
          <Stack.Screen name="admin/sessions" options={{ title: 'Listening sessions' }} />
          <Stack.Screen name="admin/tasks" options={{ title: 'Tasks' }} />
          <Stack.Screen name="admin/rss" options={{ title: 'RSS feeds' }} />
          <Stack.Screen name="admin/users/index" options={{ title: 'Users' }} />
          <Stack.Screen name="admin/users/[id]" options={{ title: 'User' }} />
          <Stack.Screen name="admin/users/account" options={{ title: 'Edit account' }} />
          <Stack.Screen name="admin/users/permissions" options={{ title: 'Edit permissions' }} />
          <Stack.Screen name="admin/users/password" options={{ title: 'Reset password' }} />
          <Stack.Screen name="admin/users/add" options={{ title: 'Add user' }} />
          <Stack.Screen name="admin/users/invite" options={{ title: 'Invites' }} />
          <Stack.Screen name="admin/users/bulk" options={{ title: 'Edit permissions' }} />
          <Stack.Screen name="admin/libraries/index" options={{ title: 'Libraries' }} />
          <Stack.Screen name="admin/libraries/new" options={{ title: 'New library' }} />
          <Stack.Screen name="admin/libraries/[id]" options={{ title: 'Library' }} />
          <Stack.Screen name="admin/libraries/[id]/details" options={{ title: 'Details' }} />
          <Stack.Screen name="admin/libraries/[id]/settings" options={{ title: 'Settings' }} />
          <Stack.Screen name="admin/libraries/[id]/scanner" options={{ title: 'Scanner' }} />
          <Stack.Screen name="admin/libraries/[id]/schedule" options={{ title: 'Schedule' }} />
          <Stack.Screen name="admin/libraries/[id]/tools" options={{ title: 'Tools' }} />
          <Stack.Screen name="admin/general" options={{ title: 'General' }} />
          <Stack.Screen name="admin/community" options={{ title: 'Community' }} />
          <Stack.Screen name="admin/notifications" options={{ title: 'Notifications' }} />
          <Stack.Screen name="admin/metadata" options={{ title: 'Tags and genres' }} />
          <Stack.Screen name="admin/apikeys" options={{ title: 'API keys' }} />
          <Stack.Screen name="admin/email" options={{ title: 'Email' }} />
          <Stack.Screen name="admin/connect" options={{ title: 'HearthShelf Connect' }} />
          <Stack.Screen name="admin/backups" options={{ title: 'Backups' }} />
          <Stack.Screen name="admin/service-accounts" options={{ title: 'Service accounts' }} />
          <Stack.Screen name="admin/integrations" options={{ title: 'Integrations' }} />
          <Stack.Screen name="admin/questgiver" options={{ title: 'QuestGiver' }} />
          <Stack.Screen name="player-buttons" options={{ title: 'Player buttons' }} />
          <Stack.Screen name="navigation" options={{ title: 'Navigation' }} />
          <Stack.Screen name="queue" options={{ title: 'Queue' }} />
          {/* TEMP diagnostics dump - remove with app/settings/diagnostics.tsx */}
          <Stack.Screen name="diagnostics" options={{ title: 'Diagnostics' }} />
        </Stack>
      </BlurTargetView>
      {hideTabs ? null : <AppTabBar activeName="more" onPressTab={goToTab} />}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  stack: { flex: 1 },
})
