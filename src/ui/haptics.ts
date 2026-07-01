/**
 * One gate for all haptic feedback, so call sites express intent (a transport
 * tap, a selection tick, a success) and this module decides whether to fire and
 * how hard, based on the user's Haptics setting (Off / Minimal / All the things)
 * and Intensity (Light / Medium).
 *
 * expo-haptics splits into three families:
 *   - selectionAsync(): the ratchet tick for scrubbing discrete values (A-Z rail,
 *     speed notches). No intensity knob - it's always the same light tick.
 *   - impactAsync(style): a deliberate bump for a button press. Intensity maps here.
 *   - notificationAsync(type): success / warning / error stingers.
 *
 * Levels:
 *   off      - nothing fires.
 *   minimal  - eyes-off transport (play/pause, skip, chapter) + the A-Z ratchet.
 *   all      - the above plus save/mode/completion/destructive cues.
 */
import * as Haptics from 'expo-haptics'
import { getSettingsState } from '@/store/settings'

export type HapticLevel = 'off' | 'minimal' | 'all'
export type HapticIntensity = 'light' | 'medium'

function level(): HapticLevel {
  return getSettingsState().haptics
}

function impactStyle(): Haptics.ImpactFeedbackStyle {
  return getSettingsState().hapticIntensity === 'medium'
    ? Haptics.ImpactFeedbackStyle.Medium
    : Haptics.ImpactFeedbackStyle.Light
}

/** A transport-button press (play/pause, skip, chapter). Fires at minimal + all. */
function transport(): void {
  if (level() === 'off') return
  void Haptics.impactAsync(impactStyle())
}

/** A ratchet tick crossing a discrete value (A-Z rail, speed notch). Fires at
 *  minimal + all. Always the light selection tick - intensity doesn't apply. */
function select(): void {
  if (level() === 'off') return
  void Haptics.selectionAsync()
}

/** A "saved / completed" stinger (bookmark added, book finished). All only. */
function success(): void {
  if (level() !== 'all') return
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
}

/** Entering a mode or committing a setting (long-press multi-select, sleep timer
 *  set). A firmer bump than a transport tap. All only. */
function mode(): void {
  if (level() !== 'all') return
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
}

/** A destructive or cautionary confirm (delete, remove from queue). All only. */
function warn(): void {
  if (level() !== 'all') return
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
}

export const haptics = { transport, select, success, mode, warn }
