/**
 * App-update prompts, checked at launch and on each return to foreground.
 *
 * Android: Google Play's native in-app updates (expo-in-app-updates wraps the
 * Play Core library). Play itself knows whether a newer build is live on the
 * user's track, and `startUpdate` shows the Play-branded sheet - flexible
 * (dismissible bottom sheet, background download) by default, immediate
 * (blocking full-screen Play UI) when the control plane has escalated the
 * release. Only works for Play-installed builds; on a sideloaded/debug build the
 * native check simply reports no update.
 *
 * iOS: no OS equivalent exists, so the app compares its own baked version
 * against GET /releases/mobile on the control plane (a 6h-cron cache of the
 * mobile repo's release tags, admin-overridable). A plain newer version raises a
 * dismissible toast with an Update action; a security/critical escalation or a
 * version below the admin-set min_supported floor raises a native alert that
 * re-fires on every foreground until updated.
 *
 * The soft prompt is throttled to once per day so it nags, not harasses. The
 * forced path deliberately ignores the throttle.
 */
import { Alert, AppState, Linking, Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { showToast } from '@/ui/Toast'
import { CONTROL_PLANE_URL, FULL_VERSION } from '@/lib/config'

/** Last time a soft prompt was shown (ms epoch, stringified). */
const PROMPTED_AT_KEY = 'hs.updateCheck.promptedAt'
const PROMPT_INTERVAL_MS = 24 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 8000

interface MobileRelease {
  version: string
  severity: 'info' | 'recommended' | 'security' | 'critical'
  notes_url: string | null
  min_supported: string | null
  store_urls: { ios: string; android: string }
}

/** '0.0.8-Beta1' -> [0, 0, 8]. Missing parts count as 0. */
function parseVersion(v: string): number[] {
  const m = String(v)
    .trim()
    .replace(/^v/i, '')
    .match(/^\d+(\.\d+){0,2}/)
  if (!m) return []
  return m[0].split('.').map(Number)
}

/** True when `current` is a strictly older x.y.z than `target`. Unparseable
 *  input is treated as up-to-date - never nag on a version we can't read. */
function isBelow(current: string, target: string): boolean {
  const c = parseVersion(current)
  const t = parseVersion(target)
  if (!c.length || !t.length) return false
  for (let i = 0; i < 3; i++) {
    const a = c[i] || 0
    const b = t[i] || 0
    if (a < b) return true
    if (a > b) return false
  }
  return false
}

async function softPromptAllowed(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(PROMPTED_AT_KEY)
    const last = raw ? Number(raw) : 0
    return !Number.isFinite(last) || Date.now() - last > PROMPT_INTERVAL_MS
  } catch {
    return true
  }
}

async function recordSoftPrompt(): Promise<void> {
  try {
    await AsyncStorage.setItem(PROMPTED_AT_KEY, String(Date.now()))
  } catch {
    // Best-effort; worst case the prompt shows again next foreground.
  }
}

/** Fetch the control plane's cached latest-mobile release. Null on any failure
 *  (offline, timeout, endpoint missing) - update prompts are never worth an
 *  error surface of their own. */
async function fetchMobileRelease(): Promise<MobileRelease | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${CONTROL_PLANE_URL}/releases/mobile`, { signal: ctrl.signal })
    if (!res.ok) return null
    const body = (await res.json()) as { release?: MobileRelease | null }
    return body?.release ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Whether the control plane says this release must not keep running: below the
 *  admin-set floor, or the latest release is a security/critical escalation
 *  that this build predates. */
function isForced(release: MobileRelease, current: string): boolean {
  if (release.min_supported && isBelow(current, release.min_supported)) return true
  return (
    (release.severity === 'security' || release.severity === 'critical') &&
    isBelow(current, release.version)
  )
}

// --- Android: Play in-app updates -------------------------------------------

async function checkAndroid(): Promise<void> {
  // Lazy-require so a JS bundle that lands on a binary without the native
  // module (dev deploy without rebuild) degrades to a no-op instead of
  // crashing at import time.
  let ExpoInAppUpdates: typeof import('expo-in-app-updates')
  try {
    ExpoInAppUpdates = require('expo-in-app-updates')
  } catch {
    return
  }
  try {
    const info = await ExpoInAppUpdates.checkForUpdate()
    if (!info.updateAvailable) return

    // The control plane's severity/floor escalation decides immediate vs
    // flexible (Play priorities would need the Play Developer API per release;
    // the CP row is the lever we actually operate). CP unreachable -> flexible.
    const release = await fetchMobileRelease()
    const forced = !!release && isForced(release, FULL_VERSION)

    if (forced && info.immediateAllowed) {
      // Blocking Play UI; re-fires every foreground until updated.
      await ExpoInAppUpdates.startUpdate(true)
      return
    }
    if (!info.flexibleAllowed) return
    if (!(await softPromptAllowed())) return
    await recordSoftPrompt()
    await ExpoInAppUpdates.startUpdate(false)
  } catch {
    // Play unavailable (sideload, emulator without Play) - nothing to do.
  }
}

// --- iOS: control-plane version gate ----------------------------------------

// Re-showing the forced alert on every foreground is the "sticky" mechanism,
// but never stack a second alert on top of an open one.
let forcedAlertShowing = false

function showForcedAlert(release: MobileRelease): void {
  if (forcedAlertShowing) return
  forcedAlertShowing = true
  Alert.alert(
    'Update required',
    'This version of HearthShelf is no longer supported. Please update to keep listening.',
    [
      {
        text: 'Update',
        onPress: () => {
          forcedAlertShowing = false
          void Linking.openURL(release.store_urls.ios)
        },
      },
    ],
    // No tap-outside dismissal; the single button is the only way out and it
    // leaves the alert re-armed for the next foreground.
    { cancelable: false },
  )
}

async function checkIOS(): Promise<void> {
  const release = await fetchMobileRelease()
  if (!release) return
  if (!isBelow(FULL_VERSION, release.version)) return

  if (isForced(release, FULL_VERSION)) {
    showForcedAlert(release)
    return
  }
  if (!(await softPromptAllowed())) return
  await recordSoftPrompt()
  showToast(`Update available: ${release.version}`, {
    action: { label: 'Update', onPress: () => void Linking.openURL(release.store_urls.ios) },
    durationMs: 8000,
  })
}

// --- wiring ------------------------------------------------------------------

let checking = false

/** Run one update check, platform-appropriate. Safe to call often; overlapping
 *  calls coalesce. */
export async function checkForAppUpdate(): Promise<void> {
  // Dev builds bake the static fallback version (0.0.2) and would nag forever.
  if (__DEV__) return
  if (checking) return
  checking = true
  try {
    if (Platform.OS === 'android') await checkAndroid()
    else if (Platform.OS === 'ios') await checkIOS()
  } finally {
    checking = false
  }
}

/**
 * Mount the update checker: one check now, then on every background->active
 * transition. Returns an unmount cleanup. Mounted once from the root layout.
 */
export function mountUpdateCheck(): () => void {
  void checkForAppUpdate()
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active') void checkForAppUpdate()
  })
  return () => sub.remove()
}
