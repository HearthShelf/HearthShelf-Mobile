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
    // Lazy-load: importing these pulls in native modules that may be absent in
    // the current binary. A failure here is caught below and just disables push.
    const [Notifications, Device] = await Promise.all([
      import('expo-notifications'),
      import('expo-device'),
    ])

    // Push tokens only come from real devices.
    if (!Device.isDevice) {
      registered = false
      return
    }

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
    // Missing native module / permission failure / network - push is simply off
    // this launch; the app keeps working.
    registered = false
  }
}

/** Reset on sign-out so the next user re-registers their own device token. */
export function resetPushRegistration(): void {
  registered = false
}
