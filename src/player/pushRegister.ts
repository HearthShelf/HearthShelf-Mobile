/**
 * Expo push-token registration for release notifications. Called once after a
 * session is established. Best-effort and fully self-contained: if permission is
 * denied, the device is an emulator, no EAS project id / FCM credentials are
 * provisioned, OR the native module isn't in this build yet, it quietly no-ops -
 * the rest of the notifications feature (the Home countdown banner) still works;
 * only the remote push is off.
 *
 * expo-notifications / expo-device are loaded LAZILY via dynamic import so that a
 * build without the native module linked (e.g. a JS-only reload before a native
 * rebuild) doesn't throw "Cannot find native module ExpoPushTokenManager" at
 * module-load time and take the whole app down. Distinct from the Notifee
 * club-notes channel in src/lib/notifications.ts.
 */
import { Platform } from 'react-native'
import { EAS_PROJECT_ID } from '@/lib/config'
import { registerPushToken } from '@/api/subscriptions'

/**
 * Why push is (not) working on this device. The settings screen reports this
 * verbatim, because the failure that matters most - 'unsupported' - looks
 * IDENTICAL to success from the user's side: permission is granted, the app
 * says push is on, and nothing ever arrives. That is what a build with no FCM
 * sender does (see docs/PUSH_SETUP.md), and without this we had no way to tell
 * it apart from a server-side problem.
 */
export type PushStatus =
  | 'unknown'
  /** Token minted and registered with the server. */
  | 'active'
  /** The OS refused the notification permission. */
  | 'denied'
  /** No EAS project id, or no native module, in this build. */
  | 'unconfigured'
  /** Permission granted but no token could mint - almost always a build with no
   *  FCM credentials, or an emulator without Play services. */
  | 'unsupported'
  /** Token minted but the server rejected/never received the registration. */
  | 'server-error'

let registered = false
let status: PushStatus = 'unknown'
const listeners = new Set<() => void>()

/** Current push status for this device. Reactive via subscribePushStatus. */
export function getPushStatus(): PushStatus {
  return status
}

export function subscribePushStatus(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function setStatus(next: PushStatus): void {
  if (status === next) return
  status = next
  listeners.forEach((l) => l())
}

/** Register this device for release push notifications. Idempotent per launch. */
export async function ensurePushRegistered(): Promise<void> {
  if (registered) return
  // Only bother when a project id is configured (no id -> no Expo push service).
  if (!EAS_PROJECT_ID) {
    setStatus('unconfigured')
    return
  }
  registered = true
  try {
    // Lazy-load: importing this pulls in a native module that may be absent in
    // the current binary. A failure here is caught below and just disables push.
    const Notifications = await import('expo-notifications')

    // Note: we don't hard-gate on expo-device's isDevice - an emulator WITH
    // Google Play services can mint a token, and getExpoPushTokenAsync below is
    // the real gate (it throws on a device that genuinely can't, caught here).

    const { status: existing } = await Notifications.getPermissionsAsync()
    let permission = existing
    if (permission !== 'granted') {
      permission = (await Notifications.requestPermissionsAsync()).status
    }
    if (permission !== 'granted') {
      registered = false
      setStatus('denied')
      return
    }

    // getExpoPushTokenAsync is the real gate. It THROWS on a build with no FCM
    // sender ("Default FirebaseApp is not initialized"), which is the silent
    // failure this whole status exists to surface - so it gets its own catch
    // rather than sharing the outer one with the network call below.
    let pushToken = ''
    try {
      const { data } = await Notifications.getExpoPushTokenAsync({
        projectId: EAS_PROJECT_ID,
      })
      pushToken = data ?? ''
    } catch {
      registered = false
      setStatus('unsupported')
      return
    }
    if (!pushToken) {
      registered = false
      setStatus('unsupported')
      return
    }

    try {
      await registerPushToken(pushToken, Platform.OS === 'ios' ? 'ios' : 'android')
      setStatus('active')
    } catch {
      // The token is fine; the server didn't take it (not yet deployed with
      // /hs/push/register, or offline). Retry on the next connect.
      registered = false
      setStatus('server-error')
    }
  } catch {
    // Missing native module or an unexpected failure - push is simply off this
    // launch; the app keeps working.
    registered = false
    setStatus('unconfigured')
  }
}

/** Reset on sign-out so the next user re-registers their own device token. */
export function resetPushRegistration(): void {
  registered = false
  setStatus('unknown')
}
