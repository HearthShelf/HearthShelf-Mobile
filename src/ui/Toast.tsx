/**
 * App-wide confirmation toast. A single host (<ToastHost>) is mounted once at
 * the root layout and positioned consistently in the mini-player band, above
 * everything else. Any screen fires one via the shared `showToast(msg)` (or the
 * back-compat `useToast().show`); placement no longer depends on which screen
 * raised it.
 *
 * Ported from the DS's toast pattern (bookmark saved, added to list, jumped to a
 * session), now hoisted to a global store so it can't render mid-screen or
 * behind the tab bar / mini player.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { TAB_BAR_HEIGHT } from './AppTabBar'
import { MINI_PLAYER_HEIGHT } from '@/player/MiniPlayer'
import { Icon, icons } from './icons'
import { colors, radius, spacing } from './theme'

const DISMISS_MS = 1900

// --- global store: one message at a time, auto-dismissing ---
let current: string | null = null
let token = 0
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())

/** Show a toast from anywhere (screens, back handlers, stores). */
export function showToast(message: string): void {
  current = message
  const mine = ++token
  emit()
  setTimeout(() => {
    // Only clear if no newer toast replaced this one.
    if (token === mine) {
      current = null
      emit()
    }
  }, DISMISS_MS)
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function getMessage(): string | null {
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
  const message = useSyncExternalStore(subscribe, getMessage)
  const insets = useSafeAreaInsets()
  if (!message) return null
  // Center the pill vertically in the mini-player band (the mini player floats
  // just above the tab bar), so it reads as "over the mini player" regardless of
  // which screen raised it.
  const bandCenter = insets.bottom + TAB_BAR_HEIGHT + MINI_PLAYER_HEIGHT / 2
  return (
    <View style={[styles.wrap, { bottom: bandCenter - PILL_HALF_HEIGHT }]} pointerEvents="none">
      <View style={styles.pill}>
        <Icon name={icons.checkCircle} size={18} color={colors.accent} />
        <Text style={styles.text}>{message}</Text>
      </View>
    </View>
  )
}

// Approx half the pill height (padding + text), for centering it in the band.
const PILL_HALF_HEIGHT = 20

const styles = StyleSheet.create({
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
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 3,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(20,17,15,0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  text: { color: colors.text, fontSize: 13, fontWeight: '600' },
})
