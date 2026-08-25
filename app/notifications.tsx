import { useCallback, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { respondToClubInvite } from '@/api/clubs'
import {
  deleteAllNotifications,
  deleteNotification,
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type HSNotification,
} from '@/api/notifications'
import { releaseNotificationRoute } from '@/notifications/releaseRoute'
import { RatingPromptActions } from '@/notifications/RatingPromptActions'
import { RATING_NOTIFICATION_KIND, ratingSavedMessage } from '@hearthshelf/core'
import { setRating, skipRatingPrompt } from '@/api/ratings'
import { getSettingsState, setSetting } from '@/store/settings'
import { AppText, Centered, IconButton, Loading, Screen, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { Toast, useToast } from '@/ui/Toast'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

/** How long the "Rated 4 stars" confirmation stays before the row clears. Long
 *  enough to read, short enough that it never feels stuck. */
const RATING_DISMISS_MS = 900

/** Notification kinds that point at ONE comment, and so should open the club
 *  scrolled to it rather than at the top. */
const NOTE_ANCHORED_KINDS = new Set(['mention', 'reaction', 'reply', 'lateNote'])

function dataString(notification: HSNotification, key: string): string {
  const value = notification.data[key]
  return typeof value === 'string' ? value : ''
}

function relativeTime(timestamp: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000))
  if (minutes < 1) return 'Now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export default function NotificationsScreen() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { message, show } = useToast()
  const [notifications, setNotifications] = useState<HSNotification[] | null>(null)
  const [unread, setUnread] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await getNotifications()
    setNotifications(response.notifications)
    setUnread(response.unreadCount)
  }, [])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  const refresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const open = async (notification: HSNotification) => {
    if (!notification.readAt) await markNotificationRead(notification.id)
    const clubId = dataString(notification, 'clubId')
    const asin = dataString(notification, 'asin')
    if (notification.kind === 'release' && asin) {
      // "Now in your library" opens the owned book; the still-upcoming signals
      // open the upcoming page (see releaseNotificationRoute).
      router.push(await releaseNotificationRoute(asin, dataString(notification, 'signal')))
      return
    }
    // Anything anchored to a specific comment opens ON that comment: ?note=
    // scrolls the room to it and highlights it. Landing at the top of a busy
    // club and hunting for the line someone is talking about is the whole
    // problem these alerts exist to solve.
    if (NOTE_ANCHORED_KINDS.has(notification.kind) && clubId) {
      const noteId = dataString(notification, 'noteId')
      const q = noteId ? `?note=${encodeURIComponent(noteId)}` : ''
      router.push(`/club/${encodeURIComponent(clubId)}${q}`)
      return
    }
    if (notification.kind !== 'club_invite' && clubId) {
      router.push(`/club/${encodeURIComponent(clubId)}`)
    } else {
      await load()
    }
  }

  // Remove a row optimistically - a dismissal that has to wait for a round trip
  // feels broken on a list you are clearing. On failure we reload, which puts
  // the row back rather than leaving the UI claiming something is gone.
  const dismiss = async (notification: HSNotification) => {
    setNotifications((current) => (current ?? []).filter((n) => n.id !== notification.id))
    if (!notification.readAt) setUnread((n) => Math.max(0, n - 1))
    if (!(await deleteNotification(notification.id))) {
      show("Couldn't dismiss that notification")
      await load()
    }
  }

  const clearAll = async () => {
    const previous = notifications
    setNotifications([])
    setUnread(0)
    if (!(await deleteAllNotifications())) {
      setNotifications(previous)
      show("Couldn't clear your notifications")
      await load()
    }
  }

  const respond = async (notification: HSNotification, accept: boolean) => {
    const clubId = dataString(notification, 'clubId')
    const inviteId = dataString(notification, 'inviteId') || notification.entityId || ''
    if (!clubId || !inviteId || busyId) return
    setBusyId(notification.id)
    const ok = await respondToClubInvite(clubId, inviteId, accept)
    setBusyId(null)
    if (!ok) {
      show('That invitation is no longer available')
      await load()
      return
    }
    await load()
    if (accept) router.replace(`/club/${encodeURIComponent(clubId)}`)
  }

  // Save a rating from the tray, then clear the row: the question has been
  // answered, so leaving it behind would just be one more thing to dismiss. The
  // component shows a brief "Rated 4 stars" first, which is what makes the row
  // disappearing read as saved rather than lost.
  const rate = async (notification: HSNotification, value: number): Promise<boolean> => {
    const itemKey = dataString(notification, 'itemKey') || notification.entityId || ''
    if (!itemKey) return false
    try {
      await setRating(itemKey, value)
    } catch {
      // setRating throws rather than swallowing, precisely so the row can stay
      // put instead of claiming a score the server never stored.
      show("Couldn't save that rating")
      return false
    }
    show(ratingSavedMessage(value))
    // Let the confirmation land before the row goes.
    setTimeout(() => void dismiss(notification), RATING_DISMISS_MS)
    return true
  }

  // "Don't ask again": silence the whole category, then clear this row. Writing
  // the same notifyPrefs key the Notifications settings panel writes, so the
  // toggle there reflects it and it syncs across devices.
  const stopAskingForRatings = async (notification: HSNotification) => {
    const prefs = getSettingsState().notifyPrefs
    setSetting('notifyPrefs', {
      ...prefs,
      types: { ...prefs.types, rating: { ...prefs.types.rating, enabled: false } },
    })
    show('You won’t be asked to rate books')
    await dismiss(notification)
  }

  return (
    <Screen edges={['top', 'bottom']}>
      <View style={styles.header}>
        <IconButton
          name={icons.back}
          onPress={() => router.back()}
          style={styles.headerButton}
          accessibilityLabel="Back"
        />
        <View style={styles.headerTitle}>
          <AppText variant="title">Notifications</AppText>
          <AppText variant="caption" color={colors.textMuted}>
            {unread > 0 ? `${unread} unread` : 'You’re all caught up'}
          </AppText>
        </View>
        {unread > 0 ? (
          <Touchable
            style={styles.markAll}
            onPress={async () => {
              await markAllNotificationsRead()
              await load()
            }}
            accessibilityRole="button"
            accessibilityLabel="Mark all notifications read"
          >
            <AppText variant="caption" color={colors.accent}>
              Mark all read
            </AppText>
          </Touchable>
        ) : notifications && notifications.length > 0 ? (
          <Touchable
            style={styles.markAll}
            onPress={() => void clearAll()}
            accessibilityRole="button"
            accessibilityLabel="Clear all notifications"
          >
            <AppText variant="caption" color={colors.accent}>
              Clear all
            </AppText>
          </Touchable>
        ) : null}
      </View>

      {notifications === null ? (
        <Loading />
      ) : notifications.length === 0 ? (
        <Centered>
          <Icon name={icons.bell} size={38} color={colors.textMuted} />
          <AppText variant="title" style={{ marginTop: spacing.md }}>
            Nothing new
          </AppText>
          <AppText variant="meta" color={colors.textMuted} style={styles.emptyText}>
            Invitations, club updates, and release alerts will appear here.
          </AppText>
        </Centered>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />
          }
        >
          {notifications.map((notification) => {
            const pending =
              notification.kind === 'club_invite' && notification.actionStatus === 'pending'
            // A rating prompt is answered in place, so tapping the row must not
            // navigate away mid-answer - it only marks the row read.
            const isRating = notification.kind === RATING_NOTIFICATION_KIND
            return (
              <Touchable
                key={notification.id}
                style={[styles.row, !notification.readAt && styles.unread]}
                onPress={() => {
                  if (isRating) {
                    if (!notification.readAt) void markNotificationRead(notification.id)
                    return
                  }
                  void open(notification)
                }}
                accessibilityRole="button"
                accessibilityLabel={`${notification.title}. ${notification.body}`}
              >
                <View style={styles.kind}>
                  <Icon
                    name={
                      notification.kind === RATING_NOTIFICATION_KIND
                        ? icons.star
                        : notification.kind === 'club_invite' ||
                            notification.kind === 'club_advance'
                          ? icons.people
                          : notification.kind === 'release'
                            ? icons.newRelease
                            : notification.kind === 'mention'
                              ? icons.mention
                              : notification.kind === 'reaction'
                                ? icons.thumbUp
                                : notification.kind === 'reply' || notification.kind === 'lateNote'
                                  ? icons.chat
                                  : icons.bell
                    }
                    size={21}
                    color={colors.accent}
                  />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={styles.titleRow}>
                    <AppText variant="label" numberOfLines={2} style={{ flex: 1 }}>
                      {notification.title}
                    </AppText>
                    <AppText variant="caption" color={colors.textMuted}>
                      {relativeTime(notification.createdAt)}
                    </AppText>
                  </View>
                  {notification.body ? (
                    <AppText variant="meta" color={colors.textMuted} style={styles.body}>
                      {notification.body}
                    </AppText>
                  ) : null}
                  {isRating ? (
                    <RatingPromptActions
                      bookTitle={dataString(notification, 'title') || 'this book'}
                      onRate={(value) => rate(notification, value)}
                      onSkip={() => {
                        // Record the skip BEFORE clearing the row: the row is
                        // what the prompt job dedupes against, so dismissing
                        // alone would let the next hourly pass re-ask.
                        const itemKey =
                          dataString(notification, 'itemKey') || notification.entityId || ''
                        if (itemKey) void skipRatingPrompt(itemKey)
                        void dismiss(notification)
                      }}
                      onStopAsking={() => void stopAskingForRatings(notification)}
                    />
                  ) : pending ? (
                    <View style={styles.actions}>
                      <Touchable
                        style={styles.accept}
                        disabled={busyId !== null}
                        onPress={() => void respond(notification, true)}
                        accessibilityRole="button"
                        accessibilityLabel={`Accept ${notification.title}`}
                      >
                        <AppText variant="label" color={colors.onAccent}>
                          Accept
                        </AppText>
                      </Touchable>
                      <Touchable
                        style={styles.decline}
                        disabled={busyId !== null}
                        onPress={() => void respond(notification, false)}
                        accessibilityRole="button"
                        accessibilityLabel={`Decline ${notification.title}`}
                      >
                        <AppText variant="label">Decline</AppText>
                      </Touchable>
                    </View>
                  ) : notification.kind === 'club_invite' ? (
                    <AppText variant="caption" color={colors.textMuted} style={styles.status}>
                      {notification.actionStatus === 'accepted'
                        ? 'Joined'
                        : notification.actionStatus === 'declined'
                          ? 'Declined'
                          : 'No longer available'}
                    </AppText>
                  ) : null}
                </View>
                {/* A button rather than swipe-to-dismiss: invite rows already
                    carry Accept/Decline, and a horizontal swipe over them is
                    ambiguous about which action it means. */}
                <Touchable
                  style={styles.dismiss}
                  onPress={() => void dismiss(notification)}
                  accessibilityRole="button"
                  accessibilityLabel={`Dismiss ${notification.title}`}
                  hitSlop={8}
                >
                  <Icon name={icons.close} size={16} color={colors.textMuted} />
                </Touchable>
              </Touchable>
            )
          })}
        </ScrollView>
      )}
      <Toast message={message} />
    </Screen>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    dismiss: {
      paddingLeft: spacing.sm,
      alignSelf: 'flex-start',
    },
    header: {
      minHeight: 64,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    headerButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.fill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerTitle: { flex: 1, minWidth: 0 },
    markAll: {
      minHeight: 44,
      justifyContent: 'center',
      paddingHorizontal: spacing.sm,
    },
    list: { padding: spacing.lg, gap: spacing.sm, paddingBottom: spacing.xxl },
    row: {
      minHeight: 92,
      flexDirection: 'row',
      gap: spacing.md,
      padding: spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: radius.card,
      backgroundColor: colors.card,
    },
    unread: { backgroundColor: colors.accentWash, borderColor: colors.accent },
    kind: {
      width: 42,
      height: 42,
      borderRadius: 13,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.fill,
    },
    titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    body: { marginTop: spacing.xs, lineHeight: 20 },
    actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
    accept: {
      minHeight: 44,
      minWidth: 92,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      backgroundColor: colors.accent,
    },
    decline: {
      minHeight: 44,
      minWidth: 92,
      borderRadius: 22,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      borderWidth: 1,
      borderColor: colors.border,
    },
    status: { marginTop: spacing.sm, fontWeight: '700' },
    emptyText: { maxWidth: 260, marginTop: spacing.xs, textAlign: 'center' },
  })
