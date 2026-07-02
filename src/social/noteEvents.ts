/**
 * Notifee event handling for club note-pop notifications (Phase 7 - see
 * docs/social.md). One handler shape serves both the foreground and background
 * events; two thin wrappers register it in each context:
 *
 *   - Tap (EventType.PRESS): route to hearthshelf://club/<clubId>?note=<noteId>
 *     so app/club/[id].tsx opens scrolled to the note. Works cold or warm - a
 *     cold start is caught by getInitialNotification() in registerNoteEventHandlers.
 *   - Reply (EventType.ACTION_PRESS on NOTE_REPLY_ACTION): the captured
 *     RemoteInput text is POSTed to /hs/notes as a reply (parentId = the note),
 *     then the notification is cancelled. This is the Android-Auto voice-reply
 *     path and the phone quick-reply, sharing one code path.
 *
 * The background handler MUST be registered at module load in the app entry
 * (index.js) so notifee can invoke it when the app process is woken with no UI;
 * the foreground handler is mounted from the root layout. Everything degrades:
 * if notifee is unavailable these are no-ops.
 */
import { router } from 'expo-router'
import { postNote } from '@/api/notes'
import { getSession, hydrateSession } from '@/api/session'
import type { NoteNotificationData } from './noteNotification'
import { NOTE_REPLY_ACTION, NOTE_MARK_READ_ACTION } from './noteNotification'

/** Build the club deep-link path with the note to scroll to. */
function clubNotePath(clubId: string, noteId: string): string {
  const q = noteId ? `?note=${encodeURIComponent(noteId)}` : ''
  return `/club/${encodeURIComponent(clubId)}${q}`
}

function readData(raw: unknown): NoteNotificationData | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (d.kind !== 'club-note') return null
  const clubId = typeof d.clubId === 'string' ? d.clubId : ''
  if (!clubId) return null
  return {
    kind: 'club-note',
    clubId,
    itemId: typeof d.itemId === 'string' ? d.itemId : '',
    noteId: typeof d.noteId === 'string' ? d.noteId : '',
  }
}

/**
 * Handle one notifee event. `EventType` is passed in (imported by the caller from
 * the loaded notifee module) so this file needs no static notifee import - it
 * stays importable even where the library is absent.
 */
async function handleEvent(
  type: number,
  detail: { notification?: { id?: string; data?: unknown }; input?: string; pressAction?: { id?: string } },
  EventType: typeof import('@notifee/react-native').EventType,
): Promise<void> {
  const data = readData(detail.notification?.data)
  if (!data) return

  if (type === EventType.PRESS) {
    router.push(clubNotePath(data.clubId, data.noteId))
    return
  }

  // Android Auto's mark-as-read action (and any explicit dismiss): just clear
  // the card. No post, no navigation - the driver is done with it.
  if (type === EventType.ACTION_PRESS && detail.pressAction?.id === NOTE_MARK_READ_ACTION) {
    try {
      const notifee = (await import('@notifee/react-native')).default
      if (detail.notification?.id) await notifee.cancelNotification(detail.notification.id)
    } catch {
      // best-effort
    }
    return
  }

  if (type === EventType.ACTION_PRESS && detail.pressAction?.id === NOTE_REPLY_ACTION) {
    const text = (detail.input ?? '').trim()
    if (text && data.itemId) {
      // The process may have been woken cold by notifee with no UI, so the
      // in-memory session is empty - rehydrate the ABS token from secure store
      // before posting, or the reply silently drops.
      if (!getSession()) await hydrateSession()
      if (getSession()) {
        await postNote({
          libraryItemId: data.itemId,
          clubId: data.clubId,
          parentId: data.noteId,
          // Replies inherit the parent's time gate; a reply carries no timestamp.
          timeSec: null,
          body: text,
        })
      }
    }
    // Clear the card once handled so a stale reply prompt doesn't linger.
    try {
      const notifee = (await import('@notifee/react-native')).default
      if (detail.notification?.id) await notifee.cancelNotification(detail.notification.id)
    } catch {
      // best-effort
    }
  }
}

let foregroundUnsub: (() => void) | null = null

/**
 * Register the background event handler (call once, at module load, from the app
 * entry) and consume any notification that cold-started the app. Safe to call on
 * platforms without notifee - it degrades to a no-op.
 */
export async function registerNoteEventHandlers(): Promise<void> {
  let notifee: typeof import('@notifee/react-native').default
  let EventType: typeof import('@notifee/react-native').EventType
  try {
    const mod = await import('@notifee/react-native')
    notifee = mod.default
    EventType = mod.EventType
  } catch {
    return
  }

  notifee.onBackgroundEvent(async ({ type, detail }) => {
    await handleEvent(type, detail, EventType)
  })

  // Cold start: the app was launched by tapping the notification.
  try {
    const initial = await notifee.getInitialNotification()
    if (initial) {
      // Defer so the router is mounted before we push.
      setTimeout(() => {
        void handleEvent(EventType.PRESS, { notification: initial.notification }, EventType)
      }, 0)
    }
  } catch {
    // best-effort
  }
}

/**
 * Mount the foreground event handler (from the root layout). Returns a cleanup.
 * A warm tap (app already open) routes to the club note; a foreground reply posts
 * the same way. No-op where notifee is unavailable.
 */
export function mountNoteForegroundHandler(): () => void {
  let cancelled = false
  void (async () => {
    let notifee: typeof import('@notifee/react-native').default
    let EventType: typeof import('@notifee/react-native').EventType
    try {
      const mod = await import('@notifee/react-native')
      notifee = mod.default
      EventType = mod.EventType
    } catch {
      return
    }
    if (cancelled) return
    foregroundUnsub = notifee.onForegroundEvent(({ type, detail }) => {
      void handleEvent(type, detail, EventType)
    })
  })()
  return () => {
    cancelled = true
    foregroundUnsub?.()
    foregroundUnsub = null
  }
}
