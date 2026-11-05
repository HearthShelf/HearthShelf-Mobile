/**
 * The services this server talks to. Secrets are write-only: the server only says
 * whether one is saved, and a blank field keeps it. A field pinned by an environment
 * variable is read-only, because the server would ignore a change to it.
 *
 * ABS's custom metadata providers load apart from the rest and are read-only here.
 */
import { useRef, useState } from 'react'
import { View } from 'react-native'
import {
  AUDIBLE_REGION_LABELS,
  parseRmabLoginTokenInput,
  rmabUrlMismatch,
  type HSAudibleRegion,
  type HSIntegrationsConfig,
  type HSIntegrationsPatch,
} from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminField } from '@/admin/AdminField'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { HttpWarning } from '@/admin/HttpWarning'
import { StatusPill } from '@/admin/StatusPill'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import {
  getCustomProviders,
  getIntegrationsConfig,
  saveIntegrationsConfig,
} from '@/api/admin/integrations'
import { Icon } from '@/ui/icons'
import { AppText, Sheet, type SheetRef } from '@/ui/primitives'
import {
  SettingsGroup,
  SettingsLabel,
  SettingsPanel,
  SettingsRow,
  SettingsToggle,
} from '@/ui/settingsControls'
import { SkeletonRow } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

const ENV_NOTE = 'Set by the server environment. Remove the variable to change it here.'

function secretPlaceholder(locked: boolean, saved: boolean, empty: string): string {
  if (locked) return 'Set by the environment'
  return saved ? 'Saved. Leave blank to keep it.' : empty
}

function regionLabel(region: HSAudibleRegion): string {
  return AUDIBLE_REGION_LABELS[region] ?? region.toUpperCase()
}

