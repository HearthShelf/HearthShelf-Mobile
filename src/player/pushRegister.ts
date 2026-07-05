/**
 * Expo push-token registration for release notifications. Called once after a
 * session is established. Best-effort and fully self-contained: if permission is
 * denied, the device is an emulator, or no EAS project id / FCM credentials are
 * provisioned, it quietly no-ops - the rest of the notifications feature (the
 * Home countdown banner) still works; only the remote push is off.
 *
 * Uses expo-notifications (Expo push service) so the server can deliver via
 * Expo's HTTP push API. Distinct from the Notifee club-notes channel in
 * src/lib/notifications.ts (local notifications for Android Auto).
 */
import { Platform } from 'react-native'
import * as Notifications from 'expo-notifications'
import * as Device from 'expo-device'
import { EAS_PROJECT_ID } from '@/lib/config'
import { registerPushToken } from '@/api/subscriptions'

let registered = false

/** Register this device for release push notifications. Idempotent per launch. */
export async function ensurePushRegistered(): Promise<void> {
  if (registered) return
  // Push tokens only come from real devices, and only when a project id is set.
  if (!Device.isDevice || !EAS_PROJECT_ID) return
  registered = true
  try {
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
    // Best-effort: a failure here just means no remote push this launch.
    registered = false
  }
}

/** Reset on sign-out so the next user re-registers their own device token. */
export function resetPushRegistration(): void {
  registered = false
}
