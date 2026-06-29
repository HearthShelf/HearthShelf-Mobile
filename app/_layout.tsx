import { ClerkProvider } from '@clerk/expo'
import { Stack } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { tokenCache } from '@/lib/tokenCache'
import { CLERK_PUBLISHABLE_KEY } from '@/lib/config'
import { PlayerHost } from '@/player/PlayerHost'

export default function RootLayout() {
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }} />
        {/* Persistent audio engine - mounted once, never unmounted. */}
        <PlayerHost />
      </GestureHandlerRootView>
    </ClerkProvider>
  )
}
