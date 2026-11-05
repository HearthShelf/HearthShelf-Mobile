/** One person in the Users list. Long-press starts multi-select. */
import { Pressable, StyleSheet, View } from 'react-native'
import { fmtSessDate, type ABSAdminUser } from '@hearthshelf/core'
import { StatusPill } from '@/admin/StatusPill'
import { avatarUrl } from '@/api/abs'
import { Icon } from '@/ui/icons'
import { AppText, Avatar } from '@/ui/primitives'
import { useColors } from '@/ui/ThemeProvider'
import { radius, spacing } from '@/ui/theme'

export function UserCard({
  user,
  online,
  lastSeen,
  selecting,
  selected,
  onPress,
  onLongPress,
}: {
  user: ABSAdminUser
  online: boolean
  /** Newest known activity in epoch ms. 0 when there is none. */
  lastSeen: number
  selecting: boolean
  selected: boolean
  onPress: () => void
  onLongPress: () => void
}) {
  const colors = useColors()
  const seen = online ? 'Now' : lastSeen > 0 ? fmtSessDate(lastSeen).day : 'Never'
  const status = !user.isActive ? 'Disabled' : online ? 'Online' : 'Offline'
  const tone = !user.isActive ? 'bad' : online ? 'good' : 'neutral'
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      accessibilityState={selecting ? { checked: selected } : undefined}
      accessibilityLabel={`${user.username}, ${user.type}, ${status}`}
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: selected ? colors.fillStrong : colors.fill,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      {selecting ? (
        <Icon
          name={selected ? 'check-box' : 'check-box-outline-blank'}
          size={22}
          color={selected ? colors.accent : colors.textMuted}
        />
      ) : null}
      <Avatar uri={avatarUrl(user.id) || undefined} size={40} name={user.username} />
      <View style={{ flex: 1 }}>
        <AppText variant="body" numberOfLines={1}>
          {user.username}
        </AppText>
        <AppText variant="meta" color={colors.textMuted} numberOfLines={1}>
          {user.type} · Last seen {seen}
        </AppText>
      </View>
      <StatusPill label={status} tone={tone} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.row,
  },
})
