/** Schedule and retention for one backup system. Fields pinned by the server's
 *  environment show their value but can't be edited here. */
import { useEffect, useRef, useState } from 'react'
import { View } from 'react-native'
import { BACKUP_SCHEDULE_PRESETS } from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminField } from '@/admin/AdminField'
import { isValidLibraryCron } from '@/admin/LibraryDraft'
import { icons } from '@/ui/icons'
import { AppText, IconButton, Sheet, type SheetRef } from '@/ui/primitives'
import { SettingsGroup, SettingsRow } from '@/ui/settingsControls'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

const KEEP_MIN = 1
const KEEP_MAX = 99
const LOCKED_HINT = "Set by your server's environment. Change it there."

function scheduleLabel(cron: string): string {
  const preset = BACKUP_SCHEDULE_PRESETS.find((p) => p.value === cron)
  return preset?.label ?? `Custom: ${cron}`
}

export function BackupSchedule({
  schedule,
  keep,
  scheduleLocked = false,
  keepLocked = false,
  disabled,
  onSchedule,
  onKeep,
}: {
  schedule: string
  keep: number
  scheduleLocked?: boolean
  keepLocked?: boolean
  disabled: boolean
  onSchedule: (cron: string) => void
  onKeep: (keep: number) => void
}) {
  const colors = useColors()
  const sheet = useRef<SheetRef>(null)
  const isPreset = BACKUP_SCHEDULE_PRESETS.some((p) => p.value === schedule)
  const [customOpen, setCustomOpen] = useState(false)
  const [custom, setCustom] = useState(isPreset ? '' : schedule)
  const [keepText, setKeepText] = useState(String(keep))

  useEffect(() => setKeepText(String(keep)), [keep])

  const keepNumber = Number(keepText)
  const keepValid = Number.isInteger(keepNumber) && keepNumber >= KEEP_MIN && keepNumber <= KEEP_MAX
  const showCustom = !scheduleLocked && (customOpen || !isPreset)
  const customValid = isValidLibraryCron(custom)

  const pick = (cron: string) => {
    sheet.current?.dismiss()
    setCustomOpen(false)
    if (cron !== schedule) onSchedule(cron)
  }

  const saveKeep = () => {
    if (keepLocked) return
    if (keepValid && keepNumber !== keep) onKeep(keepNumber)
    else setKeepText(String(keep))
  }

  return (
    <SettingsGroup>
      <SettingsRow
        icon={icons.schedule}
        title="Automatic backups"
        desc={
          scheduleLocked ? `${scheduleLabel(schedule)}. ${LOCKED_HINT}` : scheduleLabel(schedule)
        }
        onPress={scheduleLocked || disabled ? undefined : () => sheet.current?.present()}
      />
      {showCustom ? (
        <View style={{ padding: spacing.md, gap: spacing.sm }}>
          <AdminField
            label="Custom schedule"
            hint="Minute, hour, day, month, weekday. For example: 0 1 * * *"
            value={custom}
            onChangeText={setCustom}
            error={custom && !customValid ? "That isn't a valid schedule." : undefined}
          />
          <AdminButton
            label="Save schedule"
            kind="secondary"
            disabled={disabled || !customValid || custom.trim() === schedule}
            onPress={() => onSchedule(custom.trim().replace(/\s+/g, ' '))}
          />
        </View>
      ) : null}
      <View style={{ padding: spacing.md }}>
        <AdminField
          label="How many backups to keep"
          hint={keepLocked ? LOCKED_HINT : `From ${KEEP_MIN} to ${KEEP_MAX}.`}
          value={keepText}
          onChangeText={setKeepText}
          onEndEditing={saveKeep}
          keyboardType="number-pad"
          editable={!keepLocked && !disabled}
          error={
            keepText && !keepValid ? `Use a number from ${KEEP_MIN} to ${KEEP_MAX}.` : undefined
          }
        />
      </View>

      <Sheet ref={sheet} title="Automatic backups">
        <View style={{ gap: spacing.xs }}>
          {BACKUP_SCHEDULE_PRESETS.map((preset) => (
            <SettingsRow
              key={preset.value}
              title={preset.label}
              onPress={() => pick(preset.value)}
              control={
                preset.value === schedule ? (
                  <IconButton name={icons.check} size={20} color={colors.accent} />
                ) : undefined
              }
            />
          ))}
          <SettingsRow
            title="Custom schedule"
            last
            onPress={() => {
              sheet.current?.dismiss()
              setCustomOpen(true)
            }}
          />
          <AppText variant="meta" color={colors.textMuted}>
            Times use your server's clock.
          </AppText>
        </View>
      </Sheet>
    </SettingsGroup>
  )
}
