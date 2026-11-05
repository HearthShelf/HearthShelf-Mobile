/** Automatic scans: pick a preset, or write cron under Custom. */
import { useState } from 'react'
import { AdminField } from '@/admin/AdminField'
import {
  LIBRARY_DEFAULT_CRON,
  LIBRARY_SCHEDULE_PRESETS,
  libraryDraftProblems,
  patchLibrarySettings,
  type LibraryDraftState,
} from '@/admin/LibraryDraft'
import { LibraryDraftScreen } from '@/admin/LibraryDraftScreen'
import { LibraryChoiceRow } from '@/admin/LibraryPicker'
import { AppText } from '@/ui/primitives'
import { SettingsGroup, SettingsPanel } from '@/ui/settingsControls'
import { useColors } from '@/ui/ThemeProvider'

export default function LibraryScheduleScreen() {
  return <LibraryDraftScreen>{(state) => <Schedule state={state} />}</LibraryDraftScreen>
}

function Schedule({ state }: { state: LibraryDraftState }) {
  const colors = useColors()
  const cron = state.draft.settings.autoScanCron
  const isPreset = LIBRARY_SCHEDULE_PRESETS.some((p) => p.value === cron)
  const [custom, setCustom] = useState(cron != null && !isPreset)

  function pick(autoScanCron: string | null) {
    setCustom(false)
    patchLibrarySettings({ autoScanCron })
  }

  return (
    <SettingsPanel>
      <SettingsGroup>
        <LibraryChoiceRow
          label="Off"
          selected={!custom && cron == null}
          onPress={() => pick(null)}
        />
        {LIBRARY_SCHEDULE_PRESETS.map((preset) => (
          <LibraryChoiceRow
            key={preset.value}
            label={preset.label}
            selected={!custom && cron === preset.value}
            onPress={() => pick(preset.value)}
          />
        ))}
        <LibraryChoiceRow
          label="Custom"
          selected={custom}
          onPress={() => {
            setCustom(true)
            if (cron == null) patchLibrarySettings({ autoScanCron: LIBRARY_DEFAULT_CRON })
          }}
        />
      </SettingsGroup>
      {custom ? (
        <AdminField
          label="Cron schedule"
          hint="Five parts: minute, hour, day, month, weekday. 0 0 * * 1 runs every Monday at midnight."
          error={libraryDraftProblems(state).schedule}
          placeholder={LIBRARY_DEFAULT_CRON}
          value={cron ?? ''}
          onChangeText={(autoScanCron) => patchLibrarySettings({ autoScanCron })}
        />
      ) : null}
      <AppText variant="caption" color={colors.textMuted}>
        Times follow the server&apos;s clock.
      </AppText>
    </SettingsPanel>
  )
}
