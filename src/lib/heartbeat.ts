/**
 * Anonymous install heartbeat.
 *
 * Reports this install's coarse facts - app version, device model/type, OS - to
 * the control plane's public telemetry endpoint so the app appears on the
 * community stats dashboard (hearthshelf.com/stats) alongside self-hosted
 * servers. Mirrors the crashReporter pattern: best-effort, never throws.
 *
 * Deliberately UNAUTHENTICATED and NOT tied to a user. The endpoint
 * (POST /telemetry/report) takes no auth, and we send no Clerk token, user id,
 * server id, book, or listening data - only the random per-install `deviceId`
 * (already minted for device-scoped settings) as the opaque `telemetry_id`, plus
 * the hardware/version facts. On by default; the user can turn it off under
 * Settings (shareInstallStats), and offline / a failed POST is a silent no-op.
 *
 * Cadence matches the server telemetry: report once per launch, then at most
 * weekly, so a long-lived background session doesn't spam the endpoint.
 */
import { AppState, type AppStateStatus, Platform } from 'react-native'
import * as Device from 'expo-device'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { HSInstallReport, HSInstallDeviceType, HSInstallPlatform } from '@hearthshelf/core'
import { CONTROL_PLANE_URL, FULL_VERSION } from '@/lib/config'
import { fetchWithTimeout } from '@/api/fetchWithTimeout'
import { ensureDeviceId } from '@/store/settings'
import { getSettingsState } from '@/store/settings'

/** Least time between reports. One report per launch, then weekly at most. */
const REPORT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
const LAST_REPORT_KEY = 'hs.lastHeartbeatAt'

/** Map expo-device's DeviceType enum to the shared HSInstallDeviceType. */
function deviceType(): HSInstallDeviceType | undefined {
  switch (Device.deviceType) {
    case Device.DeviceType.PHONE:
      return 'phone'
    case Device.DeviceType.TABLET:
      return 'tablet'
    case Device.DeviceType.DESKTOP:
      return 'desktop'
    default:
      return undefined // UNKNOWN / TV / null - leave unset rather than guess
  }
}

/** The install platform from the OS. Only ios/android ship this client. */
function platform(): HSInstallPlatform | undefined {
  if (Platform.OS === 'ios') return 'ios'
  if (Platform.OS === 'android') return 'android'
  return undefined
}

/** Build the anonymous report body. Cheap, synchronous once deviceId is known. */
function buildReport(telemetryId: string): HSInstallReport {
  return {
    telemetry_id: telemetryId,
    platform: platform(),
    device_model: Device.modelName ?? null,
    device_type: deviceType(),
    os_name: Device.osName ?? null,
    os_version: Device.osVersion ?? null,
    app_version: FULL_VERSION || null,
  }
}

/**
 * Send the heartbeat if due and the user hasn't opted out. Best-effort: any
 * failure (offline, timeout, non-2xx) is swallowed and simply retried on a later
 * launch. `force` bypasses the weekly throttle (used when the user re-enables the
 * toggle, so the dashboard reflects them immediately).
 */
export async function sendHeartbeat(force = false): Promise<void> {
  try {
    if (!getSettingsState().shareInstallStats) return

    if (!force) {
      const last = await AsyncStorage.getItem(LAST_REPORT_KEY)
      if (last) {
        const at = Number(last)
        if (Number.isFinite(at) && Date.now() - at < REPORT_INTERVAL_MS) return
      }
    }

    const telemetryId = await ensureDeviceId()
    if (!telemetryId) return

    const res = await fetchWithTimeout(`${CONTROL_PLANE_URL}/telemetry/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildReport(telemetryId)),
    })
    // Only stamp the throttle on a real success, so a rejected/failed report is
    // retried next launch rather than suppressed for a week.
    if (res.ok) await AsyncStorage.setItem(LAST_REPORT_KEY, String(Date.now()))
  } catch {
    // Best-effort; nothing to recover. A later launch tries again.
  }
}

/**
 * Fire a heartbeat now (on mount) and again whenever the app returns to the
 * foreground, subject to the weekly throttle. Returns an unsubscribe fn for the
 * effect cleanup. Mirrors mountCrashLifecycle's AppState wiring.
 */
export function mountHeartbeat(): () => void {
  void sendHeartbeat()
  const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
    if (next === 'active') void sendHeartbeat()
  })
  return () => sub.remove()
}
