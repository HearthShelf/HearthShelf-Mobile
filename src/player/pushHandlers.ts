/**
 * Foreground presentation + tap routing for release push notifications
 * (expo-notifications). Distinct from the notifee club-notes handlers in
 * src/social/noteEvents.ts - that's a separate delivery channel.
 *
 * Everything here lazy-loads expo-notifications via dynamic import so a build
 * without the native module linked never throws at load (see pushRegister.ts).
 * A release push carries `data: { kind: 'release', asin, signal }`; tapping it
 * opens the upcoming-book page for that ASIN.
 */
import { router } from 'expo-router'

let mounted = false

/** Route a tapped release notification to the upcoming-book page. */
function handleResponse(response: unknown): void {
  try {
    const data = (response as { notification?: { request?: { content?: { data?: unknown } } } })
      ?.notification?.request?.content?.data as { kind?: string; asin?: string } | undefined
    if (data?.kind === 'release' && data.asin) {
      router.push(`/upcoming/${encodeURIComponent(data.asin)}`)
    }
  } catch {
    // A malformed payload just doesn't navigate.
  }
}

/**
 * Mount the foreground handler + tap listener + Android channel. Idempotent;
 * safe to call once at app start. Returns a teardown fn (also a no-op cleanup
 * when the native module is absent). Consumes a cold-start tap too.
 */
export function mountPushHandlers(): () => void {
  if (mounted) return () => {}
  mounted = true
  let sub: { remove: () => void } | null = null

  void (async () => {
    try {
      const Notifications = await import('expo-notifications')
      const { Platform } = await import('react-native')

      // Show release notifications while the app is foregrounded, too.
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: false,
          shouldSetBadge: false,
        }),
      })

      // A dedicated Android channel so release alerts are grouped/labelled.
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('releases', {
          name: 'Book releases',
          importance: Notifications.AndroidImportance.DEFAULT,
        })
      }

      // Taps while running / backgrounded.
      sub = Notifications.addNotificationResponseReceivedListener(handleResponse)

      // Cold start: the app was launched by tapping a notification.
      const initial = await Notifications.getLastNotificationResponseAsync()
      if (initial) handleResponse(initial)
    } catch {
      // Native module absent or unavailable - handlers simply don't attach.
    }
  })()

  return () => {
    sub?.remove()
    mounted = false
  }
}
