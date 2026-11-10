/**
 * Offline status bar, seated under the OS status bar while the app runs offline
 * (couldn't reach the server on launch, but downloaded books are playable), or
 * while a working connection has dropped mid-session. A full-width bar - not a
 * floating pill - so it reads as chrome: cloud icon + one line + an explicit
 * bordered button (D-CONSIST: one obvious control per action).
 *
 * `backOnline`: the user chose offline mode and the server has since answered.
 * The app keeps their choice, so the bar only offers the way back: the line
 * says so and the whole bar reconnects on tap.
 */
import { Pressable, StyleSheet, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AppText } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export function OfflineBanner({
  onRetry,
  reason,
  backOnline = false,
}: {
  onRetry: () => void
  reason?: string
  backOnline?: boolean
}) {
  const colors = useColors()
  const insets = useSafeAreaInsets()
  const styles = makeStyles(colors)
  // Say WHY when we know it ("Server isn't answering on that address") rather
  // than the generic line - the difference between the user fixing a typo
  // themselves and assuming the app is broken. Falls back when unclassified.
  const label = backOnline
    ? 'Back online - tap to reconnect'
    : (reason ?? 'Offline - downloaded books only')

  return (
    <View style={[styles.bar, { paddingTop: insets.top + spacing.xs }]} pointerEvents="box-none">
      <Pressable
        style={styles.labelRow}
        onPress={backOnline ? onRetry : undefined}
        disabled={!backOnline}
        accessibilityRole={backOnline ? 'button' : undefined}
      >
        <Icon
          name={backOnline ? icons.cloudDone : icons.cloudOff}
          size={16}
          color={backOnline ? colors.accent : colors.brandHearth}
        />
        <AppText variant="caption" color={colors.text} numberOfLines={2} style={styles.label}>
          {label}
        </AppText>
      </Pressable>
      <Pressable style={styles.retryBtn} onPress={onRetry} accessibilityRole="button" hitSlop={6}>
        <Icon name={icons.retry} size={14} color={colors.accent} />
        <AppText variant="caption" color={colors.accent}>
          {backOnline ? 'Reconnect' : 'Retry'}
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
    labelRow: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    label: { flex: 1 },
    // An explicit bordered button, and it looks it.
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
