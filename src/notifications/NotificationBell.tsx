import { useCallback, useState } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { getNotifications } from '@/api/notifications'
import { AppText, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { useColors } from '@/ui/ThemeProvider'

const POLL_MS = 30_000

/**
 * Bell that opens the notifications inbox.
 *
 * Two looks: the default filled 44px circle for screen headers (Home), and a
 * `compact` plain glyph sized to sit among the player header's other 22px
 * icons. Compact also only appears while something is UNREAD - the player
 * header has no room to spare, and Home always carries the route back to the
 * inbox for re-reading.
 */
export function NotificationBell({
  style,
  compact = false,
}: {
  style?: StyleProp<ViewStyle>
  compact?: boolean
}) {
  const router = useRouter()
  const colors = useColors()
  const [unread, setUnread] = useState(0)
  // Total rows, not just unread: the bell hides when the inbox is EMPTY, but
  // must stay put once there is anything to go back and re-read. Hiding on
  // `unread` alone would make it vanish the instant you read a notification,
  // taking the only route to the inbox with it.
  const [total, setTotal] = useState(0)

  useFocusEffect(
    useCallback(() => {
      let active = true
      const refresh = async () => {
        const response = await getNotifications()
        if (!active) return
        setUnread(response.unreadCount)
        setTotal(response.notifications.length)
      }
      void refresh()
      const timer = setInterval(() => void refresh(), POLL_MS)
      return () => {
        active = false
        clearInterval(timer)
      }
    }, []),
  )

  if (compact ? unread === 0 : total === 0) return null

  return (
    <Touchable
      style={[
        compact ? styles.compactButton : [styles.button, { backgroundColor: colors.fill }],
        style,
      ]}
      onPress={() => router.push('/notifications')}
      accessibilityRole="button"
      accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      hitSlop={compact ? 10 : 4}
    >
      <Icon
        name={unread > 0 ? icons.bellActive : icons.bell}
        size={compact ? 22 : 20}
        color={unread > 0 ? colors.accent : colors.text}
      />
      {unread > 0 ? (
        <View style={[styles.badge, { backgroundColor: colors.accent }]}>
          <AppText variant="caption" color={colors.onAccent} style={styles.badgeText}>
            {unread > 99 ? '99+' : unread}
          </AppText>
        </View>
      ) : null}
    </Touchable>
  )
}

const styles = StyleSheet.create({
  button: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compactButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -3,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: 9,
    lineHeight: 12,
    fontWeight: '800',
  },
})
