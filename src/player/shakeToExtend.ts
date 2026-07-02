/**
 * Shake-to-extend the sleep timer. When the user enables it and a duration/clock
 * sleep timer is winding down, a shake of the phone adds a few minutes so they
 * don't have to open the player and fiddle with a slider half-asleep.
 *
 * The accelerometer is only subscribed while it can actually do something -
 * setting on, a duration/clock timer running, and playback playing - so it
 * doesn't drain the battery listening 24/7. It watches both the player store
 * and the settings store and (un)subscribes as those conditions flip.
 *
 * DeviceMotion.acceleration is gravity-removed (m/s^2), so a still phone reads
 * ~0 and a deliberate shake spikes well past the threshold.
 */
import { useEffect, useRef } from 'react'
import { DeviceMotion, type DeviceMotionMeasurement } from 'expo-sensors'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { haptics } from '@/ui/haptics'
import { addSleepMinutes, getState, subscribe } from './store'

/** Shake magnitude (m/s^2) that counts as an intentional shake. */
const SHAKE_THRESHOLD = 18
/** How often DeviceMotion reports (ms). */
const UPDATE_INTERVAL_MS = 100
/** Minimum gap between two accepted shakes (ms), so one shake adds time once. */
const COOLDOWN_MS = 3000

/** Whether the shake listener should currently be running. */
function shouldListen(): boolean {
  const s = getSettingsState()
  if (!s.sleepShakeExtend) return false
  const player = getState()
  if (!player.isPlaying) return false
  const timer = player.sleepTimer
  return timer?.kind === 'duration' || timer?.kind === 'clock'
}

/**
 * Mount the shake-to-extend listener. Call once from a persistent host
 * component (PlayerHost). `onExtend` fires with the minutes added so the host
 * can show a confirmation toast in component context.
 */
export function useShakeToExtend(onExtend: (mins: number) => void): void {
  const onExtendRef = useRef(onExtend)
  onExtendRef.current = onExtend

  useEffect(() => {
    let sub: { remove: () => void } | null = null
    let lastShakeAt = 0
    let available = true

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
      addSleepMinutes(mins)
      haptics.mode()
      onExtendRef.current(mins)
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
        available = ok
        evaluate()
      })
      .catch(() => {
        available = false
      })

    const unsubPlayer = subscribe(evaluate)
    const unsubSettings = subscribeSettings(evaluate)
    return () => {
      unsubPlayer()
      unsubSettings()
      stop()
    }
  }, [])
}
