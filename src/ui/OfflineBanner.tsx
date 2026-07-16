/**
 * Offline status bar, seated under the OS status bar while the app runs offline
 * (couldn't reach the server on launch, but downloaded books are playable). A
 * full-width bar - not a floating pill - so it reads as chrome: cloud-off icon +
 * "Offline - downloaded books only" + an explicit bordered Retry button. Only the
 * button is tappable (D-CONSIST: one obvious control per action).
 */
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppText } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const styles = makeStyles(colors)

  return (
    <View
      style={[styles.bar, { paddingTop: insets.top + spacing.xs }]}
      pointerEvents="box-none"
    >
      <Icon name={icons.cloudOff} size={16} color={colors.brandHearth} />
      <AppText variant="caption" color={colors.text} numberOfLines={1} style={styles.label}>
        Offline - downloaded books only
      </AppText>
      <Pressable style={styles.retryBtn} onPress={onRetry} accessibilityRole="button" hitSlop={6}>
        <Icon name={icons.retry} size={14} color={colors.accent} />
        <AppText variant="caption" color={colors.accent}>
          Retry
        </AppText>
      </Pressable>
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    bar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
      backgroundColor: colors.sheet,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      zIndex: 50,
    },
    label: { flex: 1 },
    // An explicit bordered button - only this is tappable, and it looks it.
    retryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accent,
      backgroundColor: colors.accentWash,
    },
  })
