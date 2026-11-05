/** General: the server's name, its scanner switches, date formats, and versions. */
import { useState } from 'react'
import { View } from 'react-native'
import { SCANNER_TOGGLES, type ABSServerSettings, type ScannerToggleKey } from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminField } from '@/admin/AdminField'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { getServerSettings, setServerName, updateServerSettings } from '@/api/admin/general'
import { getServerRuntime } from '@/api/admin/server'
import { useConnection } from '@/api/ConnectionProvider'
import {
  SettingsGroup,
  SettingsLabel,
  SettingsPanel,
  SettingsRow,
  SettingsToggle,
} from '@/ui/settingsControls'
import { SkeletonRow } from '@/ui/states'
import { spacing } from '@/ui/theme'

export default function GeneralScreen() {
  return (
    <AdminGate>
      <General />
    </AdminGate>
  )
}

function General() {
  const { serverName } = useConnection()
  const runtime = useAdminResource(getServerRuntime)
  const settings = useAdminResource(getServerSettings)

  if (settings.error && !settings.data && runtime.error && !runtime.data) {
    return <AdminUnavailable error={settings.error} onRetry={settings.reload} />
  }

  const name = runtime.data?.serverName ?? serverName ?? ''

  return (
    <SettingsPanel>
      <SettingsLabel>Server</SettingsLabel>
      {runtime.loading ? (
        <SkeletonRow />
      ) : (
        <ServerNameForm key={name} current={name} onSaved={runtime.reload} />
      )}

      {settings.loading ? (
        <SkeletonRow />
      ) : settings.data ? (
        <ScannerForm
          key={formKey(settings.data)}
          settings={settings.data}
          onSaved={settings.reload}
        />
      ) : (
        <SettingsGroup>
          <SettingsRow
            icon="error-outline"
            title="Scanner settings unavailable"
            desc="Tap to try again."
            onPress={settings.reload}
            last
          />
        </SettingsGroup>
      )}

      <SettingsLabel>Versions</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          icon="local-fire-department"
          title="HearthShelf"
          desc={versionText(runtime.data?.hsVersion)}
        />
        <SettingsRow
          icon="dns"
          title="Audiobookshelf"
          desc={versionText(runtime.data?.absVersion)}
          last
        />
      </SettingsGroup>
    </SettingsPanel>
  )
}

function versionText(version: string | null | undefined): string {
  return version ? `Version ${version}` : 'Unknown'
}

/** A reload that brings new values resets the form. One that matches keeps a draft. */
function formKey(settings: ABSServerSettings): string {
  return JSON.stringify([
    SCANNER_TOGGLES.map((t) => !!settings[t.key]),
    settings.dateFormat,
    settings.timeFormat,
  ])
}

function ServerNameForm({ current, onSaved }: { current: string; onSaved: () => void }) {
  const { run, busy } = useAdminWrite()
  const [name, setName] = useState(current)
  const trimmed = name.trim()

  return (
    <View style={{ gap: spacing.md }}>
      <AdminField
        label="Server name"
        hint="How this server appears in HearthShelf."
        placeholder="My HearthShelf"
        autoCapitalize="words"
        value={name}
        onChangeText={setName}
      />
      <AdminButton
        label="Save name"
        icon="save"
        busy={busy}
        disabled={trimmed === current || trimmed.length < 2}
        onPress={() =>
          void run(() => setServerName(trimmed), {
            done: 'Server name saved',
            failed: "Couldn't save the server name.",
            reload: onSaved,
          })
        }
      />
    </View>
  )
}

function ScannerForm({ settings, onSaved }: { settings: ABSServerSettings; onSaved: () => void }) {
  const { run, busy } = useAdminWrite()
  const [toggles, setToggles] = useState<Record<ScannerToggleKey, boolean>>(() => ({
    scannerFindCovers: !!settings.scannerFindCovers,
    scannerParseSubtitle: !!settings.scannerParseSubtitle,
    scannerPreferMatchedMetadata: !!settings.scannerPreferMatchedMetadata,
    scannerDisableWatcher: !!settings.scannerDisableWatcher,
    storeCoverWithItem: !!settings.storeCoverWithItem,
  }))
  const [dateFormat, setDateFormat] = useState(settings.dateFormat ?? '')
  const [timeFormat, setTimeFormat] = useState(settings.timeFormat ?? '')

  // Only what changed, so a stale screen can't undo another admin's edit. A blank
  // format means "keep the current one": the server has no empty format.
  const patch: Partial<ABSServerSettings> = {}
  for (const t of SCANNER_TOGGLES) {
    if (toggles[t.key] !== !!settings[t.key]) patch[t.key] = toggles[t.key]
  }
  const date = dateFormat.trim()
  const time = timeFormat.trim()
  if (date && date !== settings.dateFormat) patch.dateFormat = date
  if (time && time !== settings.timeFormat) patch.timeFormat = time

  return (
    <>
      <SettingsLabel>Scanner</SettingsLabel>
      <SettingsGroup>
        {SCANNER_TOGGLES.map((t, i) => (
          <SettingsRow
            key={t.key}
            title={t.label}
            desc={t.desc}
            control={
              <SettingsToggle
                on={toggles[t.key]}
                onChange={(on) => setToggles((cur) => ({ ...cur, [t.key]: on }))}
              />
            }
            last={i === SCANNER_TOGGLES.length - 1}
          />
        ))}
      </SettingsGroup>

      <SettingsLabel>Display</SettingsLabel>
      <AdminField
        label="Date format"
        placeholder="MM/dd/yyyy"
        value={dateFormat}
        onChangeText={setDateFormat}
      />
      <AdminField
        label="Time format"
        placeholder="HH:mm"
        value={timeFormat}
        onChangeText={setTimeFormat}
      />

      <AdminButton
        label="Save settings"
        icon="save"
        busy={busy}
        disabled={Object.keys(patch).length === 0}
        onPress={() =>
          void run(() => updateServerSettings(patch), {
            done: 'Settings saved',
            failed: "Couldn't save the settings.",
            reload: onSaved,
          })
        }
      />
    </>
  )
}
