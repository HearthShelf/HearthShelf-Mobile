/** Shows a token or password the server will only hand over once. */
import { Pressable, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Icon } from '@/ui/icons'
import { AppText } from '@/ui/primitives'
import { showToast } from '@/ui/Toast'
import { useColors } from '@/ui/ThemeProvider'
import { radius, spacing } from '@/ui/theme'

export function SecretReveal({ value, label = 'Copy' }: { value: string; label?: string }) {
  const colors = useColors()

  async function copy() {
    await Clipboard.setStringAsync(value)
    showToast('Copied')
  }

  return (
    <View style={{ gap: spacing.sm }}>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          padding: spacing.md,
          borderRadius: radius.row,
          backgroundColor: colors.fill,
        }}
      >
        <AppText variant="mono" style={{ flex: 1 }}>
          {value}
        </AppText>
        <Pressable onPress={() => void copy()} hitSlop={8} accessibilityLabel={label}>
          <Icon name="content-copy" size={20} color={colors.textMuted} />
        </Pressable>
      </View>
      <AppText variant="meta" color={colors.textMuted}>
        Save this now. You won't be able to see it again.
      </AppText>
    </View>
  )
}
