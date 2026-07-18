/**
 * Boot splash - "the hearth ignites."
 *
 * Shown full-screen while Clerk resolves the session (app/_layout.tsx). Unlike the
 * inline `Loading` spinner in primitives.tsx (used mid-app for list fetches), this
 * is the first frame a user sees, so it leans into the brand: a warm radial glow
 * breathing behind the flame logo, the logo flickering like a live flame, and a
 * procedural Skia hearth burning across the bottom edge.
 *
 * A single GPU shader draws the connected flame body, its pooled light, and sparse
 * sparks. Reanimated still owns the logo/glow timing and the static reduced-motion
 * path, so startup never depends on JS-thread timers or fire motion alone.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { getSplashDebug, subscribeSplashDebug, dismissForcedSplash } from '@/lib/splashDebug'
import * as Device from 'expo-device'
import { LinearGradient } from 'expo-linear-gradient'
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg'
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated'
import { useReducedMotion } from './motion'
import { FlameLogo } from './FlameLogo'
import { HearthFire } from './HearthFire'
import { colors, fonts, shadow, spacing } from './theme'

const AnimatedCircle = Animated.createAnimatedComponent(Circle)

// Low-RAM devices keep the static hearth. Cold boot is the worst time to ask a
// constrained GPU to compile and run a procedural shader, and the static path
// is already the correct reduced-motion fallback. Read once at module load.
const LOW_MEM = (() => {
  const bytes = Device.totalMemory ?? 0
  return bytes > 0 && bytes < 3 * 1024 * 1024 * 1024
})()

// Art-direction control for the procedural fire. 0 removes flying embers while
// 1 creates a busy shower; it does not change the flame body itself.
const SPLASH_SPARK_INTENSITY = 0.9

// The hearth's layout box, and how far it shrinks when the keyboard is up. 0.44
// lands the art at the logo's own 132px, which is small enough to clear the
// keyboard on a short screen while still reading as the flame.
const HEARTH_BOX = 300
const HEARTH_COMPACT_SCALE = 0.44

// --- Anti-banding base ramp -------------------------------------------------
// Three anchor colors (deep coal -> warm charcoal -> ember-warm), expanded into
// many finely-spaced stops. A gradient with just the three anchors shows visible
// steps on dark surfaces; interpolating extra stops makes the transition read as
// continuous. Computed once at module load.
const RAMP_ANCHORS: Array<[number, [number, number, number]]> = [
  [0, [0x14, 0x12, 0x10]],
  [0.55, [0x1b, 0x1a, 0x18]],
  [1, [0x24, 0x1d, 0x18]],
]

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t)
}

function buildRamp(steps: number): { colors: string[]; locations: number[] } {
  const colorsOut: string[] = []
  const locationsOut: number[] = []
  for (let s = 0; s <= steps; s++) {
    const loc = s / steps
    // Find the anchor segment this location falls in.
    let seg = 0
    while (seg < RAMP_ANCHORS.length - 2 && loc > RAMP_ANCHORS[seg + 1][0]) seg++
    const [l0, c0] = RAMP_ANCHORS[seg]
    const [l1, c1] = RAMP_ANCHORS[seg + 1]
    const t = l1 === l0 ? 0 : (loc - l0) / (l1 - l0)
    const r = lerp(c0[0], c1[0], t)
    const g = lerp(c0[1], c1[1], t)
    const b = lerp(c0[2], c1[2], t)
    colorsOut.push(`rgb(${r},${g},${b})`)
    locationsOut.push(loc)
  }
  return { colors: colorsOut, locations: locationsOut }
}

const _ramp = buildRamp(24)
// expo-linear-gradient types want a non-empty tuple; the ramp always has >=2.
const BASE_RAMP = _ramp.colors as [string, string, ...string[]]
const BASE_LOCATIONS = _ramp.locations as [number, number, ...number[]]

// The bloom behind the flame: two soft radial-gradient halos (amber outer, coral
// inner) that fade smoothly to transparent - a real color bloom, not a filled
// disc. They pulse out of phase off the shared clock to read as heat shimmer.
const GLOW_BOX = HEARTH_BOX // svg canvas side; the outer bloom fills the hearth box

function HearthGlow({ pulse }: { pulse: SharedValue<number> }) {
  const outer = useAnimatedProps(() => ({
    opacity: interpolate(pulse.value, [0, 1], [0.4, 0.75]),
  }))
  const inner = useAnimatedProps(() => ({
    opacity: interpolate(pulse.value, [0, 1], [0.85, 0.5]),
  }))
  const c = GLOW_BOX / 2
  return (
    <Svg width={GLOW_BOX} height={GLOW_BOX} pointerEvents="none" style={{ position: 'absolute' }}>
      <Defs>
        {/* Amber outer wash - wide and soft. */}
        <RadialGradient id="glow-amber" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={colors.brandHearth} stopOpacity={0.55} />
          <Stop offset="0.4" stopColor={colors.brandHearth} stopOpacity={0.28} />
          <Stop offset="1" stopColor={colors.brandHearth} stopOpacity={0} />
        </RadialGradient>
        {/* Coral inner core - hotter, tighter. */}
        <RadialGradient id="glow-coral" cx="50%" cy="50%" r="50%">
          <Stop offset="0" stopColor={colors.accent} stopOpacity={0.7} />
          <Stop offset="0.45" stopColor={colors.accent} stopOpacity={0.32} />
          <Stop offset="1" stopColor={colors.accent} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <AnimatedCircle animatedProps={outer} cx={c} cy={c} r={c} fill="url(#glow-amber)" />
      <AnimatedCircle animatedProps={inner} cx={c} cy={c} r={c * 0.62} fill="url(#glow-coral)" />
    </Svg>
  )
}

