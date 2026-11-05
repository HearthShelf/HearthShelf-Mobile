/** Shown above a form that sends a password or token, when the connection to the
 *  server is plain http (a LAN address). Renders nothing over https. */
import { View } from 'react-native'
import { getSession } from '@/api/session'
import { Icon, icons } from '@/ui/icons'
import { AppText } from '@/ui/primitives'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

export function HttpWarning() {
  const colors = useColors()
  if (!getSession()?.serverUrl.startsWith('http://')) return null
  return (
    <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
      <Icon name={icons.error} size={16} color={colors.destructive} />
      <AppText variant="meta" color={colors.textMuted} style={{ flex: 1 }}>
        This connection isn't encrypted. Anyone on this network could read what you send.
      </AppText>
    </View>
  )
}
