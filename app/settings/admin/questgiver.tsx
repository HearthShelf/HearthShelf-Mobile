/**
 * QuestGiver slice: the two feature switches and whether a provider is ready.
 * Provider, model, key and limit setup is a long form, so it stays on the web.
 */
import { useState } from 'react'
import { View } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { QG_PROVIDER_LABELS } from '@hearthshelf/core'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { StatusPill, type StatusTone } from '@/admin/StatusPill'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import {
  getQgAdminStatus,
  saveQgAdminConfig,
  type QgAdminStatus,
} from '@/api/admin/questgiverAdmin'
import { WEBAPP_URL } from '@/lib/config'
import {
  SettingsGroup,
  SettingsLabel,
  SettingsPanel,
  SettingsRow,
  SettingsToggle,
} from '@/ui/settingsControls'
import { SkeletonRow } from '@/ui/states'
import { spacing } from '@/ui/theme'

const ENV_NOTE = 'Set by the server environment. Remove the variable to change it here.'

function credentialStatus({ config, copilot, copilotCheckFailed }: QgAdminStatus): {
  label: string
  tone: StatusTone
  desc: string
} {
  if (config.hasKey) {
    return { label: 'Ready', tone: 'good', desc: 'A key is saved on the server.' }
  }
  if (copilot?.authenticated) {
    return {
      label: 'Ready',
      tone: 'good',
      desc: copilot.login ? `Signed in to GitHub as ${copilot.login}.` : 'Signed in to GitHub.',
    }
  }
  if (copilotCheckFailed) {
    return { label: 'Unknown', tone: 'neutral', desc: "We couldn't check the GitHub sign-in." }
  }
  return {
    label: 'Not set',
    tone: 'bad',
    desc: 'AI picks will not work until this is set up on the web.',
  }
}

function QuestGiverAdmin() {
  const { data, loading, error, reload } = useAdminResource(getQgAdminStatus)
  const { run } = useAdminWrite()
  // Holds the save's answer only until the reload that follows replaces `data`.
  const [saved, setSaved] = useState<{ base: QgAdminStatus; next: QgAdminStatus } | null>(null)

  if (!data && error) return <AdminUnavailable error={error} onRetry={reload} />
  if (loading || !data) {
    return (
      <SettingsPanel>
        <View style={{ gap: spacing.md }}>
          <SkeletonRow />
          <SkeletonRow width="80%" />
          <SkeletonRow width="40%" />
        </View>
      </SettingsPanel>
    )
  }

  const status = saved?.base === data ? saved.next : data
  const { config } = status
  const credential = credentialStatus(status)

  const save = (patch: { enabled: boolean } | { discoverEnabled: boolean }, done: string) =>
    void run(
      async () => {
        const next = await saveQgAdminConfig(patch)
        setSaved({ base: data, next: { ...status, config: next } })
      },
      { done, failed: "Couldn't save that setting.", reload },
    )

  return (
    <SettingsPanel>
      <View>
        <SettingsLabel>Features</SettingsLabel>
        <SettingsGroup>
          <SettingsRow
            icon="auto-awesome"
            title="QuestGiver"
            desc={
              config.env.enabled
                ? ENV_NOTE
                : 'Turns the AI recommender on or off. Built-in picks still work with no AI provider.'
            }
            control={
              config.env.enabled ? (
                <StatusPill label={config.enabled ? 'On' : 'Off'} />
              ) : (
                <SettingsToggle
                  on={config.enabled}
                  onChange={(enabled) =>
                    save({ enabled }, enabled ? 'QuestGiver is on' : 'QuestGiver is off')
                  }
                />
              )
            }
          />
          <SettingsRow
            icon="explore"
            title="Discover"
            desc={
              config.env.discoverEnabled
                ? ENV_NOTE
                : 'Shows the Discover page, its shelves, and the QuestGiver prompt.'
            }
            control={
              config.env.discoverEnabled ? (
                <StatusPill label={config.discoverEnabled ? 'On' : 'Off'} />
              ) : (
                <SettingsToggle
                  on={config.discoverEnabled}
                  onChange={(discoverEnabled) =>
                    save(
                      { discoverEnabled },
                      discoverEnabled ? 'Discover is on' : 'Discover is off',
                    )
                  }
                />
              )
            }
            last
          />
        </SettingsGroup>
      </View>

      <View>
        <SettingsLabel>AI provider</SettingsLabel>
        <SettingsGroup>
          {config.provider ? (
            <>
              <SettingsRow
                icon="smart-toy"
                title={QG_PROVIDER_LABELS[config.provider] ?? config.provider}
                desc={config.model ? `Model: ${config.model}` : 'Default model'}
              />
              <SettingsRow
                icon="key"
                title="Sign-in"
                desc={credential.desc}
                control={<StatusPill label={credential.label} tone={credential.tone} />}
              />
            </>
          ) : (
            <SettingsRow
              icon="smart-toy"
              title="No provider"
              desc="QuestGiver uses its built-in picks."
              control={<StatusPill label="Off" />}
            />
          )}
          <SettingsRow
            icon="open-in-new"
            title="Set up on the web"
            desc="Provider, model, key, and limits."
            onPress={() => void WebBrowser.openBrowserAsync(`${WEBAPP_URL}/config/questgiver`)}
            last
          />
        </SettingsGroup>
      </View>
    </SettingsPanel>
  )
}

export default function QuestGiverAdminScreen() {
  return (
    <AdminGate>
      <QuestGiverAdmin />
    </AdminGate>
  )
}
