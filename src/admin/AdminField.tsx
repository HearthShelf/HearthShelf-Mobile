/** Labelled text input for admin forms. `inSheet` is required inside a bottom sheet,
 *  so the keyboard moves the sheet instead of covering the field. */
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native'
import { BottomSheetTextInput } from '@gorhom/bottom-sheet'
import { AppText } from '@/ui/primitives'
import { useColors } from '@/ui/ThemeProvider'
import { fonts, radius, spacing } from '@/ui/theme'

export function AdminField({
  label,
  hint,
  error,
  inSheet = false,
  ...input
}: {
  label: string
  hint?: string
  /** Replaces the hint, in the destructive colour. */
  error?: string
  inSheet?: boolean
} & TextInputProps) {
  const colors = useColors()
  const Input = inSheet ? BottomSheetTextInput : TextInput
  return (
    <View style={{ gap: spacing.xs }}>
      <AppText variant="label">{label}</AppText>
      <Input
        autoCapitalize="none"
        autoCorrect={false}
        placeholderTextColor={colors.textFaint}
        accessibilityLabel={label}
        {...input}
        style={[
          styles.input,
          {
            color: colors.text,
            backgroundColor: colors.fill,
            borderColor: error ? colors.destructive : colors.border,
            opacity: input.editable === false ? 0.6 : 1,
          },
        ]}
      />
      {error || hint ? (
        <AppText variant="meta" color={error ? colors.destructive : colors.textMuted}>
          {error ?? hint}
        </AppText>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  input: {
    fontFamily: fonts.sans,
    fontSize: 16,
    padding: spacing.md,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
})
