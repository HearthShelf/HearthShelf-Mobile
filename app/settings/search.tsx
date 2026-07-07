/**
 * Search panel: how far search reaches. Split out of the old "Connections"
 * panel so discovery preferences stand on their own.
 */
import { useSyncExternalStore } from 'react'
import { getSettingsState, subscribeSettings, setSetting } from '@/store/settings'
import { SettingsPanel, SettingsGroup, SettingsRow, SettingsToggle } from '@/ui/settingsControls'

export default function SearchPanel() {
  const searchExternalSources = useSyncExternalStore(
    subscribeSettings,
    () => getSettingsState().searchExternalSources,
  )

  return (
    <SettingsPanel>
      <SettingsGroup>
        <SettingsRow
          icon="travel-explore"
          title="Search outside your library"
          desc="Also find audiobooks you don't own yet. Search shows them in a 'Not in your library' section so you can request them."
          control={
            <SettingsToggle
              on={searchExternalSources}
              onChange={(v) => setSetting('searchExternalSources', v)}
            />
          }
          last
        />
      </SettingsGroup>
    </SettingsPanel>
  )
}