function IntegrationsForm({
  config,
  onSaved,
  reload,
}: {
  config: HSIntegrationsConfig
  onSaved: (next: HSIntegrationsConfig) => void
  reload: () => void
}) {
  const colors = useColors()
  const { run, busy } = useAdminWrite()
  const regionSheet = useRef<SheetRef>(null)
  const env = config.env

  const [rmabUrl, setRmabUrl] = useState(config.rmabUrl ?? '')
  const [rmabToken, setRmabToken] = useState('')
  const [rmabWarning, setRmabWarning] = useState<string | null>(null)
  const [pastedBaseUrl, setPastedBaseUrl] = useState<string | null>(null)
  const [audplexusUrl, setAudplexusUrl] = useState(config.audplexusUrl ?? '')
  const [audplexusKey, setAudplexusKey] = useState('')

  const save = (patch: HSIntegrationsPatch, failed: string, afterSave?: () => void) =>
    void run(
      async () => {
        onSaved(await saveIntegrationsConfig(patch))
        afterSave?.()
      },
      { done: 'Saved', failed, reload },
    )

  const rmabPatch: HSIntegrationsPatch = {}
  if (!env.rmabUrl && rmabUrl.trim() !== (config.rmabUrl ?? '')) {
    rmabPatch.rmabUrl = rmabUrl.trim() || null
  }
  if (!env.rmabLoginToken && rmabToken.trim()) rmabPatch.rmabLoginToken = rmabToken.trim()

  const audplexusPatch: HSIntegrationsPatch = {}
  if (!env.audplexusUrl && audplexusUrl.trim() !== (config.audplexusUrl ?? '')) {
    audplexusPatch.audplexusUrl = audplexusUrl.trim() || null
  }
  if (!env.audplexusKey && audplexusKey.trim()) audplexusPatch.audplexusKey = audplexusKey.trim()

  function changeRmabUrl(value: string) {
    setRmabUrl(value)
    setRmabWarning(rmabUrlMismatch(pastedBaseUrl, value))
  }

  function changeRmabToken(value: string) {
    const parsed = parseRmabLoginTokenInput(value)
    setRmabToken(parsed.token)
    setPastedBaseUrl(parsed.baseUrl)
    if (!parsed.baseUrl) {
      setRmabWarning(null)
      return
    }
    const currentUrl = env.rmabUrl ? (config.rmabUrl ?? '') : rmabUrl.trim()
    if (!currentUrl && !env.rmabUrl) {
      setRmabUrl(parsed.baseUrl)
      setRmabWarning(null)
      return
    }
    setRmabWarning(rmabUrlMismatch(parsed.baseUrl, currentUrl))
  }

  function pickRegion(region: HSAudibleRegion) {
    regionSheet.current?.dismiss()
    if (region !== config.audibleRegion) {
      save({ audibleRegion: region }, "Couldn't change the Audible region.")
    }
  }

  return (
    <>
      <View>
        <SettingsLabel>ReadMeABook</SettingsLabel>
        <SettingsGroup>
          <SettingsRow
            icon="auto-stories"
            title="Book requests"
            desc="Use a Login Token, not an API Token. In ReadMeABook, open Admin, then Users. Pick an admin account made for this and turn on Login Token. Paste the link or the rmab_ token."
            control={
              <StatusPill
                label={config.rmabConfigured ? 'Connected' : 'Off'}
                tone={config.rmabConfigured ? 'good' : 'neutral'}
              />
            }
            stacked
            last
          >
            <View style={{ gap: spacing.md, paddingTop: spacing.md }}>
              <AdminField
                label="Server URL"
                placeholder="https://audiobooks.example.com"
                keyboardType="url"
                value={env.rmabUrl ? (config.rmabUrl ?? '') : rmabUrl}
                editable={!env.rmabUrl}
                hint={env.rmabUrl ? ENV_NOTE : undefined}
                onChangeText={changeRmabUrl}
              />
              <AdminField
                label="Login token"
                placeholder={secretPlaceholder(
                  env.rmabLoginToken,
                  config.rmabHasToken,
                  'Paste the token or login link',
                )}
                secureTextEntry
                value={rmabToken}
                editable={!env.rmabLoginToken}
                hint={env.rmabLoginToken ? ENV_NOTE : undefined}
                onChangeText={changeRmabToken}
              />
              {rmabWarning ? (
                <AppText variant="meta" color={colors.destructive}>
                  {rmabWarning}
                </AppText>
              ) : null}
              {env.rmabUrl && env.rmabLoginToken ? null : (
                <AdminButton
                  label="Save"
                  icon="save"
                  busy={busy}
                  disabled={Object.keys(rmabPatch).length === 0}
                  onPress={() =>
                    save(rmabPatch, "Couldn't save the ReadMeABook settings.", () => {
                      setRmabToken('')
                      setPastedBaseUrl(null)
                      setRmabWarning(null)
                    })
                  }
                />
              )}
            </View>
          </SettingsRow>
        </SettingsGroup>
      </View>

      <View>
        <SettingsLabel>Audplexus</SettingsLabel>
        <SettingsGroup>
          <SettingsRow
            icon="graphic-eq"
            title="Audplexus"
            control={
              <StatusPill
                label={config.audplexusConfigured ? 'Connected' : 'Off'}
                tone={config.audplexusConfigured ? 'good' : 'neutral'}
              />
            }
            stacked
            last
          >
            <View style={{ gap: spacing.md, paddingTop: spacing.md }}>
              <AdminField
                label="Server URL"
                placeholder="https://audplexus.example.com"
                keyboardType="url"
                value={env.audplexusUrl ? (config.audplexusUrl ?? '') : audplexusUrl}
                editable={!env.audplexusUrl}
                hint={env.audplexusUrl ? ENV_NOTE : undefined}
                onChangeText={setAudplexusUrl}
              />
              <AdminField
                label="API key"
                placeholder={secretPlaceholder(
                  env.audplexusKey,
                  config.audplexusHasKey,
                  'Paste the API key',
                )}
                secureTextEntry
                value={audplexusKey}
                editable={!env.audplexusKey}
                hint={env.audplexusKey ? ENV_NOTE : undefined}
                onChangeText={setAudplexusKey}
              />
              {env.audplexusUrl && env.audplexusKey ? null : (
                <AdminButton
                  label="Save"
                  icon="save"
                  busy={busy}
                  disabled={Object.keys(audplexusPatch).length === 0}
                  onPress={() =>
                    save(audplexusPatch, "Couldn't save the Audplexus settings.", () =>
                      setAudplexusKey(''),
                    )
                  }
                />
              )}
            </View>
          </SettingsRow>
        </SettingsGroup>
      </View>

      <View>
        <SettingsLabel>Audible catalog</SettingsLabel>
        <SettingsGroup>
          <SettingsRow
            icon="public"
            title="Use the Audible catalog"
            desc={
              env.audibleEnabled
                ? ENV_NOTE
                : 'Shows upcoming releases, books missing from a series, and countdowns. Off keeps HearthShelf to your own library.'
            }
            control={
              env.audibleEnabled ? (
                <StatusPill label={config.audibleEnabled ? 'On' : 'Off'} />
              ) : (
                <SettingsToggle
                  on={config.audibleEnabled}
                  onChange={(audibleEnabled) =>
                    save({ audibleEnabled }, "Couldn't change the Audible catalog setting.")
                  }
                />
              )
            }
          />
          <SettingsRow
            icon="language"
            title="Region"
            desc={
              env.audibleRegion
                ? `${regionLabel(config.audibleRegion)}. ${ENV_NOTE}`
                : regionLabel(config.audibleRegion)
            }
            onPress={env.audibleRegion ? undefined : () => regionSheet.current?.present()}
            last
          />
        </SettingsGroup>
      </View>

      <Sheet ref={regionSheet} title="Audible region">
        {config.validRegions.map((region, i) => (
          <SettingsRow
            key={region}
            title={regionLabel(region)}
            control={
              region === config.audibleRegion ? (
                <Icon name="check" size={20} color={colors.accent} />
              ) : undefined
            }
            onPress={() => pickRegion(region)}
            last={i === config.validRegions.length - 1}
          />
        ))}
      </Sheet>
    </>
  )
}

