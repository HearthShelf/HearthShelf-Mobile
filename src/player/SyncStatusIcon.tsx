/**
 * Header status pill for the player: shows at a glance whether your listening has
 * reached the server, and taps to open a sheet that explains the state in plain
 * language and lets you push to the server now.
 *
 * Three steady states (no flicker on background syncs):
 *  - green  cloud-done:  server reachable and everything is synced.
 *  - orange cloud-queue: listening/position not yet on the server, but reachable
 *                        (a scrub-while-paused, or listened-time mid-sync).
 *  - red    cloud-off:   can't reach the server (offline or a failed sync).
 *
 * The icon alone is a mystery on its own, so a tap no longer silently fires a
 * sync - it opens SyncStatusSheet, which names the state, says when your progress
 * last reached the server, and offers a Sync now button with real feedback.
 */
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { useSyncExternalStore } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'
import { formatTimestamp } from '@hearthshelf/core'
import { getState, subscribe, currentChapter } from './store'
import { AppText, Sheet, Touchable, type SheetRef } from '@/ui/primitives'
import { Icon, icons, type IconName } from '@/ui/icons'
import { useTheme } from '@/ui/ThemeProvider'
import { useConnection, type ConnectionStatus } from '@/api/ConnectionProvider'
import { getSyncState, subscribeSyncState, type SyncState } from './syncState'
import { forceSyncNow } from './playback'
import {
  getPendingSessionState,
  subscribePendingSessions,
  flushPendingProgress,
} from './pendingProgress'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'

type Look = { name: IconName; color: string }

/** Which of the three steady looks the current sync + connection state maps to. */
function resolve(
  sync: SyncState,
  conn: ConnectionStatus,
  colors: Palette,
): { look: Look; kind: 'synced' | 'pending' | 'offline' } {
  // The player's own sync result is the stronger signal and WINS over the
  // connection phase. A sync that landed is direct proof the server is reachable,
  // whereas conn.phase can be a stale 'offline' - it's set by an edge-triggered
  // connect whose recovery paths don't fire on a merely slow connection. Reading
  // the phase first made a working, actively-syncing player show a red icon, and
  // left it red for seconds after a manual sync reported success.
  if (sync.status === 'failed')
    return { look: { name: icons.cloudOff, color: colors.destructive }, kind: 'offline' }
  if (sync.status === 'synced')
    return { look: { name: icons.cloudDone, color: colors.success }, kind: 'synced' }
  if (sync.status === 'pending')
    return { look: { name: icons.cloudQueue, color: colors.accent }, kind: 'pending' }
  // Only with no sync verdict of our own (idle) does the connection phase decide.
  if (conn.phase === 'offline')
    return { look: { name: icons.cloudOff, color: colors.destructive }, kind: 'offline' }
  return { look: { name: icons.cloudDone, color: colors.success }, kind: 'synced' }
}

export function SyncStatusIcon() {
  const { colors } = useTheme()
  const { status: conn } = useConnection()
  const sync = useSyncExternalStore(subscribeSyncState, getSyncState)
  const sheetRef = useRef<SyncStatusSheetHandle>(null)

  if (sync.status === 'idle') return null

  const { look } = resolve(sync, conn, colors)

  return (
    <>
      <Pressable
        onPress={() => {
          haptics.select()
          sheetRef.current?.present()
        }}
        hitSlop={10}
        accessibilityLabel="Sync status"
      >
        <Icon name={look.name} size={22} color={look.color} />
      </Pressable>
      <SyncStatusSheet ref={sheetRef} />
    </>
  )
}

// ---- Explanatory sheet ----

export interface SyncStatusSheetHandle {
  present: () => void
  dismiss: () => void
}

/** Plain-language copy for each state - the whole point of the sheet is that the
 *  listener should never have to guess what a colored cloud means. */
const COPY: Record<
  'synced' | 'pending' | 'offline',
  { title: string; body: string }
> = {
  synced: {
    title: 'Progress saved',
    body: 'Your spot and listening time are up to date on your server. Nothing to do.',
  },
  pending: {
    title: 'Catching up',
    body: 'You have listening that has not reached your server yet. It saves on its own as you listen - tap Sync now to push it right away.',
  },
  offline: {
    title: "Can't reach your server",
    body: "The app couldn't reach your server, so your latest listening is saved on this phone for now. It's not lost - it syncs on its own once you're back online. Tap Retry to try again right now.",
  },
}

