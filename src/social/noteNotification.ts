/**
 * Local notification delivery for club note-pops (Phase 7 - see
 * docs/social.md "Phase 7 - in-car and background note notifications").
 *
 * When a crossed note fires while the app is NOT foreground (screen locked /
 * backgrounded during playback, JS kept alive by the Media3 foreground service),
 * the pop watcher (notePops.ts) calls displayNoteNotification instead of the
 * in-app toast. It builds a MessagingStyle conversation notification on the
 * dedicated 'club-notes' channel:
 *   - Person = the note's author, body = the note text.
 *   - A press action that deep-links to hearthshelf://club/<clubId>?note=<noteId>
 *     (the phone tap -> the club screen scrolled to that note).
 *   - A free-text reply action (RemoteInput) whose captured text posts back to
 *     /hs/notes as a reply, handled in noteEvents.ts.
 *
 * MessagingStyle + RemoteInput is why notifee is used over expo-notifications
 * (which cannot build reply actions), and it's what Android Auto renders + reads
 * aloud in the car. Everything degrades: if notifee is unavailable the caller
 * falls back to the toast.
 */
import { Platform } from 'react-native'
import type { HSNote } from '@hearthshelf/core'
import { CLUB_NOTES_CHANNEL_ID } from '@/lib/notifications'

/**
 * Action id for the reply action. noteEvents.ts matches on this to POST the
 * captured RemoteInput text as a reply.
 */
export const NOTE_REPLY_ACTION = 'note-reply'

/**
 * The data payload carried on the notification so the tap/reply handlers know
 * which note to open or reply to without re-fetching. Notifee serializes
 * `data` values to strings on Android, so every field is a string.
 */
export interface NoteNotificationData {
  kind: 'club-note'
  clubId: string
  itemId: string
  noteId: string
}

/**
 * Fire (or update) the heads-up notification for a crossed club note. Uses the
 * note id as the notification id so the same note never stacks two cards, and so
 * a later toast/notification for it is a no-op replace. Best-effort: any failure
 * (notifee missing, channel absent) is swallowed so the caller can fall back to
 * a toast without a crash.
 *
 * @param note   the just-unlocked note (author + body).
 * @param clubId the club the note belongs to (for the deep-link + reply scope).
 * @param itemId the library item the note is on (for the reply POST).
 */
export async function displayNoteNotification(note: HSNote, clubId: string, itemId: string): Promise<boolean> {
  if (Platform.OS !== 'android') return false
  let notifee: typeof import('@notifee/react-native').default
  let AndroidStyle: typeof import('@notifee/react-native').AndroidStyle
  try {
    const mod = await import('@notifee/react-native')
    notifee = mod.default
    AndroidStyle = mod.AndroidStyle
  } catch {
    // Notification library unavailable - caller falls back to the in-app toast.
    return false
  }

  const author = note.username || 'Someone'
  const data: NoteNotificationData = {
    kind: 'club-note',
    clubId,
    itemId,
    noteId: note.id,
  }

  try {
    await notifee.displayNotification({
      id: note.id,
      title: author,
      body: note.body,
      data: data as unknown as Record<string, string>,
      android: {
        channelId: CLUB_NOTES_CHANNEL_ID,
        // MessagingStyle is what Android Auto renders + reads aloud, and what the
        // Auto submission review requires (a genuine conversation notification).
        style: {
          type: AndroidStyle.MESSAGING,
          person: { name: 'You' },
          messages: [
            {
              text: note.body,
              timestamp: note.createdAt || Date.now(),
              person: { name: author, id: note.userId || author },
            },
          ],
        },
        // Phone tap -> deep-link into the club screen scrolled to this note.
        pressAction: {
          id: 'default',
          launchActivity: 'default',
        },
        // Free-text reply -> posted as a reply in noteEvents.ts. In Android Auto
        // this becomes the voice-reply action; on the phone it's a quick reply.
        actions: [
          {
            title: 'Reply',
            pressAction: { id: NOTE_REPLY_ACTION },
            input: {
              allowFreeFormInput: true,
              placeholder: 'Reply to the club…',
            },
          },
        ],
      },
    })
    return true
  } catch {
    // Best-effort - fall back to the toast on any failure.
    return false
  }
}
