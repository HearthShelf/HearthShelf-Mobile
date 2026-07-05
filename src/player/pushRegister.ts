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

let registered = false

/** Register this device for release push notifications. Idempotent per launch. */
export async function ensurePushRegistered(): Promise<void> {
  if (registered) return
  // Only bother when a project id is configured (no id -> no Expo push service).
  if (!EAS_PROJECT_ID) return
  registered = true
  try {
    // Lazy-load: importing this pulls in a native module that may be absent in
    // the current binary. A failure here is caught below and just disables push.
    const Notifications = await import('expo-notifications')

    // Note: we don't hard-gate on expo-device's isDevice - an emulator WITH
    // Google Play services can mint a token, and getExpoPushTokenAsync below is
    // the real gate (it throws on a device that genuinely can't, caught here).

    const { status: existing } = await Notifications.getPermissionsAsync()
    let status = existing
    if (status !== 'granted') {
      status = (await Notifications.requestPermissionsAsync()).status
    }
    if (status !== 'granted') {
      registered = false
      return
    }
    const { data: token } = await Notifications.getExpoPushTokenAsync({
      projectId: EAS_PROJECT_ID,
    })
    if (!token) {
      registered = false
      return
    }
    await registerPushToken(token, Platform.OS === 'ios' ? 'ios' : 'android')
  } catch {
    // Missing native module / permission failure / network, or the server not
    // yet deployed with /hs/push/register - push is simply off this launch; the
    // app keeps working.
    registered = false
  }
}

/** Reset on sign-out so the next user re-registers their own device token. */
export function resetPushRegistration(): void {
  registered = false
}
