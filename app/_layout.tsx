import { ClerkProvider, useAuth } from '@clerk/expo'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect } from 'react'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { tokenCache } from '@/lib/tokenCache'
import { CLERK_PUBLISHABLE_KEY } from '@/lib/config'
import { PlayerHost } from '@/player/PlayerHost'
import { Loading } from '@/ui/primitives'
import { colors } from '@/ui/theme'

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
  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <GestureHandlerRootView style={{ flex: 1 }}>
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
