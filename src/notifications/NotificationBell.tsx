import { useCallback, useState } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { getNotifications } from '@/api/notifications'
import { AppText, Touchable } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { useColors } from '@/ui/ThemeProvider'

const POLL_MS = 30_000

export function NotificationBell({ style }: { style?: StyleProp<ViewStyle> }) {
  const router = useRouter()
  const colors = useColors()
  const [unread, setUnread] = useState(0)

  useFocusEffect(
    useCallback(() => {
      let active = true
      const refresh = async () => {
        const response = await getNotifications()
        if (active) setUnread(response.unreadCount)
      }
      void refresh()
      const timer = setInterval(() => void refresh(), POLL_MS)
      return () => {
        active = false
        clearInterval(timer)
      }
    }, []),
  )

  return (
    <Touchable
      style={[styles.button, { backgroundColor: colors.fill }, style]}
      onPress={() => router.push('/notifications')}
      accessibilityRole="button"
      accessibilityLabel={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      hitSlop={4}
    >
      <Icon
        name={unread > 0 ? icons.bellActive : icons.bell}
        size={20}
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
