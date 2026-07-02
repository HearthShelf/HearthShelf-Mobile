/**
 * Settings drill-down stack. The menu (index) lists grouped sections; each panel
 * is its own screen so it gets a native header, back button, and back-swipe -
 * smoother than the old single-scroll accordion. Header colours track the active
 * theme (useTheme), so the whole flow re-skins with Light/OLED/accent.
 */
import { Stack } from 'expo-router'
import { useTheme } from '@/ui/ThemeProvider'
import { fonts } from '@/ui/theme'

export default function SettingsLayout() {
  const { colors } = useTheme()
  return (
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
      <Stack.Screen name="index" options={{ title: 'Settings' }} />
      <Stack.Screen name="appearance" options={{ title: 'Appearance' }} />
      <Stack.Screen name="playback" options={{ title: 'Playback' }} />
      <Stack.Screen name="sleep" options={{ title: 'Sleep timer' }} />
      <Stack.Screen name="haptics" options={{ title: 'Haptics' }} />
      <Stack.Screen name="reading" options={{ title: 'Reading' }} />
      <Stack.Screen name="connections" options={{ title: 'Connections' }} />
      <Stack.Screen name="account" options={{ title: 'Account' }} />
      <Stack.Screen name="servers" options={{ title: 'My servers' }} />
      <Stack.Screen name="player-buttons" options={{ title: 'Player buttons' }} />
    </Stack>
  )
}
