import * as Sentry from '@sentry/react-native'
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
import { CLERK_PUBLISHABLE_KEY, CLERK_JWT_TEMPLATE, SENTRY_DSN, FULL_VERSION } from '@/lib/config'
import { PlayerHost } from '@/player/PlayerHost'
import { MiniPlayerDock } from '@/player/MiniPlayerDock'
import { PopToast } from '@/social/PopToast'
import { ToastHost } from '@/ui/Toast'
import { GoalCelebrationHost } from '@/ui/GoalCelebration'
import { FinishDateHost } from '@/ui/FinishDatePrompt'
import { checkGoalCelebration } from '@/lib/goalCelebration'
import { SplashScreen as HearthSplash, ForcedSplashHost, type SplashPhase } from '@/ui/SplashScreen'
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
import { useReducedMotion } from '@/ui/motion'
import { AppBlurTargetProvider } from '@/ui/BlurTarget'
import { flushPriorCrash, mountCrashLifecycle } from '@/lib/crashReporter'
import { beginStartupTrace, startPhase, finishStartupTrace } from '@/lib/startupTrace'

// Sentry. Runs first among the module-load side effects below so anything that
// throws during startup is already covered.
//
// This does NOT replace the on-disk crash reporter (lib/crashReporter.ts +
// crashLog.ts) - the two run together on purpose. Sentry gives symbolicated
// stacks and aggregation; the disk logger catches unclean exits (a native kill
// or an OOM that never reaches a JS handler) and carries our own breadcrumb
// trail. They chain rather than fight: crashLog's global handler saves the
// previous handler and calls through to it, so both see every fatal.
//
// Empty DSN (env override set to '') disables Sentry and leaves the disk
// reporter untouched.
if (SENTRY_DSN) {
  Sentry.init({
    dsn: SENTRY_DSN,
    // Tie events to the release tag that keys OTA compatibility, so a crash
    // report names the exact build. Constants.expoConfig.version can't be used
    // here: on iOS it returns the pre-release-stripped marketing string.
    release: FULL_VERSION || undefined,
    // Session replay and profiling stay off - this is an audiobook player that
    // runs for hours in the background, and both are meaningful battery/bandwidth
    // costs. Turn on deliberately if a bug needs them.
    //
    // Tracing sample rate. 0.1 = ~1 in 10 launches sends a performance trace
    // (startup phase spans, see lib/startupTrace.ts). Enough to surface the
    // intermittent startup hang across the beta cohort without a full-volume
    // cost. Raise toward 1.0 for a focused debugging window, or 0 to disable.
    tracesSampleRate: 0.1,
  })
  // Open the startup transaction + arm the hang watchdog immediately after init,
  // so the whole launch (Clerk load, cached-session check, connect) is spanned.
  beginStartupTrace()
}

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
  // True once we've seen a confirmed signed-in session this run. After that we
  // NEVER auto-redirect to /sign-in on an isSignedIn=false reading - see below.
  const wasSignedIn = useRef(false)
  // Whether this device has a cached Clerk JWT (was signed in on a prior run).
  // null = not yet checked. A long iOS suspension can KILL the JS process while
  // native audio keeps playing; on the cold relaunch `wasSignedIn` starts false
  // and Clerk can momentarily report isLoaded=true/isSignedIn=false before the
  // cached session re-hydrates. Without this we'd redirect that returning user to
  // /sign-in mid-playback. So on a fresh mount we hold the redirect until we've
  // confirmed there is NO cached session (genuine first launch / signed out).
  const [hasCachedSession, setHasCachedSession] = useState<boolean | null>(null)

  useEffect(() => {
    const phase = startPhase('cached-session-check')
    void hasCachedClerkSession()
      .then(setHasCachedSession)
      .finally(() => phase.end())
  }, [])

  // Span the wait for Clerk to load. This is the prime suspect for the hang: if
  // isLoaded never resolves AND there's no cached JWT, `ready` stays false with
  // no timeout, and this span never ends - which the trace + watchdog surface.
  const clerkPhase = useRef<ReturnType<typeof startPhase> | null>(null)
  if (!isLoaded && !clerkPhase.current) clerkPhase.current = startPhase('clerk-load')
  useEffect(() => {
    if (isLoaded && clerkPhase.current) {
      clerkPhase.current.end()
      clerkPhase.current = null
    }
  }, [isLoaded])

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

  if (effectiveSignedIn) wasSignedIn.current = true
  // A returning user whose session is still re-hydrating: cached JWT present but
  // Clerk hasn't confirmed signed-in yet this run. Treated as "signed in" for
  // gating so their screen and connection stay mounted while Clerk settles.
  //
  // `!isLoaded` is REQUIRED: rehydration is by definition the window BEFORE Clerk
  // has answered. Once isLoaded is true and isSignedIn is false, Clerk HAS
  // answered - the user is signed out and the cached JWT is merely stale. Without
  // this clause a stale JWT made `rehydrating` permanently true, which gated a
  // signed-out user into ConnectionGate (splash, forever) while simultaneously
  // suppressing the redirect to /sign-in below. Repro: sign-in -> "continue with
  // email" -> hardware back popped /sign-in, landing on (tabs) signed-out, and
  // the app stuck on "Warming up the hearth" with no way out.
  const rehydrating = !isLoaded && hasCachedSession === true && !wasSignedIn.current
  // Sticky: once signed in this run, stay "signed in" for gating even if Clerk
  // momentarily flaps to false on a suspend/resume. Keeps ConnectionGate mounted
  // (no connect-splash flash) and, with the redirect guard below, keeps a
  // listening user on their screen.
  //
  // ...but NEVER on an auth route. `wasSignedIn` is sticky and never resets, so
  // after a real sign-out it stayed true and the gate rendered its "Warming up
  // the hearth" splash OVER the /sign-in screen the sign-out had just navigated
  // to - the user saw the fire instead of the login form, with no way forward.
  // The gate's own contract (below) is that it only wraps the signed-in state;
  // keying it on the route enforces that for every path into /sign-in, rather
  // than trusting each caller to also unwind the auth state.
  const onAuthRoute = segments[0] === 'sign-in' || segments[0] === 'sso-callback'
  const gatedSignedIn =
    !onAuthRoute && (effectiveSignedIn || wasSignedIn.current || rehydrating)

  useEffect(() => {
    if (!ready) return
    // `onAuthRoute` (declared above, and shared with the gate) also covers
    // sso-callback, which catches the OAuth redirect mid-flow (see
    // app/sso-callback.tsx) and routes itself once Clerk settles - so don't yank
    // it to /sign-in while the session is still being established.
    if (effectiveSignedIn && segments[0] === 'sign-in') {
      router.replace('/(tabs)')
      return
    }
    if (effectiveSignedIn || onAuthRoute) return

    // Not signed in and not on an auth route. Only auto-redirect on a GENUINE
    // signed-out state: we've never had a confirmed session this run AND there is
    // no cached JWT on the device. If either is true, this is Clerk failing to
    // re-hydrate - after a warm suspend/resume (isSignedIn flaps while wasSignedIn
    // stays true) or a cold relaunch of a returning user (a long iOS suspension
    // can kill the JS process while native audio keeps playing; wasSignedIn starts
    // false but the cached JWT proves they were signed in). Redirecting in either
    // case threw a listening user onto the sign-in screen mid-playback. A
    // time-based debounce was wrong: the flap can outlast any timeout. Every
    // genuine sign-out (account screen, Home, the connect gate's logout) clears
    // the cache AND navigates to /sign-in itself, so the gate never needs to
    // auto-redirect a user who has (or recently had) a session.
    //
    // hasCachedSession === null means the check hasn't resolved yet - hold the
    // redirect until it does rather than risk a wrong bounce.
    //
    // A cached JWT alone is NOT a reason to hold once Clerk has actually loaded
    // and reported signed-out: `isLoaded && !isSignedIn && !wasSignedIn` is a
    // definitive answer, and the cached token is simply stale (e.g. it was left
    // behind by an abandoned sign-in). Holding on that combination stranded a
    // signed-out user on a non-auth route with no redirect AND (via the old
    // `rehydrating`) the ConnectionGate splash over it - the "back out of email
    // sign-in sticks you on Warming up the hearth forever" bug. The flap cases
    // this guard exists for all have isLoaded false or wasSignedIn true, so they
    // are still protected.
    const definitelySignedOut = isLoaded && !isSignedIn && !wasSignedIn.current
    if (!wasSignedIn.current && (hasCachedSession === false || definitelySignedOut)) {
      // Terminal launch outcome: genuinely signed out. The loader gives way to
      // the sign-in screen - a completed launch, not a hang.
      finishStartupTrace('signed-out')
      router.replace('/sign-in')
    }
  }, [ready, effectiveSignedIn, segments, router, hasCachedSession, isLoaded, isSignedIn])

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
      {gatedSignedIn ? <ConnectionGate>{children}</ConnectionGate> : children}
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
  const { status, retry, connectTo, redeemInvite } = useConnection()
  const { signOut } = useAuth()
  const router = useRouter()
  // Lets the user step out to the servers screen while still not connected.
  const [peekingServers, setPeekingServers] = useState(false)

  // The moment the app is fully connected, check whether the user has just hit
  // their yearly reading goal and, if so, greet them with the celebration. Runs
  // once per connect (guard resets when we leave `ready`); the check self-gates
  // on the already-celebrated flag so a reconnect won't re-fire it.
  const goalChecked = useRef(false)
  useEffect(() => {
    if (status.phase === 'ready') {
      if (!goalChecked.current) {
        goalChecked.current = true
        void checkGoalCelebration()
      }
    } else {
      goalChecked.current = false
    }
  }, [status.phase])

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

  // Finish the startup trace the moment the launch reaches a terminal state.
  //
  // That's NOT only "the loader stopped covering the screen": `no-servers` and
  // `error` keep the splash up on purpose, but they are finished launches that
  // are now WAITING ON THE USER (type an invite code, tap Retry / Log out). They
  // used to leave the watchdog armed, so a user with no server invite - sitting
  // on the "Enter your invite code" screen exactly as intended - got reported as
  // a 45s "startup stall". That's a false alarm that buries real hangs.
  //
  // Idempotent, so a later reconnect flip won't reopen it.
  // Terminal phases: either the app is usable (ready / offline, splash lifted) or
  // the launch has stopped and is waiting on the user. Only `connecting` is a
  // launch still in progress.
  const settled = !covered || status.phase !== 'connecting'
  useEffect(() => {
    // The outcome IS the phase - `ready` and `offline` both lift the splash, the
    // rest are user-actionable stops.
    if (settled) finishStartupTrace(status.phase)
  }, [settled, status.phase])

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
              onSubmitInviteCode: redeemInvite,
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
  const reduced = useReducedMotion()
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.scaffold },
        // One motion grammar for every push: fade + upward settle, identical on
        // iOS and Android. Reduce Motion drops the displacement, fade only.
        animation: reduced ? 'fade' : 'fade_from_bottom',
      }}
    >
      {/* The player is a persistent destination, not a dismissible sheet, so it
          enters with the same standard lift as every other push (no sheet-style
          slide that would falsely promise swipe-to-dismiss). Dismiss gestures
          are disabled: it's the primary surface, and an accidental swipe
          shouldn't throw the listener out of it. System back remains the
          sanctioned exit. */}
      <Stack.Screen
        name="player"
        options={{ gestureEnabled: false, fullScreenGestureEnabled: false }}
      />
    </Stack>
  )
}

