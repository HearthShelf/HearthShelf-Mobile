import { useCallback, useMemo, useState } from 'react'
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { respondToClubInvite } from '@/api/clubs'
import {
  getNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type HSNotification,
} from '@/api/notifications'
import { releaseNotificationRoute } from '@/notifications/releaseRoute'
import { AppText, Centered, IconButton, Loading, Screen, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { Toast, useToast } from '@/ui/Toast'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

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
    if (notification.kind !== 'club_invite' && clubId) {
      router.push(`/club/${encodeURIComponent(clubId)}`)
    } else {
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
            return (
              <Touchable
                key={notification.id}
                style={[styles.row, !notification.readAt && styles.unread]}
                onPress={() => void open(notification)}
                accessibilityRole="button"
                accessibilityLabel={`${notification.title}. ${notification.body}`}
              >
                <View style={styles.kind}>
                  <Icon
                    name={
                      notification.kind === 'club_invite'
                        ? icons.people
                        : notification.kind === 'release'
                          ? icons.newRelease
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
                  {pending ? (
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
