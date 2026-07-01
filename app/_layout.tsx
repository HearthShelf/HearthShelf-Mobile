import { ClerkProvider, useAuth } from '@clerk/expo'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useFonts } from 'expo-font'
import * as SplashScreen from 'expo-splash-screen'
import { tokenCache } from '@/lib/tokenCache'
import { CLERK_PUBLISHABLE_KEY } from '@/lib/config'
import { PlayerHost } from '@/player/PlayerHost'
import { Loading } from '@/ui/primitives'
import { colors, fonts } from '@/ui/theme'

// Hold the splash until fonts resolve so text doesn't flash in a system face.
void SplashScreen.preventAutoHideAsync()

/**
 * Auth gate. Signed-out users are pushed to /sign-in; signed-in users sitting on
 * the sign-in screen are sent into the tabs. Runs as an effect off Clerk state so
 * there is no standalone `/` route competing with the tabs index.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth()
  const segments = useSegments()
  const router = useRouter()

  useEffect(() => {
    if (!isLoaded) return
    const onSignIn = segments[0] === 'sign-in'
    if (!isSignedIn && !onSignIn) router.replace('/sign-in')
    else if (isSignedIn && onSignIn) router.replace('/(tabs)')
  }, [isLoaded, isSignedIn, segments, router])

  if (!isLoaded) return <Loading />
  return <>{children}</>
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    [fonts.sans]: require('../assets/fonts/Inter-VariableFont_opsz_wght.ttf'),
    [fonts.mono]: require('../assets/fonts/GeistMono-VariableFont_wght.ttf'),
    [fonts.brand]: require('../assets/fonts/LibreBaskerville-VariableFont_wght.ttf'),
  })

  const onLayout = useCallback(() => {
    // Reveal the app once fonts are ready (or failed - don't block forever).
    if (fontsLoaded || fontError) void SplashScreen.hideAsync()
  }, [fontsLoaded, fontError])

  if (!fontsLoaded && !fontError) return null

  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <GestureHandlerRootView style={{ flex: 1 }} onLayout={onLayout}>
        <SafeAreaProvider>
          <BottomSheetModalProvider>
            <StatusBar style="light" />
            <AuthGate>
              <Stack
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.scaffold },
                }}
              />
            </AuthGate>
            {/* Persistent audio engine - mounted once, never unmounted. */}
            <PlayerHost />
          </BottomSheetModalProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ClerkProvider>
  )
}
