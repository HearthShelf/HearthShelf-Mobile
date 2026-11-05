/** One record in an admin list. Stands in for a table row from the web panel. */
import { View } from 'react-native'
import { AppText, Card } from '@/ui/primitives'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'
import { StatusPill, type StatusTone } from './StatusPill'

export function AdminCard({
  title,
  subtitle,
  status,
  statusTone,
  onPress,
  children,
}: {
  title: string
  subtitle?: string
  status?: string
  statusTone?: StatusTone
  onPress?: () => void
  children?: React.ReactNode
}) {
  const colors = useColors()
  return (
    <Card onPress={onPress}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <View style={{ flex: 1 }}>
          <AppText variant="body" numberOfLines={1}>
            {title}
          </AppText>
          {subtitle ? (
            <AppText variant="meta" color={colors.textMuted} numberOfLines={2}>
              {subtitle}
            </AppText>
          ) : null}
        </View>
        {status ? <StatusPill label={status} tone={statusTone} /> : null}
      </View>
      {children}
    </Card>
  )
}
