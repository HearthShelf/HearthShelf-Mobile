/**
 * Shake-to-extend the sleep timer. When the user enables it and a duration/clock
 * sleep timer is winding down, a shake of the phone adds a few minutes so they
 * don't have to open the player and fiddle with a slider half-asleep.
 *
 * Two implementations, because where the shake is detected decides whether it
 * works when it matters most - phone locked, screen off, app backgrounded:
 *
 *  - Android: detection lives in the native phone media service
 *    (HearthShelfPlayerService), the always-alive foreground service that owns
 *    playback. A JS accelerometer listener is Activity-bound and stops delivering
 *    when the app isn't foregrounded, so a locked-phone shake did nothing. The
 *    native SensorManager keeps delivering because active audio holds the CPU
 *    awake. JS just pushes the gate (setting on + minutes + whether a
 *    duration/clock timer is live) to native and listens for onShakeExtend, then
 *    adds the minutes to the store (store stays the source of truth).
 *
 *  - iOS / other: the phone media service is Android-only, so keep the foreground
 *    DeviceMotion listener. The accelerometer is subscribed only while it can act
 *    (setting on, a duration/clock timer running, playback playing) so it doesn't
 *    listen 24/7. DeviceMotion.acceleration is gravity-removed (m/s^2), so a still
 *    phone reads ~0 and a deliberate shake spikes past the threshold.
 */
import { useEffect, useRef } from 'react'
import { NativeEventEmitter, NativeModules, Platform } from 'react-native'
import { DeviceMotion, type DeviceMotionMeasurement } from 'expo-sensors'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { haptics } from '@/ui/haptics'
import { setAutoSleepShake } from './autoBridge'
import { addSleepMinutes, getState, subscribe } from './store'

/** Shake magnitude (m/s^2) that counts as an intentional shake. */
const SHAKE_THRESHOLD = 18
/** How often DeviceMotion reports (ms). */
const UPDATE_INTERVAL_MS = 100
/** Minimum gap between two accepted shakes (ms), so one shake adds time once. */
const COOLDOWN_MS = 3000

/** Whether a shake should currently add time (JS-side truth for both paths). */
function shouldListen(): boolean {
  const s = getSettingsState()
  if (!s.sleepShakeExtend) return false
  const player = getState()
  if (!player.isPlaying) return false
  if (player.carActive) return false
  const timer = player.sleepTimer
  return timer?.kind === 'duration' || timer?.kind === 'clock'
}

/** True when a duration/clock sleep timer is live, regardless of play state. The
 *  native gate ANDs this with its own live isPlaying check. */
function timerLive(): boolean {
  const timer = getState().sleepTimer
  return timer?.kind === 'duration' || timer?.kind === 'clock'
}

/** Why shake-to-extend stopped honoring a shake at the cutoff (the user's "On
 *  excessive shaking" choice decides which - see addSleepMinutes in
 *  player/store.ts). 'paused' = timer kept running; 'disabled' = timer ended. */
export type ShakeCutoff = 'paused' | 'disabled'

/** Ref bundle handed to both platform mounts: `onExtend` fires per accepted
 *  shake, `onCutoff` fires once when the consecutive-shake cutoff kicks in
 *  (see MAX_CONSECUTIVE_SHAKE_EXTENDS in player/store.ts). */
interface ShakeCallbacks {
  onExtend: (mins: number) => void
  onCutoff: (reason: ShakeCutoff) => void
}

/**
 * Mount the shake-to-extend listener. Call once from a persistent host
 * component (PlayerHost). `onExtend` fires with the minutes added so the host
 * can show a confirmation toast in component context; `onCutoff` fires once when
 * shakes stop being honored (too many in a row - likely walking, not waking up),
 * with why (timer paused vs ended) so the host can explain what happened.
 */
export function useShakeToExtend(
  onExtend: (mins: number) => void,
  onCutoff: (reason: ShakeCutoff) => void,
): void {
  const callbacksRef = useRef<ShakeCallbacks>({ onExtend, onCutoff })
  callbacksRef.current = { onExtend, onCutoff }

  useEffect(() => {
    if (Platform.OS === 'android') return mountNative(callbacksRef)
    return mountDeviceMotion(callbacksRef)
  }, [])
}