function CustomProviders() {
  const colors = useColors()
  const { data, loading, reload } = useAdminResource(getCustomProviders)
  return (
    <View>
      <SettingsLabel>Custom metadata providers</SettingsLabel>
      {loading ? (
        <SkeletonRow />
      ) : !data ? (
        <SettingsGroup>
          <SettingsRow
            icon="refresh"
            title="Couldn't load providers"
            desc="Tap to try again."
            onPress={reload}
            last
          />
        </SettingsGroup>
      ) : data.length === 0 ? (
        <AppText variant="meta" color={colors.textMuted}>
          No custom providers. The built-in ones are always available.
        </AppText>
      ) : (
        <SettingsGroup>
          {data.map((provider, i) => (
            <SettingsRow
              key={provider.id}
              icon="travel-explore"
              title={provider.name}
              desc={provider.url}
              last={i === data.length - 1}
            />
          ))}
        </SettingsGroup>
      )}
    </View>
  )
}

function Integrations() {
  const { data, loading, error, reload } = useAdminResource(getIntegrationsConfig)
  // Holds the save's answer only until the reload that follows replaces `data`.
  const [saved, setSaved] = useState<{
    base: HSIntegrationsConfig
    next: HSIntegrationsConfig
  } | null>(null)

  if (!data && error) return <AdminUnavailable error={error} onRetry={reload} />

  const config = saved && saved.base === data ? saved.next : data
  return (
    <SettingsPanel>
      <HttpWarning />
      {loading || !data || !config ? (
        <View style={{ gap: spacing.md }}>
          <SkeletonRow />
          <SkeletonRow width="80%" />
          <SkeletonRow width="40%" />
        </View>
      ) : (
        <IntegrationsForm
          key={JSON.stringify(config.env)}
          config={config}
          onSaved={(next) => setSaved({ base: data, next })}
          reload={reload}
        />
      )}
      <CustomProviders />
    </SettingsPanel>
  )
}

export default function IntegrationsScreen() {
  return (
    <AdminGate>
      <Integrations />
    </AdminGate>
  )
}
