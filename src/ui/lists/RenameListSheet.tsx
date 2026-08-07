/**
 * Rename a list. Shared by both kinds - the only thing that varies is the noun.
 *
 * A sheet rather than Alert.prompt because that is iOS-only; this is the same
 * shape as SessionDurationSheet so the two read alike.
 */
import { forwardRef, useEffect, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import type { BottomSheetModal } from '@gorhom/bottom-sheet'
import type { ListKind } from '@/ui/lists/kind'
import { AppText, PrimaryButton, Sheet } from '@/ui/primitives'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export const RenameListSheet = forwardRef<
  BottomSheetModal,
  {
    kind: ListKind
    currentName: string
    onSave: (name: string) => void
  }
>(function RenameListSheet({ kind, currentName, onSave }, ref) {
  const colors = useColors()
  const s = makeStyles(colors)
  const [draft, setDraft] = useState(currentName)

  useEffect(() => {
    setDraft(currentName)
  }, [currentName])

  const trimmed = draft.trim()
  // ABS strips tags and ignores an empty name, so an empty box would silently
  // do nothing - block it here instead.
  const valid = trimmed.length > 0 && trimmed !== currentName

  return (
    <Sheet ref={ref} kicker={kind === 'collection' ? 'Collection' : 'Playlist'} title="Rename">
      <View style={s.body}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={kind === 'collection' ? 'Collection name' : 'Playlist name'}
          placeholderTextColor={colors.textFaint}
          style={s.input}
          autoFocus
          selectTextOnFocus
          returnKeyType="done"
          onSubmitEditing={() => {
            if (valid) onSave(trimmed)
          }}
        />
        <PrimaryButton
          label="Save"
          icon="check"
          onPress={valid ? () => onSave(trimmed) : undefined}
          style={!valid ? s.disabled : undefined}
        />
      </View>
    </Sheet>
  )
})

function makeStyles(c: Palette) {
  return StyleSheet.create({
    body: { gap: spacing.lg, padding: spacing.lg },
    input: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      borderRadius: radius.row,
      borderWidth: 1,
      borderColor: c.border,
      color: c.text,
      fontSize: 17,
    },
    disabled: { opacity: 0.45 },
  })
}
