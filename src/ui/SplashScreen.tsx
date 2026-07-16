/**
 * Boot splash - "the hearth ignites."
 *
 * Shown full-screen while Clerk resolves the session (app/_layout.tsx). Unlike the
 * inline `Loading` spinner in primitives.tsx (used mid-app for list fetches), this
 * is the first frame a user sees, so it leans into the brand: a warm radial glow
 * breathing behind the flame logo, the logo flickering like a live flame, and a
 * field of randomly-generated embers rising and fading like sparks off coals.
 *
 * Embers are drawn in SVG with a radial-alpha fill so each reads as a soft floating
 * glow rather than a hard dot; a subset is stretched vertically into oblong streaks
 * like a spark caught mid-flight. All motion is Reanimated (worklets), no JS-thread
 * timers. The field is seeded once at mount so no two boots look alike.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AppState, Dimensions, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Device from 'expo-device'
import { LinearGradient } from 'expo-linear-gradient'
import Svg, { Circle, Defs, Ellipse, G, RadialGradient, Stop } from 'react-native-svg'
import Animated, {
  cancelAnimation,
  Easing,
  interpolate,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated'
import { useReducedMotion } from './motion'
import { FlameLogo } from './FlameLogo'
import { colors, fonts, shadow, spacing } from './theme'

const AnimatedG = Animated.createAnimatedComponent(G)
const AnimatedCircle = Animated.createAnimatedComponent(Circle)

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window')

// Device-tier the particle count: a low-RAM phone can't afford 24 individually
// animated SVG nodes at cold boot (the worst time to drop frames), so drop to a
// lean field. Above ~3GB keeps the full field. Read once at module load.
const LOW_MEM = (() => {
  const bytes = Device.totalMemory ?? 0
  return bytes > 0 && bytes < 3 * 1024 * 1024 * 1024
})()
const EMBER_COUNT = LOW_MEM ? 12 : 24

// A deterministic-per-mount pseudo-random. Seeded from the ember index so the
// field is varied but stable across re-renders within a single boot.
function seeded(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453
  return x - Math.floor(x)
}

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

type EmberSpec = {
  startX: number // launch x, px from left
  vx: number // horizontal velocity, px/s (signed - left or right)
  vy0: number // initial upward velocity, px/s
  gravity: number // downward accel, px/s^2 (embers arc and fall back)
  radius: number // hot-core radius in px (the glow halo is a multiple of this)
  stretch: number // elongation of the streak (1 = round spark, >1 = oblong)
  streaky: boolean // whether this ember draws as a velocity-aligned streak
  duration: number // s for one full life (launch -> burn out)
  delay: number // ms before first appearance
  hue: 'coral' | 'amber' | 'cream'
}

const EMBER_COLORS: Record<EmberSpec['hue'], string> = {
  coral: colors.accent,
  amber: colors.brandHearth,
  cream: colors.brandCream,
}

const EMBER_FIELD_BOTTOM = SCREEN_H * 0.9 // launch height (the coal bed) in SVG space

function makeEmbers(): EmberSpec[] {
  return Array.from({ length: EMBER_COUNT }, (_, i) => {
    const r = (salt: number) => seeded(i + 1, salt)
    const hueRoll = r(5)
    // Roughly half the embers are lively "poppers" that shoot sideways and arc;
    // the rest drift up lazily like heat-borne sparks.
    const popper = r(10) < 0.55
    const dir = r(2) < 0.5 ? -1 : 1
    const streaky = r(8) < 0.45
    return {
      startX: (0.15 + r(1) * 0.7) * SCREEN_W,
      // Poppers get real lateral speed; drifters just wander a little.
      vx: dir * (popper ? 30 + r(3) * 130 : 6 + r(3) * 30),
      // Upward launch speed sets how high it jumps before gravity wins.
      vy0: popper ? 150 + r(4) * 190 : 90 + r(4) * 90,
      gravity: 55 + r(11) * 70,
      radius: 1.1 + r(6) * 1.7,
      stretch: streaky ? 2.2 + r(9) * 2.4 : 1.15,
      streaky,
      duration: 2.6 + r(7) * 3.4,
      delay: r(12) * 4200,
      hue: hueRoll < 0.5 ? 'coral' : hueRoll < 0.85 ? 'amber' : 'cream',
    }
  })
}

function Ember({ spec, gradId }: { spec: EmberSpec; gradId: string }) {
  // t: 0 -> 1 is one full life, looped forever. Multiplied by `duration` inside
  // the worklet to get elapsed seconds for the ballistic integration.
  const t = useSharedValue(0)

  useMemo(() => {
    t.value = withDelay(
      spec.delay,
      withRepeat(
        withTiming(1, { duration: spec.duration * 1000, easing: Easing.linear }),
        -1,
        false,
      ),
    )
    // Run once on mount; t is a stable shared value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Glow halo radius; the radial-alpha fill fades it out so there's no hard edge.
  const glow = spec.radius * 3.4
  // Streak geometry: an ellipse whose long axis (local Y) is the stretch factor.
  // The G transform rotates local-Y to point along the ember's velocity, so a
  // fast sideways spark reads as a sideways streak, not a vertical one.
  const rx = glow
  const ry = glow * spec.stretch

  const animatedProps = useAnimatedProps(() => {
    const secs = t.value * spec.duration
    // Ballistic path: constant vx, vy under gravity. Origin at the coal bed.
    const x = spec.startX + spec.vx * secs
    const y = EMBER_FIELD_BOTTOM - (spec.vy0 * secs - 0.5 * spec.gravity * secs * secs)

    // Instantaneous velocity, to point the streak along the direction of travel.
    const vyNow = spec.vy0 - spec.gravity * secs // +up
    // atan2 in worklet: angle of motion from vertical, in degrees. The ellipse's
    // long axis is its local Y, so rotate so local-Y aligns with (vx, -vyNow).
    const angleRad = Math.atan2(spec.vx, vyNow) // 0 = straight up
    const rotation = (angleRad * 180) / Math.PI

    // Fade in fast, hold, burn out. Also cool (shrink) toward the end of life.
    const p = t.value
    const opacity = interpolate(p, [0, 0.1, 0.65, 1], [0, 1, 0.75, 0])
    const cool = interpolate(p, [0, 0.25, 1], [0.55, 1, 0.4])

    return {
      opacity,
      // Reanimated animates the G transform via these props.
      transform: [
        { translateX: x },
        { translateY: y },
        { rotate: `${rotation}deg` },
        { scale: cool },
      ],
    }
  })

  return (
    <AnimatedG animatedProps={animatedProps}>
      <Ellipse cx={0} cy={0} rx={rx} ry={ry} fill={`url(#${gradId})`} />
    </AnimatedG>
  )
}

// Radial-alpha gradient per hue: hot near-white core -> ember color -> transparent.
function EmberGradient({ id, color }: { id: string; color: string }) {
  return (
    <RadialGradient id={id} cx="50%" cy="50%" r="50%">
      <Stop offset="0" stopColor="#fff6e8" stopOpacity={0.95} />
      <Stop offset="0.35" stopColor={color} stopOpacity={0.9} />
      <Stop offset="1" stopColor={color} stopOpacity={0} />
    </RadialGradient>
  )
}

// The bloom behind the flame: two soft radial-gradient halos (amber outer, coral
// inner) that fade smoothly to transparent - a real color bloom, not a filled
// disc. They pulse out of phase off the shared clock to read as heat shimmer.
const GLOW_BOX = 300 // svg canvas side; the outer bloom fills it

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

  const embers = useMemo(() => (staticMode ? [] : makeEmbers()), [staticMode])

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
      progress.value = withRepeat(withTiming(0.9, { duration: 3200, easing: Easing.out(Easing.quad) }), -1, true)
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
      {/* Rising embers, behind the logo so the glow sits on top of them. */}
      <Animated.View style={[StyleSheet.absoluteFill, igniteStyle]} pointerEvents="none">
        <Svg style={StyleSheet.absoluteFill}>
          <Defs>
            <EmberGradient id="ember-coral" color={EMBER_COLORS.coral} />
            <EmberGradient id="ember-amber" color={EMBER_COLORS.amber} />
            <EmberGradient id="ember-cream" color={EMBER_COLORS.cream} />
          </Defs>
          {embers.map((spec, i) => (
            <Ember key={i} spec={spec} gradId={`ember-${spec.hue}`} />
          ))}
        </Svg>
      </Animated.View>

      <View style={styles.center}>
        <View style={styles.hearth}>
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
        </View>

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
              <Text style={styles.errorText}>
                No AudiobookShelf server is linked to your account yet.
              </Text>
              <Text style={styles.helpText}>
                Ask a server owner for an invite link, then open it on this phone to link
                up. You can also link one from Settings → My servers.
              </Text>
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

          {isError ? (
            <View style={styles.actions}>
              {actions?.onRetry ? (
                <Pressable style={[styles.btn, styles.btnPrimary]} onPress={actions.onRetry}>
                  <Text style={styles.btnPrimaryText}>Retry</Text>
                </Pressable>
              ) : null}
              {actions?.onManageServers ? (
                <Pressable style={[styles.btn, styles.btnGhost]} onPress={actions.onManageServers}>
                  <Text style={styles.btnGhostText}>Manage servers</Text>
                </Pressable>
              ) : null}
              {actions?.onLogout ? (
                <Pressable style={styles.logoutRow} onPress={actions.onLogout}>
                  <Text style={styles.logoutText}>Log out</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
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
  center: {
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
  },
  hearth: {
    width: 300,
    height: 300,
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