/**
 * What the splash is currently doing. The same warm hearth stays on screen the
 * whole time; only the copy + the action row below the wordmark change.
 *   igniting        - first frame after the OS splash hands off (logo only)
 *   connecting      - auth resolving / connecting to the server / loading data
 *   select-server   - more than one linked server; user picks one
 *   no-servers      - account has no linked server yet
 *   error           - connect/data failed; offer retry + escapes
 */
export type SplashServer = { id: string; name: string; url: string }

export type SplashPhase =
  | { kind: 'igniting' }
  | { kind: 'connecting'; label?: string; serverName?: string }
  | { kind: 'select-server'; servers: SplashServer[] }
  | { kind: 'no-servers' }
  | { kind: 'error'; message: string }

export interface SplashActions {
  onRetry?: () => void
  onManageServers?: () => void
  onLogout?: () => void
  onSelectServer?: (server: SplashServer) => void
  /** Redeem a typed invite code. Resolves to an error message, or null on success
   *  (on success the connect flow takes over and this screen goes away). */
  onSubmitInviteCode?: (code: string) => Promise<string | null>
}

export function SplashScreen({
  phase = { kind: 'connecting' },
  actions,
  onReady,
}: {
  phase?: SplashPhase
  actions?: SplashActions
  /** Fired once the splash has laid out its first frame - the cue to dismiss the
   *  native OS splash so it cross-fades onto an already-painted hearth. */
  onReady?: () => void
}) {
  // Reduce Motion (OS setting) OR a low-RAM device gets the STATIC hearth: one
  // painted glow, no ember field, no looping flicker - progress is carried by a
  // determinate bar + text, never by fire motion alone (D-A11Y).
  const reduced = useReducedMotion()
  const staticMode = reduced || LOW_MEM

  // One shared clock drives both glows (they read it at different phases) and
  // the logo flicker, so everything breathes off the same fire.
  const pulse = useSharedValue(0)
  const flicker = useSharedValue(0)
  // ignite: 0 -> 1 is the "come alive" moment. The logo is fully visible from
  // frame 0 (so the OS static splash hands off with no jump); the embers, glow,
  // and wordmark fade UP over ~0.2s as the hearth catches.
  const ignite = useSharedValue(0)

  useEffect(() => {
    if (staticMode) {
      // Static hearth: hold the glow at a warm mid-value, no loops, and skip the
      // ignition animation (everything is just on).
      pulse.value = 0.6
      flicker.value = 1
      ignite.value = 1
      return
    }
    pulse.value = withRepeat(
      withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
      -1,
      true,
    )
    // Irregular flicker: quick dips at uneven intervals, never fully steady.
    flicker.value = withRepeat(
      withSequence(
        withTiming(1, { duration: 90, easing: Easing.out(Easing.quad) }),
        withTiming(0.72, { duration: 140 }),
        withTiming(0.94, { duration: 70 }),
        withTiming(0.82, { duration: 220 }),
        withTiming(1, { duration: 110 }),
      ),
      -1,
      false,
    )
    // The 0.2s ignition. Short and deliberate - the fire "comes alive".
    ignite.value = withTiming(1, { duration: 200, easing: Easing.out(Easing.cubic) })
    // Don't burn battery/GPU while backgrounded: pause the loops on background.
    const sub = AppState.addEventListener('change', (st) => {
      if (st !== 'active') {
        cancelAnimation(pulse)
        cancelAnimation(flicker)
      } else {
        pulse.value = withRepeat(
          withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }),
          -1,
          true,
        )
        flicker.value = withRepeat(
          withSequence(
            withTiming(1, { duration: 90 }),
            withTiming(0.72, { duration: 140 }),
            withTiming(0.94, { duration: 70 }),
            withTiming(0.82, { duration: 220 }),
            withTiming(1, { duration: 110 }),
          ),
          -1,
          false,
        )
      }
    })
    return () => sub.remove()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staticMode])

  // The logo holds steady for the handoff, then picks up the live flicker once lit.
  const logoStyle = useAnimatedStyle(() => ({
    opacity:
      interpolate(flicker.value, [0.72, 1], [0.85, 1]) *
      interpolate(ignite.value, [0, 1], [0.9, 1]),
    transform: [{ scale: interpolate(flicker.value, [0.72, 1], [0.99, 1.008]) }],
  }))

  // Embers + glow ignite in over the 0.2s.
  const igniteStyle = useAnimatedStyle(() => ({ opacity: ignite.value }))

  const wordmarkStyle = useAnimatedStyle(() => ({
    opacity: ignite.value,
    transform: [{ translateY: interpolate(ignite.value, [0, 1], [8, 0]) }],
  }))

  // Keyboard up (invite entry) shrinks the hearth instead of scrolling it away:
  // the flame is the thing that makes this screen feel like ours, so it stays on
  // screen while the field is focused. 0 = full size, 1 = compact.
  const compact = useSharedValue(0)
  useEffect(() => {
    const show = Keyboard.addListener('keyboardDidShow', () => {
      compact.value = withTiming(1, { duration: 220, easing: Easing.out(Easing.quad) })
    })
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      compact.value = withTiming(0, { duration: 220, easing: Easing.out(Easing.quad) })
    })
    return () => {
      show.remove()
      hide.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Scale rather than re-layout: the glow SVG and logo are fixed-size children,
  // so scaling the box keeps them in proportion and stays on the UI thread.
  // Height collapses alongside it so the freed space actually reaches the form
  // (a bare scale would shrink the art but leave its 300px footprint behind).
  //
  // Keep these two in step: HEARTH_BOX * HEARTH_COMPACT_SCALE == the compact
  // height, so the scaled art exactly fills its footprint. Change one without
  // the other and the flame drifts off-center inside its own box.
  const hearthStyle = useAnimatedStyle(() => ({
    height: interpolate(compact.value, [0, 1], [HEARTH_BOX, HEARTH_BOX * HEARTH_COMPACT_SCALE]),
    transform: [{ scale: interpolate(compact.value, [0, 1], [1, HEARTH_COMPACT_SCALE]) }],
  }))

  const isError = phase.kind === 'error' || phase.kind === 'no-servers'
  const readyFired = useRef(false)
  const [showDetails, setShowDetails] = useState(false)

  // A determinate progress bar for the static/reduce-motion path, so progress is
  // never conveyed by fire motion alone. A slow indeterminate creep - we don't
  // know real percent, but a moving bar reads as "working, not frozen".
  const progress = useSharedValue(0)
  useEffect(() => {
    if (!staticMode) return
    if (phase.kind === 'connecting') {
      progress.value = 0.08
      progress.value = withRepeat(
        withTiming(0.9, { duration: 3200, easing: Easing.out(Easing.quad) }),
        -1,
        true,
      )
    } else {
      cancelAnimation(progress)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staticMode, phase.kind])
  const progressStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }))

  return (
    <View
      style={styles.root}
      onLayout={() => {
        if (readyFired.current) return
        readyFired.current = true
        onReady?.()
      }}
    >
      {/* Base warmth: deep coal at the top down to a warm charcoal core. Many
          finely-spaced stops keep the ramp perceptually smooth - a 3-stop ramp
          bands visibly on a dark palette (esp. Android's 8-bit surfaces). */}
      <LinearGradient
        colors={BASE_RAMP}
        locations={BASE_LOCATIONS}
        style={StyleSheet.absoluteFill}
      />
      {/* A pooled amber glow at the very bottom - the bed of coals the embers rise
          from. Extra stops here too so the coal wash doesn't step. */}
      <LinearGradient
        colors={[
          'transparent',
          'rgba(189,134,63,0.05)',
          'rgba(189,134,63,0.12)',
          'rgba(207,116,66,0.17)',
          'rgba(224,101,74,0.22)',
        ]}
        locations={[0.5, 0.68, 0.82, 0.92, 1]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      {/* One procedural fire source replaces the detached SVG particle field.
          Reduced-motion and low-memory devices keep the static coal wash. */}
      {!staticMode ? (
        <Animated.View style={[StyleSheet.absoluteFill, igniteStyle]} pointerEvents="none">
          <HearthFire sparkIntensity={SPLASH_SPARK_INTENSITY} />
        </Animated.View>
      ) : null}

      {/* The foreground scrolls inside a keyboard-avoiding frame so the invite
          field stays visible once the keyboard is up. The gradients and fire
          are absolute-fill siblings, so they're untouched by this. */}
      {/* No behavior on Android: the activity is windowSoftInputMode=adjustResize,
          so the window is already resized for us - adding 'height' on top of that
          compensates twice and over-shrinks the frame. */}
      <KeyboardAvoidingView
        style={styles.keyboardFrame}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          <View style={styles.center}>
            <Animated.View style={[styles.hearth, hearthStyle]}>
              {/* Radial-gradient bloom, breathing behind the flame. Ignites in with
              the embers so the handoff frame is just the logo. */}
              <Animated.View
                style={[StyleSheet.absoluteFill, styles.glowWrap, igniteStyle]}
                pointerEvents="none"
              >
                <HearthGlow pulse={pulse} />
              </Animated.View>
              <Animated.View style={logoStyle}>
                <FlameLogo size={132} />
              </Animated.View>
            </Animated.View>

            <Animated.Text style={[styles.wordmark, wordmarkStyle]}>HearthShelf</Animated.Text>

            {/* Status + actions. Only this region changes as the phase advances. */}
            <View style={styles.statusArea}>
              {phase.kind === 'connecting' ? (
                <>
                  <Text style={styles.label}>
                    {phase.serverName
                      ? `Connecting to ${phase.serverName}…`
                      : (phase.label ?? 'Warming up your library...')}
                  </Text>
                  {/* Static/reduce-motion path: a determinate bar so progress isn't
                  carried by the fire alone. */}
                  {staticMode ? (
                    <View style={styles.progressTrack}>
                      <Animated.View style={[styles.progressFill, progressStyle]} />
                    </View>
                  ) : null}
                </>
              ) : null}

              {phase.kind === 'no-servers' ? (
                <>
                  <Text style={styles.errorText}>Enter your invite code</Text>
                  <Text style={styles.helpText}>
                    Whoever shared their library with you can give you a code.
                  </Text>
                  <InviteCodeEntry onSubmit={actions?.onSubmitInviteCode} />
                </>
              ) : null}

              {phase.kind === 'error' ? (
                <>
                  <Text style={styles.errorText}>{friendlyError(phase.message)}</Text>
                  {/* Keep the raw string off the first-impression screen, but let the
                  curious (or a bug report) reveal it. */}
                  <Pressable onPress={() => setShowDetails((v) => !v)} hitSlop={8}>
                    <Text style={styles.detailsToggle}>
                      {showDetails ? 'Hide details' : 'Show details'}
                    </Text>
                  </Pressable>
                  {showDetails ? <Text style={styles.detailsText}>{phase.message}</Text> : null}
                </>
              ) : null}

              {phase.kind === 'select-server' ? (
                <View style={styles.serverList}>
                  <Text style={styles.label}>Choose a server</Text>
                  {phase.servers.map((s) => (
                    <Pressable
                      key={s.id}
                      style={styles.serverRow}
                      onPress={() => actions?.onSelectServer?.(s)}
                    >
                      <Text style={styles.serverName} numberOfLines={1}>
                        {s.name}
                      </Text>
                      <Text style={styles.serverUrl} numberOfLines={1}>
                        {s.url}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ) : null}

              {phase.kind === 'error' ? (
                <View style={styles.actions}>
                  {actions?.onRetry ? (
                    <Pressable style={[styles.btn, styles.btnPrimary]} onPress={actions.onRetry}>
                      <Text style={styles.btnPrimaryText}>Retry</Text>
                    </Pressable>
                  ) : null}
                  {actions?.onManageServers ? (
                    <Pressable
                      style={[styles.btn, styles.btnGhost]}
                      onPress={actions.onManageServers}
                    >
                      <Text style={styles.btnGhostText}>My libraries</Text>
                    </Pressable>
                  ) : null}
                  {actions?.onLogout ? (
                    <Pressable style={styles.logoutRow} onPress={actions.onLogout}>
                      <Text style={styles.logoutText}>Log out</Text>
                    </Pressable>
                  ) : null}
                </View>
              ) : null}

              {/* no-servers has no Retry: retrying finds the same nothing. The code
              entry above IS the action, so the only escape offered is Log out. */}
              {phase.kind === 'no-servers' && actions?.onLogout ? (
                <View style={styles.actions}>
                  <Pressable style={styles.logoutRow} onPress={actions.onLogout}>
                    <Text style={styles.logoutText}>Log out</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}

/**
 * Debug overlay: when Diagnostics force-shows the splash, this renders it full-
 * screen on top of everything so it can be watched running. A tap anywhere
 * dismisses it. Mounted once at the root layout; renders nothing normally.
 */
export function ForcedSplashHost() {
  const forced = useSyncExternalStore(subscribeSplashDebug, getSplashDebug)
  if (!forced) return null
  return (
    <Pressable
      style={StyleSheet.absoluteFill}
      onPress={dismissForcedSplash}
      accessibilityRole="button"
      accessibilityLabel="Dismiss the boot splash preview"
    >
      <SplashScreen phase={{ kind: 'connecting', label: 'Boot splash preview - tap to dismiss' }} />
    </Pressable>
  )
}

/**
 * Invite-code entry for the "you have no library yet" screen.
 *
 * Formats as the user types (XXXX-XXXX) so the field always looks like the code
 * printed in the email, and normalizes on submit so a pasted lowercase or
 * space-separated code still works. Auto-submits on the 8th character - the code
 * has a fixed length, so making someone hunt for a button after they've clearly
 * finished is pure friction.
 */
function InviteCodeEntry({ onSubmit }: { onSubmit?: (code: string) => Promise<string | null> }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const bare = value.replace(/[^A-Za-z0-9]/g, '')
  const complete = bare.length === 8

  async function submit(code: string) {
    if (!onSubmit || busy) return
    setBusy(true)
    setError(null)
    const message = await onSubmit(code)
    setBusy(false)
    // On success this screen unmounts; only a failure needs handling here.
    if (message) {
      setError(message)
      setValue('')
    }
  }

  function onChange(next: string) {
    const cleaned = next
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase()
      .slice(0, 8)
    setValue(cleaned.length > 4 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned)
    if (error) setError(null)
    if (cleaned.length === 8) void submit(cleaned)
  }

  return (
    <View style={styles.codeWrap}>
      <TextInput
        value={value}
        onChangeText={onChange}
        onSubmitEditing={() => complete && void submit(bare)}
        editable={!busy}
        placeholder="ABCD-1234"
        placeholderTextColor={colors.textFaint}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        returnKeyType="go"
        maxLength={9}
        accessibilityLabel="Invite code"
        style={styles.codeInput}
      />
      {busy ? (
        <ActivityIndicator color={colors.accent} style={styles.codeBusy} />
      ) : (
        <Pressable
          style={[styles.btn, styles.btnPrimary, !complete && styles.btnDisabled]}
          disabled={!complete}
          onPress={() => void submit(bare)}
        >
          <Text style={styles.btnPrimaryText}>Join library</Text>
        </Pressable>
      )}
      {error ? <Text style={styles.codeError}>{error}</Text> : null}
    </View>
  )
}

// The connect layer throws opaque strings like "connect_failed: no_token". Keep
// the raw text out of the first-impression screen and show something human.
function friendlyError(message: string): string {
  if (/no_token|connect_failed/i.test(message)) return "We couldn't reach your server."
  if (/network|fetch|timeout/i.test(message)) return 'Network trouble reaching your server.'
  return message
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.scaffold,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  keyboardFrame: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // grow-not-fill: centers the content when it's shorter than the screen, and
  // lets it scroll once the keyboard squeezes the frame instead of clipping it.
  scroll: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  center: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
  },
  hearth: {
    width: HEARTH_BOX,
    height: HEARTH_BOX,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glowWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  wordmark: {
    marginTop: spacing.lg,
    color: colors.brandShelf,
    fontFamily: fonts.brand,
    fontSize: 30,
    letterSpacing: 0.5,
  },
  statusArea: {
    marginTop: spacing.md,
    minHeight: 96,
    alignItems: 'center',
    width: '100%',
  },
  label: {
    color: colors.textMuted,
    fontFamily: fonts.sans,
    fontSize: 13,
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  errorText: {
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 15,
    lineHeight: 22,
    textAlign: 'center',
    maxWidth: 300,
  },
  helpText: {
    color: colors.textMuted,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    maxWidth: 300,
    marginTop: spacing.sm,
  },
  detailsToggle: {
    color: colors.textMuted,
    fontFamily: fonts.sans,
    fontSize: 12,
    marginTop: spacing.sm,
    textDecorationLine: 'underline',
  },
  detailsText: {
    color: colors.textFaint,
    fontFamily: fonts.mono,
    fontSize: 11,
    lineHeight: 16,
    textAlign: 'center',
    maxWidth: 300,
    marginTop: spacing.xs,
  },
  progressTrack: {
    width: 200,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.fillStrong,
    overflow: 'hidden',
    marginTop: spacing.md,
  },
  progressFill: { height: '100%', backgroundColor: colors.accent, borderRadius: 2 },
  actions: {
    marginTop: spacing.lg,
    alignItems: 'center',
    gap: spacing.sm,
    width: '100%',
  },
  btn: {
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 24,
    alignItems: 'center',
    minWidth: 220,
  },
  btnPrimary: {
    backgroundColor: colors.accent,
    ...shadow.accentGlow,
  },
  btnPrimaryText: {
    color: colors.onAccent,
    fontFamily: fonts.sans,
    fontSize: 15,
    fontWeight: '600',
  },
  btnGhost: {
    backgroundColor: colors.fill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  btnGhostText: {
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 15,
    fontWeight: '600',
  },
  btnDisabled: {
    opacity: 0.4,
  },
  codeWrap: {
    marginTop: spacing.lg,
    alignItems: 'center',
    gap: spacing.md,
    width: '100%',
  },
  codeInput: {
    minWidth: 220,
    borderRadius: 12,
    paddingVertical: 14,
    paddingHorizontal: 20,
    backgroundColor: colors.fill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    color: colors.text,
    fontFamily: fonts.mono,
    fontSize: 22,
    letterSpacing: 4,
    textAlign: 'center',
  },
  codeBusy: {
    height: 48,
  },
  codeError: {
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    maxWidth: 300,
  },
  logoutRow: {
    marginTop: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  logoutText: {
    color: colors.textMuted,
    fontFamily: fonts.sans,
    fontSize: 14,
  },
  serverList: {
    width: '100%',
    maxWidth: 320,
    gap: spacing.sm,
    alignItems: 'stretch',
  },
  serverRow: {
    backgroundColor: colors.fill,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  serverName: {
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 15,
    fontWeight: '600',
  },
  serverUrl: {
    color: colors.textMuted,
    fontFamily: fonts.sans,
    fontSize: 12,
    marginTop: 2,
  },
})
