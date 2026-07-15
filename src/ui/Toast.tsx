/**
 * App-wide confirmation toast. A single host (<ToastHost>) is mounted once at
 * the root layout and positioned consistently in the mini-player band, above
 * everything else. Any screen fires one via the shared `showToast(msg)` (or the
 * back-compat `useToast().show`); placement no longer depends on which screen
 * raised it.
 *
 * A toast can carry one or more tappable actions (e.g. "Undo" / "Edit date")
 * and an optional progress spinner (bulk download toasts). Actions extend the
 * default dwell to 4s so there's time to reach them; the pill follows the user's
 * theme + accent via useColors().
 *
 * Ported from the DS's toast pattern (bookmark saved, added to list, jumped to a
 * session), now hoisted to a global store so it can't render mid-screen or
 * behind the tab bar / mini player.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { TAB_BAR_HEIGHT } from './AppTabBar'
import { MINI_PLAYER_HEIGHT } from '@/player/MiniPlayer'
import { Icon, icons } from './icons'
import { MAX_FONT_SCALE, radius, spacing, type Palette } from './theme'
import { useColors } from './ThemeProvider'

const DISMISS_MS = 1900
// With an action to reach, the pill lingers longer so it's tappable.
const ACTION_DISMISS_MS = 4000

export type ToastAction = { label: string; onPress: () => void }

export interface ToastOptions {
  /** A single tappable action (convenience for the common one-action case). */
  action?: ToastAction
  /** Multiple tappable actions, rendered in order after the message. */
  actions?: ToastAction[]
  /** Override the auto-dismiss delay (ms). Defaults to 1900, or 4000 with actions. */
  durationMs?: number
  /** Show a small spinner before the text (in-flight bulk operations). */
  progress?: boolean
}

interface ToastState {
  message: string
  actions: ToastAction[]
  progress: boolean
}

// --- global store: one toast at a time, auto-dismissing ---
let current: ToastState | null = null
let token = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Show a toast from anywhere (screens, back handlers, stores). */
export function showToast(message: string, opts?: ToastOptions): void {
  const actions = opts?.actions ?? (opts?.action ? [opts.action] : [])
  current = { message, actions, progress: opts?.progress ?? false }
  const mine = ++token
  emit()
  const dwell = opts?.durationMs ?? (actions.length ? ACTION_DISMISS_MS : DISMISS_MS)
  setTimeout(() => {
    // Only clear if no newer toast replaced this one.
    if (token === mine) {
      current = null
      emit()
    }
  }, dwell)
}

/** Dismiss the current toast immediately (e.g. after an action fires). */
function dismissToast(): void {
  token++
  current = null
  emit()
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function getState(): ToastState | null {
  return current
}

/**
 * Back-compat shim for the old per-screen API. Screens still call
 * `const { message, show } = useToast()` and pass `message` to <Toast>, but both
 * now route through the global store, so the actual rendering is the single
 * root-level <ToastHost>. The returned `message` is intentionally always null so
 * a stray local <Toast message={...}> renders nothing (the host owns display).
 */
export function useToast() {
  const show = useCallback((msg: string) => showToast(msg), [])
  return { message: null as string | null, show }
}

/** Legacy per-screen render site - now a no-op; the root <ToastHost> renders. */
export function Toast(_: { message: string | null; bottom?: number }) {
  return null
}

/** Mounted once at the root layout, above the mini player + tab bar. */
export function ToastHost() {
  const state = useSyncExternalStore(subscribe, getState)
  const insets = useSafeAreaInsets()
  const colors = useColors()
  const styles = makeStyles(colors)
  if (!state) return null
  // Center the pill vertically in the mini-player band (the mini player floats
  // just above the tab bar), so it reads as "over the mini player" regardless of
  // which screen raised it.
  const bandCenter = insets.bottom + TAB_BAR_HEIGHT + MINI_PLAYER_HEIGHT / 2
  // The wrap is transparent to touches so the screen behind stays interactive;
  // the pill itself opts back in ("auto") so its action buttons are tappable.
  return (
    <View style={[styles.wrap, { bottom: bandCenter - PILL_HALF_HEIGHT }]} pointerEvents="box-none">
      <View style={styles.pill} pointerEvents="auto">
        {state.progress ? (
          <ActivityIndicator size="small" color={colors.accent} />
        ) : (
          <Icon name={icons.checkCircle} size={18} color={colors.accent} />
        )}
        <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.text}>
          {state.message}
        </Text>
        {state.actions.map((a, i) => (
          <Pressable
            key={`${a.label}-${i}`}
            hitSlop={8}
            onPress={() => {
              a.onPress()
              dismissToast()
            }}
            style={({ pressed }) => [styles.action, pressed && styles.actionPressed]}
          >
            <Text maxFontSizeMultiplier={MAX_FONT_SCALE} style={styles.actionText}>
              {a.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

// Approx half the pill height (padding + text), for centering it in the band.
const PILL_HALF_HEIGHT = 20

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    wrap: {
      position: 'absolute',
      left: 0,
      right: 0,
      alignItems: 'center',
      // Above the mini player (which sits below the boot splash) and tab bar.
      zIndex: 60,
    },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingLeft: spacing.lg,
      paddingRight: spacing.sm,
      paddingVertical: spacing.sm + 3,
      borderRadius: radius.pill,
      backgroundColor: colors.elevated,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    text: { color: colors.text, fontSize: 13, fontWeight: '600' },
    action: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
    },
    actionPressed: { opacity: 0.6 },
    actionText: { color: colors.accent, fontSize: 13, fontWeight: '700' },
  })
