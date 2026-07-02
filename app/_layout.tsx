import { ClerkProvider, useAuth } from '@clerk/expo'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { useFonts } from 'expo-font'
import * as SplashScreen from 'expo-splash-screen'
import { tokenCache } from '@/lib/tokenCache'
import { CLERK_PUBLISHABLE_KEY } from '@/lib/config'
import { PlayerHost } from '@/player/PlayerHost'
import { MiniPlayerDock } from '@/player/MiniPlayerDock'
import { PopToast } from '@/social/PopToast'
import { SplashScreen as HearthSplash, type SplashPhase } from '@/ui/SplashScreen'
import { ConnectionProvider, useConnection } from '@/api/ConnectionProvider'
import { clearSession } from '@/api/session'
import { clearMeId } from '@/api/me'
import { clearTrack } from '@/player/store'
import { clearAutoSession } from '@/player/autoBridge'
import { stopQueueSync } from '@/player/queueSync'
import { stopClubSync } from '@/player/clubSync'
import { ensureNotificationChannels } from '@/lib/notifications'
import { mountNoteForegroundHandler } from '@/social/noteEvents'
import { fonts } from '@/ui/theme'
import { ThemeProvider, useColors, useTheme } from '@/ui/ThemeProvider'

// Hold the OS splash until the hearth splash has painted (see hideOsSplash).
void SplashScreen.preventAutoHideAsync()
// Cross-fade the OS static logo out (rather than a hard cut) so it dissolves into
// our animated hearth splash, whose first frame is the same logo on the same bg.
SplashScreen.setOptions({ duration: 220, fade: true })

// Create the club-notes notification channel once at app start (Phase 7
// foundation - see docs/social.md). No permission prompt: POST_NOTIFICATIONS
// is already requested by PlayerHost on Android 13+.
void ensureNotificationChannels()

// Dismiss the native OS splash exactly once, the moment the hearth splash reports
// its first frame is on screen. Hiding any earlier (e.g. on root layout) uncovers
// a black frame while the JS bundle is still loading.
let osSplashHidden = false
function hideOsSplash() {
  if (osSplashHidden) return
  osSplashHidden = true
  void SplashScreen.hideAsync()
}

/**
 * Auth gate. Signed-out users are pushed to /sign-in; signed-in users sitting on
 * the sign-in screen are sent into the tabs. Runs as an effect off Clerk state so
 * there is no standalone `/` route competing with the tabs index.
 *
 * While Clerk is still resolving, the hearth splash covers everything. Once signed
 * in, the ConnectionProvider + ConnectionGate keep that same splash up through the
 * server connect, so there's one continuous warm boot screen (see ConnectionGate).
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

  if (!isLoaded) return <HearthSplash phase={{ kind: 'connecting' }} onReady={hideOsSplash} />

  // The provider mounts in both auth states: routed screens render before the
  // sign-in redirect lands (and linger through sign-out), and they call
  // useConnection. The provider itself waits for a signed-in user to connect.
  // The splash gate only wraps the signed-in state, so the /sign-in screen
  // isn't covered by a connect overlay.
  return (
    <ConnectionProvider>
      {isSignedIn ? <ConnectionGate>{children}</ConnectionGate> : children}
    </ConnectionProvider>
  )
}

/**
 * Keeps the hearth splash layered over the app until the server connection is
 * ready. On failure it turns the splash into an error screen; "Manage servers"
 * dismisses the overlay so the settings route underneath is reachable, and any
 * later retry or arrival at `ready` re-syncs. The Stack always stays mounted so
 * routing (settings, sign-in) keeps working behind the overlay.
 */
function ConnectionGate({ children }: { children: React.ReactNode }) {
  const { status, retry, connectTo } = useConnection()
  const { signOut } = useAuth()
  const router = useRouter()
  // Lets the user step out to the servers screen while still not connected.
  const [peekingServers, setPeekingServers] = useState(false)

  const handleLogout = useCallback(async () => {
    clearTrack()
    clearAutoSession()
    stopQueueSync()
    stopClubSync()
    clearMeId()
    await clearSession()
    await signOut()
    router.replace('/sign-in')
  }, [signOut, router])

  const covered = status.phase !== 'ready' && !peekingServers

  const phase: SplashPhase =
    status.phase === 'connecting'
      ? { kind: 'connecting' }
      : status.phase === 'no-servers'
        ? { kind: 'no-servers' }
        : status.phase === 'error'
          ? { kind: 'error', message: status.message }
          : status.phase === 'select-server'
            ? { kind: 'select-server', servers: status.servers }
            : { kind: 'connecting' }

  return (
    <View style={styles.gateRoot}>
      {children}
      {covered ? (
        <View style={StyleSheet.absoluteFill}>
          <HearthSplash
            phase={phase}
            onReady={hideOsSplash}
            actions={{
              onRetry: () => {
                setPeekingServers(false)
                retry()
              },
              onManageServers: () => {
                setPeekingServers(true)
                router.push('/settings/servers')
              },
              onLogout: handleLogout,
              onSelectServer: (s) => connectTo(s),
            }}
          />
        </View>
      ) : null}
    </View>
  )
}

// The routed stack, under the ThemeProvider so its background tracks the theme.
function ThemedStack() {
  const colors = useColors()
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.scaffold },
      }}
    >
      {/* The player rises from the mini-player dock rather than pushing
          sideways. Deliberately NO dismiss gesture: it's the primary surface,
          and an accidental swipe shouldn't throw the listener out of it. */}
      <Stack.Screen
        name="player"
        options={{ animation: 'slide_from_bottom', gestureEnabled: false }}
      />
    </Stack>
  )
}

// Status-bar icons flip to dark glyphs on the light theme, light glyphs otherwise.
function ThemedStatusBar() {
  const { name } = useTheme()
  return <StatusBar style={name === 'light' ? 'dark' : 'light'} />
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    [fonts.sans]: require('../assets/fonts/Inter-VariableFont_opsz_wght.ttf'),
    [fonts.mono]: require('../assets/fonts/GeistMono-VariableFont_wght.ttf'),
    [fonts.brand]: require('../assets/fonts/LibreBaskerville-VariableFont_wght.ttf'),
  })

  // Handle a warm tap / reply on a club-note notification while the app is
  // foreground (the cold-start + background paths are wired in index.js).
  useEffect(() => mountNoteForegroundHandler(), [])

  // Keep the native OS splash up until fonts are ready AND the hearth splash has
  // painted its first frame (it calls SplashScreen.hideAsync itself). Hiding on
  // root layout instead left a black gap: the OS splash dismissed seconds before
  // the JS bundle finished loading and React rendered anything.
  const fontsReady = fontsLoaded || fontError

  if (!fontsReady) return null

  return (
    <ClerkProvider publishableKey={CLERK_PUBLISHABLE_KEY} tokenCache={tokenCache}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <ThemeProvider>
            <BottomSheetModalProvider>
              <ThemedStatusBar />
              <AuthGate>
                <ThemedStack />
                {/* Route-aware mini player over every screen (hides itself on
                    player surfaces and settings). Inside the gate so the boot
                    splash still covers it. */}
                <MiniPlayerDock />
                {/* Note-pop toasts fired by the club watcher (notePops.ts). */}
                <PopToast />
              </AuthGate>
              {/* Persistent audio engine - mounted once, never unmounted. */}
              <PlayerHost />
            </BottomSheetModalProvider>
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ClerkProvider>
  )
}

const styles = StyleSheet.create({
  gateRoot: { flex: 1 },
})
