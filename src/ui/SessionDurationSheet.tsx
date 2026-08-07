/**
 * Correct a listening session's recorded duration - the fix for a session that
 * banked hours you slept through but do not want to delete outright.
 *
 * Duration is the ONLY field worth editing: ABS has no session PATCH, so the
 * update re-submits the session through the local-session ingest keeping its id,
 * and that path honours only `timeListening` (and the day, re-derived from
 * `updatedAt`). Offering anything else would silently do nothing.
 *
 * Hours/minutes rather than a raw seconds box, because the real correction is
 * always "it was about 40 minutes, not six hours".
 */
import { forwardRef, useEffect, useState } from 'react'
import { StyleSheet, TextInput, View } from 'react-native'
import type { BottomSheetModal } from '@gorhom/bottom-sheet'
import { formatTimestamp } from '@hearthshelf/core'
import type { SessionRow } from '@/api/abs'
import { AppText, PrimaryButton, Sheet } from '@/ui/primitives'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export const SessionDurationSheet = forwardRef<
  BottomSheetModal,
  {
    row: SessionRow | null
    onSave: (row: SessionRow, seconds: number) => void
    onDismiss?: () => void
  }
>(function SessionDurationSheet({ row, onSave, onDismiss }, ref) {
  const colors = useColors()
  const s = makeStyles(colors)
  const [h, setH] = useState('0')
  const [m, setM] = useState('0')

  // Re-seed whenever a different session is opened.
  useEffect(() => {
    if (!row) return
    setH(String(Math.floor(row.seconds / 3600)))
    setM(String(Math.round((row.seconds % 3600) / 60)))
  }, [row])

  const parsed = clamp(h) * 3600 + clamp(m) * 60
  // A session longer than the book is always a mistake, but 0 is meaningful
  // ("I did not listen to any of this"), so only the upper bound is enforced.
  const max = row?.duration && row.duration > 0 ? Math.ceil(row.duration) : null
  const tooLong = max != null && parsed > max
  const valid = !tooLong

  return (
    <Sheet ref={ref} kicker="Correct duration" title={row?.title ?? ''} onDismiss={onDismiss}>
      <View style={s.body}>
        <AppText variant="meta" color={colors.textMuted}>
          {row
            ? `Recorded as ${formatTimestamp(row.seconds)}. Set what you actually listened to.`
            : ''}
        </AppText>

        <View style={s.fields}>
          <Field label="Hours" value={h} onChange={setH} />
          <Field label="Minutes" value={m} onChange={setM} />
        </View>

        <View style={s.preview}>
          <AppText variant="label" color={tooLong ? colors.destructive : colors.textMuted}>
            {tooLong && max != null
              ? `Longer than the book itself (${formatTimestamp(max)})`
              : `New duration: ${formatTimestamp(parsed)}`}
          </AppText>
        </View>

        <PrimaryButton
          label="Save"
          icon="check"
          onPress={valid && row ? () => onSave(row, parsed) : undefined}
          style={!valid ? s.disabled : undefined}
        />
      </View>
    </Sheet>
  )
})

function Field({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  const colors = useColors()
  const s = makeStyles(colors)
  return (
    <View style={s.field}>
      <AppText variant="caption" color={colors.textFaint}>
        {label}
      </AppText>
      <TextInput
        value={value}
        onChangeText={(t) => onChange(t.replace(/[^0-9]/g, ''))}
        keyboardType="number-pad"
        selectTextOnFocus
        style={s.input}
        placeholderTextColor={colors.textFaint}
      />
    </View>
  )
}

function clamp(raw: string): number {
  const n = Number.parseInt(raw || '0', 10)
  return Number.isNaN(n) || n < 0 ? 0 : n
}

function makeStyles(c: Palette) {
  return StyleSheet.create({
    body: { gap: spacing.lg, padding: spacing.lg },
    fields: { flexDirection: 'row', gap: spacing.md },
    field: { flex: 1, gap: spacing.xs },
    input: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      borderRadius: radius.row,
      borderWidth: 1,
      borderColor: c.border,
      color: c.text,
      fontSize: 20,
      textAlign: 'center',
    },
    preview: { alignItems: 'center' },
    disabled: { opacity: 0.45 },
  })
}