// Status-bar icons flip to dark glyphs on the light theme, light glyphs otherwise.
function ThemedStatusBar() {
  const { name } = useTheme()
  return <StatusBar style={name === 'light' ? 'dark' : 'light'} />
}

export default Sentry.wrap(function RootLayout() {
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
                <AppBlurTargetProvider>
                  <ThemedStack />
                  {/* Keep the floating mini player outside each screen's native
                      blur target, while sharing that target through this provider. */}
                  <MiniPlayerDock />
                </AppBlurTargetProvider>
                {/* Note-pop toasts fired by the club watcher (notePops.ts). */}
                <PopToast />
                {/* Single app-wide confirmation toast, positioned in the
                    mini-player band above all screens. */}
                <ToastHost />
                {/* Full-screen reading-goal celebration, fired on the first app
                    open after the yearly goal is reached. */}
                <GoalCelebrationHost />
              </AuthGate>
              {/* Persistent audio engine - mounted once, never unmounted. */}
              <PlayerHost />
              {/* "When did you finish this?" prompt raised by mark-finished
                  actions app-wide, so backdated completions land in the right
                  stats bucket. */}
              <FinishDateHost />
              {/* Debug: force-show the boot splash (from Diagnostics), tap to
                  dismiss. Renders nothing unless forced. */}
              <ForcedSplashHost />
            </BottomSheetModalProvider>
          </ThemeProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ClerkProvider>
  )
})

const styles = StyleSheet.create({
  gateRoot: { flex: 1 },
})
