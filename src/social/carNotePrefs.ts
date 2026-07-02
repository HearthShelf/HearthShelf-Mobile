/**
 * Mirror the `notePops` device setting to the native Android Auto service so the
 * car-side note detector (HearthShelfAutoService.kt) honors the same master
 * on/off the phone toast + notification path already respects (Phase 7 - see
 * docs/social.md "Privacy / settings").
 *
 * This is the JS call site only. It invokes an OPTIONAL native method
 * `setNotePopsEnabled(boolean)` on the existing HearthShelfAuto module - if the
 * native side hasn't wired that method yet, this degrades to a no-op (the car
 * service simply keeps its own default until the method lands). Kept in its own
 * file so the car-service owner can wire the native method without a merge
 * collision, and so the phone settings flow has a clean, well-named function to
 * call whenever `notePops` changes or a session connects.
 */
import { NativeModules, Platform } from 'react-native'

interface AutoNotePrefsNative {
  setNotePopsEnabled?(enabled: boolean): void
}

const native: AutoNotePrefsNative | undefined = NativeModules.HearthShelfAuto

/**
 * Push the current `notePops` value to the car service. Safe to call on any
 * platform / before the native method exists; both are no-ops.
 */
export function setCarNotePopsEnabled(enabled: boolean): void {
  if (Platform.OS !== 'android') return
  native?.setNotePopsEnabled?.(enabled)
}
