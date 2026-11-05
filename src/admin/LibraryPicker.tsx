/** Choosing one value from a list: a settings row that opens a sheet of choices. */
import { useRef } from 'react'
import { Dimensions, Pressable, View } from 'react-native'
import { BottomSheetScrollView } from '@gorhom/bottom-sheet'
import { Icon, icons } from '@/ui/icons'
import { AppText, Sheet, type SheetRef } from '@/ui/primitives'
import { SettingsRow } from '@/ui/settingsControls'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

export interface LibraryOption {
  value: string
  label: string
}

/** Keeps a value the server has but this list doesn't, so opening a picker can
 *  never quietly change it. */
export function withCurrentOption(options: LibraryOption[], value: string): LibraryOption[] {
  return options.some((o) => o.value === value) ? options : [{ value, label: value }, ...options]
}

export function LibraryChoiceRow({
  label,
  selected,
  onPress,
}: {
  label: string
  selected: boolean
  onPress: () => void
}) {
  const colors = useColors()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          minHeight: 48,
          gap: spacing.sm,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.sm,
        },
        pressed && { opacity: 0.7 },
      ]}
    >
      <AppText variant="body" style={{ flex: 1 }}>
        {label}
      </AppText>
      {selected ? <Icon name={icons.check} size={20} color={colors.accent} /> : null}
    </Pressable>
  )
}

export function LibraryPicker({
  title,
  value,
  options,
  onChange,
  last,
}: {
  title: string
  value: string
  options: LibraryOption[]
  onChange: (value: string) => void
  last?: boolean
}) {
  const sheet = useRef<SheetRef>(null)
  const height = Dimensions.get('window').height
  return (
    <>
      <SettingsRow
        title={title}
        desc={options.find((o) => o.value === value)?.label ?? value}
        onPress={() => sheet.current?.present()}
        last={last}
      />
      <Sheet ref={sheet} title={title} maxDynamicContentSize={height * 0.8}>
        <BottomSheetScrollView style={{ maxHeight: height * 0.65 }}>
          <View>
            {options.map((option) => (
              <LibraryChoiceRow
                key={option.value}
                label={option.label}
                selected={option.value === value}
                onPress={() => {
                  onChange(option.value)
                  sheet.current?.dismiss()
                }}
              />
            ))}
          </View>
        </BottomSheetScrollView>
      </Sheet>
    </>
  )
}
