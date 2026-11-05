/**
 * The confirmation for severe actions, such as deleting a library or restoring a
 * backup. The admin has to type the target's name, so a stray tap can't do it.
 * Lighter risks use confirm() from src/ui/confirm.ts.
 *
 * Forward a ref and call `ref.current?.present()` to open it.
 */
import { forwardRef, useRef, useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { BottomSheetTextInput } from '@gorhom/bottom-sheet'
import { AppText, Sheet, type SheetRef } from '@/ui/primitives'
import { useColors } from '@/ui/ThemeProvider'
import { fonts, radius, spacing } from '@/ui/theme'
import { haptics } from '@/ui/haptics'

export const TypedConfirm = forwardRef<
  SheetRef,
  {
    title: string
    /** What will happen. Name the thing and what is lost. */
    message: string
    /** The exact text to type: the target's name, or a count for bulk actions. */
    confirmText: string
    confirmLabel: string
    onConfirm: () => void
    /** Runs when the sheet closes without confirming. */
    onCancel?: () => void
  }
>(function TypedConfirm({ title, message, confirmText, confirmLabel, onConfirm, onCancel }, ref) {
  const colors = useColors()
  const [typed, setTyped] = useState('')
  const confirmed = useRef(false)
  const matches = typed.trim() === confirmText.trim()

  function submit() {
    if (!matches) return
    haptics.warn()
    confirmed.current = true
    setTyped('')
    if (ref && 'current' in ref) ref.current?.dismiss()
    onConfirm()
  }

  return (
    <Sheet
      ref={ref}
      title={title}
      onDismiss={() => {
        setTyped('')
        if (!confirmed.current) onCancel?.()
        confirmed.current = false
      }}
    >
      <View style={{ gap: spacing.md }}>
        <AppText variant="meta" color={colors.textMuted}>
          {message}
        </AppText>
        <AppText variant="meta">Type {confirmText} to continue.</AppText>
        <BottomSheetTextInput
          value={typed}
          onChangeText={setTyped}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={`Type ${confirmText} to continue`}
          style={[
            styles.input,
            { color: colors.text, backgroundColor: colors.fill, borderColor: colors.border },
          ]}
        />
        <Pressable
          onPress={submit}
          disabled={!matches}
          accessibilityRole="button"
          accessibilityState={{ disabled: !matches }}
          style={[
            styles.button,
            { backgroundColor: matches ? colors.destructive : colors.fillStrong },
          ]}
        >
          <AppText variant="label" color={matches ? colors.onAccent : colors.textMuted}>
            {confirmLabel}
          </AppText>
        </Pressable>
      </View>
    </Sheet>
  )
})

const styles = StyleSheet.create({
  input: {
    fontFamily: fonts.sans,
    fontSize: 16,
    padding: spacing.md,
    borderRadius: radius.row,
    borderWidth: StyleSheet.hairlineWidth,
  },
  button: {
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.row,
  },
})
