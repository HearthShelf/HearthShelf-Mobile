/**
 * Foreground presentation + tap routing for release push notifications
 * (expo-notifications). Distinct from the notifee club-notes handlers in
 * src/social/noteEvents.ts - that's a separate delivery channel.
 *
 * Everything here lazy-loads expo-notifications via dynamic import so a build
 * without the native module linked never throws at load (see pushRegister.ts).
 * A release push carries `data: { kind: 'release', asin, signal }`; tapping it
 * opens the owned book when the signal says it has landed in the library, and
 * the upcoming page otherwise (see releaseNotificationRoute).
 */
import { router } from 'expo-router'
import { releaseNotificationRoute } from '@/notifications/releaseRoute'

/** Push kinds that point at ONE comment, and so open the club scrolled to it.
 *  Mirrors the same set in app/notifications.tsx. */
const NOTE_ANCHORED_KINDS = new Set(['mention', 'reaction', 'reply', 'lateNote'])

let mounted = false

/** Route a tapped server notification to the relevant in-app surface. */
function handleResponse(response: unknown): void {
  try {
    const data = (response as { notification?: { request?: { content?: { data?: unknown } } } })
      ?.notification?.request?.content?.data as
      | { kind?: string; asin?: string; signal?: string; clubId?: string; noteId?: string }
      | undefined
    if (data?.kind === 'release' && data.asin) {
      const asin = data.asin
      // An "it's in your library now" tap opens the owned book, not the
      // upcoming page (see releaseNotificationRoute). Async because resolving
      // the owned copy needs a lookup; it falls back to the upcoming page.
      void releaseNotificationRoute(asin, data.signal).then((path) => router.push(path))
    } else if (NOTE_ANCHORED_KINDS.has(data?.kind ?? '') && data?.clubId) {
      // ?note= scrolls the room to the comment and highlights it, so the tap
      // lands on what was actually said rather than the top of the club.
      const q = data.noteId ? `?note=${encodeURIComponent(data.noteId)}` : ''
      router.push(`/club/${encodeURIComponent(data.clubId)}${q}`)
    } else if (data?.kind === 'club_advance' && data.clubId) {
      // The club moved to a new book; open the club so the new book is right
      // there rather than making the reader find it.
      router.push(`/club/${encodeURIComponent(data.clubId)}`)
    } else if (data?.kind === 'club_invite' || data?.kind === 'club-invite') {
      // The server and the inbox both use 'club_invite'; the hyphenated form is
      // only kept so a push already queued on a device still routes.
      router.push('/notifications')
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
        await Notifications.setNotificationChannelAsync('social', {
          name: 'Invitations and social updates',
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
