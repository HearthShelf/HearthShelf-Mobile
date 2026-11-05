/** Action button for admin forms and cards. `danger` is for actions already behind
 *  a confirm; it does not confirm anything itself. */
import { ActivityIndicator, Pressable, StyleSheet } from 'react-native'
import { Icon, type IconName } from '@/ui/icons'
import { AppText } from '@/ui/primitives'
import { useColors } from '@/ui/ThemeProvider'
import { radius, spacing } from '@/ui/theme'

export function AdminButton({
  label,
  onPress,
  icon,
  kind = 'primary',
  disabled = false,
  busy = false,
}: {
  label: string
  onPress: () => void
  icon?: IconName
  kind?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  /** Shows a spinner and blocks taps while the action runs. */
  busy?: boolean
}) {
  const colors = useColors()
  const off = disabled || busy
  const background = off
    ? colors.fill
    : kind === 'primary'
      ? colors.accent
      : kind === 'danger'
        ? colors.destructive
        : colors.fillStrong
  const foreground = off ? colors.textMuted : kind === 'secondary' ? colors.text : colors.onAccent
  return (
    <Pressable
      onPress={onPress}
      disabled={off}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: off, busy }}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: background },
        pressed && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator size="small" color={foreground} />
      ) : icon ? (
        <Icon name={icon} size={18} color={foreground} />
      ) : null}
      <AppText variant="label" color={foreground}>
        {label}
      </AppText>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.row,
  },
  pressed: { opacity: 0.8 },
})
