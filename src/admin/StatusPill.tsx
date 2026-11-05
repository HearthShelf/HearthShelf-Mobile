/** A small state label for admin rows and cards. */
import { View } from 'react-native'
import { AppText } from '@/ui/primitives'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

export type StatusTone = 'neutral' | 'good' | 'bad'

export function StatusPill({ label, tone = 'neutral' }: { label: string; tone?: StatusTone }) {
  const colors = useColors()
  const color =
    tone === 'good' ? colors.success : tone === 'bad' ? colors.destructive : colors.textMuted
  return (
    <View
      style={{
        paddingHorizontal: spacing.sm,
        paddingVertical: 3,
        borderRadius: 999,
        backgroundColor: colors.fill,
      }}
    >
      <AppText variant="caption" color={color}>
        {label}
      </AppText>
    </View>
  )
}
