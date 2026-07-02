/**
 * Local notification channel setup (Phase 7 foundation - see
 * docs/social.md "Phase 7 - in-car and background note notifications").
 *
 * Club note-pops need a real Android notification when the app isn't
 * foreground (phone locked/backgrounded) or when playback is happening in
 * Android Auto (a separate native service - see
 * plugins/hearthshelf-auto/android/HearthShelfAutoService.kt). Notifee is
 * used instead of expo-notifications because Android Auto's reply action
 * needs a MessagingStyle notification with a RemoteInput action, which
 * expo-notifications cannot build.
 *
 * This module only ensures the channel exists; the actual note-pop -> local
 * notification delivery is built in a later phase.
 */
import { Platform } from 'react-native'
import notifee, { AndroidImportance } from '@notifee/react-native'

/** Dedicated channel id for club note-pop conversation notifications. */
export const CLUB_NOTES_CHANNEL_ID = 'club-notes'

let ensured = false

/**
 * Create the club-notes channel once. Safe to call repeatedly (notifee
 * upserts by id). POST_NOTIFICATIONS is already requested by PlayerHost on
 * Android 13+ for the media notification, so this never prompts on its own.
 */
export async function ensureNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') return
  if (ensured) return
  ensured = true
  try {
    await notifee.createChannel({
      id: CLUB_NOTES_CHANNEL_ID,
      name: 'Book Club notes',
      description: 'Notes from your Book Club when a note you cross is posted.',
      importance: AndroidImportance.HIGH,
    })
  } catch {
    // Best-effort - a missing channel just means no notification later, not a crash.
    ensured = false
  }
}