function relativeTime(from: number, now: number): string {
  const sec = Math.max(0, Math.round((now - from) / 1000))
  if (sec < 10) return 'just now'
  if (sec < 60) return `${sec}s ago`
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} min ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} hr ago`
  const day = Math.round(hr / 24)
  return `${day} day${day === 1 ? '' : 's'} ago`
}

type Feedback = 'idle' | 'syncing' | 'ok' | 'fail'

const SyncStatusSheet = forwardRef<SyncStatusSheetHandle>(function SyncStatusSheet(_props, ref) {
  const sheetRef = useRef<SheetRef>(null)
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { status: conn } = useConnection()
  const sync = useSyncExternalStore(subscribeSyncState, getSyncState)
  const pending = useSyncExternalStore(subscribePendingSessions, getPendingSessionState)
  const { nowPlaying, position } = useSyncExternalStore(subscribe, getState)
  const [feedback, setFeedback] = useState<Feedback>('idle')
  // This device's current spot, so the sheet shows where "here" is on the server.
  const ch = currentChapter()
  const devicePosition = nowPlaying
    ? ch?.title
      ? `${ch.title} · ${formatTimestamp(position)}`
      : formatTimestamp(position)
    : null

  useImperativeHandle(ref, () => ({
    present: () => {
      setFeedback('idle')
      sheetRef.current?.present()
    },
    dismiss: () => sheetRef.current?.dismiss(),
  }))

  const { look, kind } = resolve(sync, conn, colors)
  const copy = COPY[kind]

  const lastSynced =
    sync.lastSyncedAt != null ? relativeTime(sync.lastSyncedAt, Date.now()) : null

  // Books listened offline that haven't reached the server yet, so we can name
  // exactly what's waiting instead of a vague "some listening".
  const queued = [...pending.byId.values()]

  const syncing = feedback === 'syncing'
  // Green = nothing to push, so the button just confirms; every other state
  // offers a real retry (the user asked for this even when it will likely fail).
  const retry = kind !== 'synced'

  const onSync = async () => {
    haptics.select()
    setFeedback('syncing')
    const hadQueue = queued.length > 0
    // Push both the live session (current spot + listened-time) and any offline
    // banked sessions, so one tap truly catches everything up.
    const [live, flushed] = await Promise.all([forceSyncNow(), flushPendingProgress()])
    // Only claim success when a push actually reached the server. flushed is also
    // true when there was nothing queued (a no-op), so it only counts as a real
    // server round-trip when we had queued sessions going in - otherwise an
    // offline tap with an empty queue would falsely report "Saved".
    const ok = live || (hadQueue && flushed)
    if (ok) haptics.success()
    else haptics.warn()
    setFeedback(ok ? 'ok' : 'fail')
  }

  const btnLabel = syncing
    ? 'Syncing...'
    : feedback === 'ok'
      ? 'Synced'
      : retry
        ? 'Retry sync'
        : 'Sync now'

  return (
    <Sheet ref={sheetRef} kicker="Sync">
      <View style={styles.body}>
        <View style={[styles.badge, { backgroundColor: look.color + '22' }]}>
          <Icon name={look.name} size={30} color={look.color} />
        </View>
        <AppText variant="title" style={{ textAlign: 'center' }}>
          {copy.title}
        </AppText>
        <AppText
          variant="meta"
          color={colors.textMuted}
          style={{ textAlign: 'center', lineHeight: 21 }}
        >
          {copy.body}
        </AppText>

        {lastSynced && (
          <View style={styles.metaRow}>
            <Icon name={icons.checkCircle} size={15} color={colors.textFaint} />
            <AppText variant="caption" color={colors.textMuted}>
              Last saved to server {lastSynced}
            </AppText>
          </View>
        )}

        {devicePosition && (
          <View style={styles.metaRow}>
            <Icon name={icons.nowPlaying} size={15} color={colors.textFaint} />
            <AppText variant="caption" color={colors.textMuted}>
              This device's position · {devicePosition}
            </AppText>
          </View>
        )}

        {queued.length > 0 && (
          <View style={styles.queued}>
            <AppText variant="caption" color={colors.textMuted}>
              {queued.length === 1
                ? '1 offline session waiting to sync'
                : `${queued.length} offline sessions waiting to sync`}
            </AppText>
            {queued.slice(0, 4).map((s) => (
              <View key={s.libraryItemId} style={styles.queuedRow}>
                <Icon name={icons.cloudQueue} size={15} color={colors.accent} />
                <AppText variant="meta" numberOfLines={1} style={{ flex: 1 }}>
                  {s.displayTitle}
                </AppText>
              </View>
            ))}
            {queued.length > 4 && (
              <AppText variant="caption" color={colors.textFaint}>
                and {queued.length - 4} more
              </AppText>
            )}
          </View>
        )}

        {feedback === 'ok' ? (
          <View style={[styles.result, { backgroundColor: colors.success + '1f' }]}>
            <Icon name={icons.checkCircle} size={18} color={colors.success} />
            <AppText variant="label" color={colors.success}>
              Saved to your server
            </AppText>
          </View>
        ) : feedback === 'fail' ? (
          <View style={[styles.result, { backgroundColor: colors.destructive + '1f' }]}>
            <Icon name={icons.error} size={18} color={colors.destructive} />
            <AppText variant="meta" color={colors.destructive} style={{ flex: 1 }}>
              Still couldn't reach your server. Your listening is kept safely and
              will sync on its own once you're back online.
            </AppText>
          </View>
        ) : null}

        <Touchable
          style={[styles.syncBtn, syncing && { opacity: 0.7 }]}
          disabled={syncing}
          onPress={onSync}
        >
          {syncing ? (
            <ActivityIndicator size="small" color={colors.onAccent} />
          ) : (
            <Icon
              name={feedback === 'ok' ? icons.checkCircle : retry ? icons.retry : icons.cloudSync}
              size={18}
              color={colors.onAccent}
            />
          )}
          <AppText variant="label" color={colors.onAccent}>
            {btnLabel}
          </AppText>
        </Touchable>
      </View>
    </Sheet>
  )
})

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    body: {
      alignItems: 'center',
      gap: spacing.md,
      paddingBottom: spacing.md,
    },
    badge: {
      width: 60,
      height: 60,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: spacing.xs,
    },
    metaRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    queued: {
      alignSelf: 'stretch',
      gap: spacing.xs,
      padding: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.fill,
    },
    queuedRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
    },
    result: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      alignSelf: 'stretch',
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      borderRadius: radius.card,
    },
    syncBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      alignSelf: 'stretch',
      marginTop: spacing.xs,
      paddingVertical: spacing.md + 2,
      borderRadius: radius.card,
      backgroundColor: colors.accent,
    },
  })
