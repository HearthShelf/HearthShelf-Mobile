import { ClerkProvider, useAuth } from '@clerk/expo'
import { Stack, useRouter, useSegments } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState, StyleSheet, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import * as SplashScreen from 'expo-splash-screen'
import { tokenCache, hasCachedClerkSession, clerkResourceCache } from '@/lib/tokenCache'
import { CLERK_PUBLISHABLE_KEY, CLERK_JWT_TEMPLATE } from '@/lib/config'
import { PlayerHost } from '@/player/PlayerHost'
import { MiniPlayerDock } from '@/player/MiniPlayerDock'
import { PopToast } from '@/social/PopToast'
import { ToastHost } from '@/ui/Toast'
import { FinishDateHost } from '@/ui/FinishDatePrompt'
import { SplashScreen as HearthSplash, type SplashPhase } from '@/ui/SplashScreen'
import { OfflineBanner } from '@/ui/OfflineBanner'
import { ConnectionProvider, useConnection } from '@/api/ConnectionProvider'
import { clearSession } from '@/api/session'
import { clearMeId } from '@/api/me'
import { clearTrack } from '@/player/store'
import { clearAutoSession } from '@/player/autoBridge'
import { stopQueueSync } from '@/player/queueSync'
import { clearSubscriptions } from '@/player/subscriptions'
import { resetPushRegistration } from '@/player/pushRegister'
import { stopClubSync } from '@/player/clubSync'
import { unregisterBackgroundFlush } from '@/player/connectivity'
import { ensureNotificationChannels } from '@/lib/notifications'
import { mountNoteForegroundHandler } from '@/social/noteEvents'
import { mountPushHandlers } from '@/player/pushHandlers'
import { ThemeProvider, useColors, useTheme } from '@/ui/ThemeProvider'
import { flushPriorCrash, mountCrashLifecycle } from '@/lib/crashReporter'

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
/** How long to wait for Clerk to load before falling back to the cached session.
 *  Offline, Clerk's isLoaded never resolves (it can't reach Clerk's servers), so
 *  without this the app hangs on the splash forever. */
const CLERK_LOAD_TIMEOUT_MS = 4000

function AuthGate({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const segments = useSegments()
  const router = useRouter()
  // Flush a prior-run crash report exactly once, the first time we have a
  // confirmed signed-in Clerk session (its token authenticates the upload).
  const crashFlushed = useRef(false)
  // Set when Clerk hasn't loaded in time AND we have a cached session, so a
  // signed-in user launching offline reaches offline mode instead of hanging.
  const [offlineFallback, setOfflineFallback] = useState(false)

  useEffect(() => {
    if (isLoaded) return
    const t = setTimeout(() => {
      void hasCachedClerkSession().then((cached) => {
        if (cached) setOfflineFallback(true)
      })
    }, CLERK_LOAD_TIMEOUT_MS)
    return () => clearTimeout(t)
  }, [isLoaded])

  // Treat a timed-out-but-cached session as signed in: Clerk can't confirm us
  // offline, but the cached client proves we were.
  const effectiveSignedIn = isSignedIn || (!isLoaded && offlineFallback)
  const ready = isLoaded || offlineFallback

  useEffect(() => {
    if (!ready) return
    const onSignIn = segments[0] === 'sign-in'
    if (!effectiveSignedIn && !onSignIn) router.replace('/sign-in')
    else if (effectiveSignedIn && onSignIn) router.replace('/(tabs)')
  }, [ready, effectiveSignedIn, segments, router])

  // Upload a prior crash once genuinely signed in (need a real token; the
  // offline-fallback path can't authenticate an upload, so gate on isSignedIn).
  useEffect(() => {
    if (crashFlushed.current || !isLoaded || !isSignedIn) return
    crashFlushed.current = true
    void flushPriorCrash(() => getToken({ template: CLERK_JWT_TEMPLATE }))
  }, [isLoaded, isSignedIn, getToken])

  if (!ready) return <HearthSplash phase={{ kind: 'connecting' }} onReady={hideOsSplash} />

  // The provider mounts in both auth states: routed screens render before the
  // sign-in redirect lands (and linger through sign-out), and they call
  // useConnection. The provider itself waits for a signed-in user to connect.
  // The splash gate only wraps the signed-in state, so the /sign-in screen
  // isn't covered by a connect overlay.
  return (
    <ConnectionProvider>
      {effectiveSignedIn ? <ConnectionGate>{children}</ConnectionGate> : children}
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
    clearSubscriptions()
    resetPushRegistration()
    void unregisterBackgroundFlush()
    clearMeId()
    await clearSession()
    await signOut()
    router.replace('/sign-in')
  }, [signOut, router])

  // Offline mode lets the user in (downloaded books only), so the splash lifts
  // just like `ready`; a persistent banner marks the degraded state instead.
  const covered = status.phase !== 'ready' && status.phase !== 'offline' && !peekingServers

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
      {status.phase === 'offline' ? <OfflineBanner onRetry={retry} /> : null}
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
  // Handle a warm tap / reply on a club-note notification while the app is
  // foreground (the cold-start + background paths are wired in index.js).
  useEffect(() => mountNoteForegroundHandler(), [])

  // Release-notification foreground presentation + tap routing (opens the
  // upcoming-book page). Self-guards when the native module is absent.
  useEffect(() => mountPushHandlers(), [])

  // Drive the crash-log clean-shutdown sentinel off app foreground/background.
  // Auth-independent, so it lives here rather than in the Clerk-scoped AuthGate.
  useEffect(() => mountCrashLifecycle(), [])

  // Fonts are embedded natively at build time via the expo-font config plugin
  // (see app.config.js), so they are available synchronously at launch - no
  // async load gate needed. The hearth splash calls SplashScreen.hideAsync
  // itself once it has painted its first frame.
  return (
    <ClerkProvider
      publishableKey={CLERK_PUBLISHABLE_KEY}
      tokenCache={tokenCache}
      __experimental_resourceCache={clerkResourceCache}
    >
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
                {/* Single app-wide confirmation toast, positioned in the
                    mini-player band above all screens. */}
                <ToastHost />
              </AuthGate>
              {/* Persistent audio engine - mounted once, never unmounted. */}
              <PlayerHost />
              {/* "When did you finish this?" prompt raised by mark-finished
                  actions app-wide, so backdated completions land in the right
                  stats bucket. */}
              <FinishDateHost />
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
