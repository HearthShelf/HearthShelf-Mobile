/**
 * Glue between the on-disk crash breadcrumb log (crashLog.ts) and the backend
 * upload (controlPlane.reportMobileCrash). Kept separate from crashLog.ts so the
 * logger has no dependency on Clerk, the control-plane client, or expo-device -
 * it stays a pure disk primitive that index.js can load at the very top.
 *
 * Flow:
 *   - index.js calls initCrashLog()/installCrashHandler() at module load.
 *   - The root layout calls flushPriorCrash(getToken) once a Clerk token exists;
 *     if the last run crashed, its breadcrumb trail is uploaded here.
 *   - The root layout calls mountCrashLifecycle() to mark clean-shutdown on
 *     background and re-arm on foreground.
 */
import { AppState, type AppStateStatus, Platform } from 'react-native'
import * as Device from 'expo-device'
import Constants from 'expo-constants'
import { takePriorCrashReport, markCleanShutdown, markRunning } from './crashLog'
import { reportMobileCrash, type GetToken } from '@/api/controlPlane'

/** Static device/app context attached to every crash report. Cheap to compute. */
function deviceContext(): Record<string, unknown> {
  return {
    platform: Platform.OS,
    osVersion: Device.osVersion ?? null,
    model: Device.modelName ?? null,
    brand: Device.brand ?? null,
    isDevice: Device.isDevice,
    appVersion: Constants.expoConfig?.version ?? null,
    // The native build number - lets us tell which binary a tester is on.
    nativeBuild: (Constants.expoConfig?.android?.versionCode ?? null) as number | null,
  }
}

/**
 * If the previous run ended in a crash, upload its breadcrumb trail. Best-effort
 * and idempotent: takePriorCrashReport() consumes the report so a second call
 * (e.g. a re-render) does nothing. Never throws.
 */
export async function flushPriorCrash(getToken: GetToken): Promise<void> {
  const prior = await takePriorCrashReport()
  if (!prior) return
  try {
    const uptimeMs = Date.now() - prior.startedAt
    const last = prior.lastCrumb
    const repeatSuffix = last?.repeats ? ` (x${last.repeats})` : ''
    await reportMobileCrash(getToken, {
      event: 'mobile_crash',
      message: last ? `${last.tag}: ${last.msg}${repeatSuffix}` : 'unclean exit',
      detail: {
        ...deviceContext(),
        startedAt: prior.startedAt,
        approxRunMs: uptimeMs,
        crumbs: prior.crumbs,
      },
    })
  } catch {
    // best-effort; the report was already consumed. A future crash still reports.
  }
}

/**
 * Track foreground/background transitions to drive the clean-shutdown sentinel.
 * On Android there is no reliable "app is being killed" callback for a native
 * abort or a recents-swipe, so we treat backgrounding as the last clean point:
 * mark clean on background, re-arm on foreground. Returns an unsubscribe fn for
 * the effect cleanup.
 */
export function mountCrashLifecycle(): () => void {
  const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
    if (next === 'active') markRunning()
    else if (next === 'background') markCleanShutdown()
  })
  return () => sub.remove()
}
