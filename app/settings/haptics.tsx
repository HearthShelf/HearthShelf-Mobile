/**
 * Haptics panel: how much vibration feedback fires and how hard. Device-scoped -
 * this is your phone's hardware, so it backs up per device rather than following
 * your account to other devices.
 */
import { useSyncExternalStore } from 'react'
import { getSettingsState, subscribeSettings, setSetting } from '@/store/settings'
import { SettingsPanel, SettingsGroup, SettingsRow, Seg } from '@/ui/settingsControls'

export default function HapticsPanel() {
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)

  return (
    <SettingsPanel>
      <SettingsGroup>
        <SettingsRow title="Feedback" desc="How much of the app taps back." stacked last={s.haptics === 'off'}>
          <Seg
            value={s.haptics}
            onChange={(v) => setSetting('haptics', v)}
            fill
            options={[
              { value: 'off', label: 'Off' },
              { value: 'minimal', label: 'Minimal' },
              { value: 'all', label: 'All' },
            ]}
          />
        </SettingsRow>
        {s.haptics !== 'off' && (
          <SettingsRow title="Intensity" desc="How firm each tap feels." stacked last>
            <Seg
              value={s.hapticIntensity}
              onChange={(v) => setSetting('hapticIntensity', v)}
              fill
              options={[
                { value: 'light', label: 'Light' },
                { value: 'medium', label: 'Medium' },
              ]}
            />
          </SettingsRow>
        )}
      </SettingsGroup>
    </SettingsPanel>
  )
}