/**
 * Android: push the gate to the native service and let it detect shakes. The
 * native side adds nothing to the store itself - it emits onShakeExtend and JS
 * applies the minutes here, so the store stays the single source of truth.
 */
function mountNative(callbacksRef: React.MutableRefObject<ShakeCallbacks>): () => void {
  const Native = NativeModules.HearthShelfAuto
  const push = () => {
    const s = getSettingsState()
    // Push whether a timer is live (not the full shouldListen): native ANDs it
    // with its own live isPlaying/car check, so play/pause flips are handled
    // natively without a JS round-trip. The haptic level rides along so the
    // service can fire the strong confirm buzz itself (instant, works locked).
    setAutoSleepShake(s.sleepShakeExtend, s.sleepShakeMinutes, timerLive(), s.haptics)
  }
  push()
  const unsubPlayer = subscribe(push)
  const unsubSettings = subscribeSettings(push)

  let sub: { remove: () => void } | null = null
  if (Native) {
    const emitter = new NativeEventEmitter(Native)
    sub = emitter.addListener('onShakeExtend', (e: { minutes: number }) => {
      // Guard against a stale event arriving after the timer ended.
      if (!shouldListen()) return
      const result = addSleepMinutes(e.minutes, true)
      if (result === 'shake-paused' || result === 'shake-disabled') {
        callbacksRef.current.onCutoff(result === 'shake-disabled' ? 'disabled' : 'paused')
        return
      }
      // No JS haptic here - the service already fired the strong confirm buzz
      // natively at shake time (instant, and works while locked/backgrounded).
      callbacksRef.current.onExtend(e.minutes)
    })
  }

  return () => {
    unsubPlayer()
    unsubSettings()
    sub?.remove()
    // Stop the native sensor when the host unmounts.
    setAutoSleepShake(false, getSettingsState().sleepShakeMinutes, false, getSettingsState().haptics)
  }
}

/** iOS / other: foreground DeviceMotion listener (Activity-bound; works while the
 *  app is in front, which is the only place it can on these platforms anyway). */
function mountDeviceMotion(callbacksRef: React.MutableRefObject<ShakeCallbacks>): () => void {
  let sub: { remove: () => void } | null = null
  let lastShakeAt = 0
  let available = true
  let cancelled = false

  const handle = (m: DeviceMotionMeasurement) => {
    const a = m.acceleration
    if (!a) return
    const mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z)
    if (mag < SHAKE_THRESHOLD) return
    const now = Date.now()
    if (now - lastShakeAt < COOLDOWN_MS) return
    // Re-check the guard at fire time (state can change between ticks).
    if (!shouldListen()) return
    lastShakeAt = now
    const mins = getSettingsState().sleepShakeMinutes
    const result = addSleepMinutes(mins, true)
    if (result === 'shake-paused' || result === 'shake-disabled') {
      callbacksRef.current.onCutoff(result === 'shake-disabled' ? 'disabled' : 'paused')
      return
    }
    haptics.confirm()
    callbacksRef.current.onExtend(mins)
  }

  const start = () => {
    if (sub || !available) return
    DeviceMotion.setUpdateInterval(UPDATE_INTERVAL_MS)
    sub = DeviceMotion.addListener(handle)
  }
  const stop = () => {
    sub?.remove()
    sub = null
  }
  const evaluate = () => {
    if (shouldListen()) start()
    else stop()
  }

  // Guard availability so web/emulators without a sensor don't crash.
  DeviceMotion.isAvailableAsync()
    .then((ok) => {
      if (cancelled) return
      available = ok
      evaluate()
    })
    .catch(() => {
      available = false
    })

  const unsubPlayer = subscribe(evaluate)
  const unsubSettings = subscribeSettings(evaluate)
  return () => {
    cancelled = true
    unsubPlayer()
    unsubSettings()
    stop()
  }
}
