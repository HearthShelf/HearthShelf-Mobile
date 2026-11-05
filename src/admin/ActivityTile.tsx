/** One number with a caption, for the admin home and Stats. */
import { Pressable, StyleSheet, View } from 'react-native'
import { Icon, type IconName } from '@/ui/icons'
import { AppText } from '@/ui/primitives'
import { Skeleton } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { radius, spacing } from '@/ui/theme'

const NO_VALUE = '-'

export function ActivityTileGrid({ children }: { children: React.ReactNode }) {
  return <View style={styles.grid}>{children}</View>
}

export function ActivityTile({
  icon,
  label,
  value,
  loading = false,
  alert = false,
  onPress,
}: {
  icon: IconName
  label: string
  /** null shows a dash: the value could not be loaded. */
  value: string | null
  loading?: boolean
  /** Marks a value that needs attention. */
  alert?: boolean
  onPress?: () => void
}) {
  const colors = useColors()
  const accent = alert ? colors.destructive : colors.textMuted
  const content = (
    <View style={[styles.tile, { backgroundColor: colors.high, borderColor: colors.hairline }]}>
      <Icon name={icon} size={20} color={accent} />
      {loading ? (
        <Skeleton width="60%" height={22} />
      ) : (
        <AppText variant="hero" numberOfLines={1} color={alert ? colors.destructive : undefined}>
          {value ?? NO_VALUE}
        </AppText>
      )}
      <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
        {label}
      </AppText>
    </View>
  )
  if (!onPress) return <View style={styles.cell}>{content}</View>
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${loading ? 'loading' : (value ?? 'not available')}`}
      style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
    >
      {content}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  // Two across. flexGrow lets an odd last tile take the whole row.
  cell: { flexBasis: '47%', flexGrow: 1 },
  tile: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pressed: { opacity: 0.8 },
})
