/**
 * Persistent strip shown while the app runs in offline mode (couldn't reach the
 * server on launch, but downloaded books are playable). Tapping it re-runs the
 * connect. Pinned under the status bar, above all content, non-blocking except
 * for its own pill.
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
    <View style={[styles.wrap, { top: insets.top + spacing.xs }]} pointerEvents="box-none">
      <Pressable style={styles.pill} onPress={onRetry} accessibilityRole="button">
        <Icon name={icons.cloudOff} size={16} color={colors.textMuted} />
        <AppText variant="caption" color={colors.text} numberOfLines={1} style={styles.label}>
          Offline - downloaded books only
        </AppText>
        <View style={styles.retry}>
          <Icon name={icons.retry} size={15} color={colors.accent} />
          <AppText variant="caption" color={colors.accent}>
            Retry
          </AppText>
        </View>
      </Pressable>
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    wrap: {
      position: 'absolute',
      left: spacing.lg,
      right: spacing.lg,
      alignItems: 'center',
      zIndex: 50,
    },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      borderRadius: radius.card,
      backgroundColor: colors.sheet,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
    label: { flexShrink: 1 },
    retry: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs / 2 },
  })
