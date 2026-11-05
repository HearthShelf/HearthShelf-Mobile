/** Notifications: where the server sends its alerts, and which rules are on. */
import { useState } from 'react'
import { type ABSNotificationRule } from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminField } from '@/admin/AdminField'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { HttpWarning } from '@/admin/HttpWarning'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import {
  getNotificationSettings,
  updateNotificationRule,
  updateNotificationSettings,
  type AdminNotificationSettings,
} from '@/api/admin/notifications'
import {
  SettingsGroup,
  SettingsLabel,
  SettingsPanel,
  SettingsRow,
  SettingsToggle,
} from '@/ui/settingsControls'
import { EmptyState, SkeletonRow } from '@/ui/states'

export default function NotificationsScreen() {
  return (
    <AdminGate>
      <Notifications />
    </AdminGate>
  )
}

function Notifications() {
  const { data, loading, error, reload } = useAdminResource(getNotificationSettings)

  if (error && !data) return <AdminUnavailable error={error} onRetry={reload} />

  if (loading || !data) {
    return (
      <SettingsPanel>
        <SkeletonRow />
        <SkeletonRow />
      </SettingsPanel>
    )
  }

  return (
    <SettingsPanel>
      {/* Keyed apart so toggling a rule can't throw away a half-typed URL. */}
      <AppriseForm
        key={`${data.appriseApiUrl}|${data.maxFailedAttempts}`}
        settings={data}
        onSaved={reload}
      />
      <SettingsLabel>{`Rules · ${data.notifications.length}`}</SettingsLabel>
      {data.notifications.length === 0 ? (
        <EmptyState
          icon="notifications-off"
          title="No rules yet"
          body="This server has no notification rules to turn on or off."
        />
      ) : (
        <Rules
          key={JSON.stringify(data.notifications)}
          rules={data.notifications}
          onSaved={reload}
        />
      )}
    </SettingsPanel>
  )
}

function AppriseForm({
  settings,
  onSaved,
}: {
  settings: AdminNotificationSettings
  onSaved: () => void
}) {
  const { run, busy } = useAdminWrite()
  const [url, setUrl] = useState(settings.appriseApiUrl ?? '')
  const [maxFailed, setMaxFailed] = useState(String(settings.maxFailedAttempts))

  const attempts = Number(maxFailed)
  const dirty =
    url.trim() !== (settings.appriseApiUrl ?? '') || attempts !== settings.maxFailedAttempts

  return (
    <>
      <HttpWarning />
      <AdminField
        label="Apprise API URL"
        hint="The server sends its alerts through your Apprise server."
        placeholder="https://apprise.example.com/notify"
        keyboardType="url"
        value={url}
        onChangeText={setUrl}
      />
      <AdminField
        label="Max failed attempts"
        hint="Stop trying after this many failures."
        keyboardType="number-pad"
        value={maxFailed}
        onChangeText={(text) => setMaxFailed(text.replace(/[^0-9]/g, ''))}
      />
      <AdminButton
        label="Save"
        icon="save"
        busy={busy}
        disabled={!dirty || attempts < 1}
        onPress={() =>
          void run(
            () =>
              updateNotificationSettings({
                appriseApiUrl: url.trim() || null,
                maxFailedAttempts: attempts,
                maxNotificationQueue: settings.maxNotificationQueue,
              }),
            {
              done: 'Notification settings saved',
              failed: "Couldn't save the notification settings.",
              reload: onSaved,
            },
          )
        }
      />
    </>
  )
}

/** "onBackupCompleted" becomes "Backup completed". */
function ruleLabel(eventName: string): string {
  const words = eventName
    .replace(/^on(?=[A-Z])/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function Rules({ rules, onSaved }: { rules: ABSNotificationRule[]; onSaved: () => void }) {
  const { run, busy } = useAdminWrite()
  const [shown, setShown] = useState(rules)

  async function toggle(rule: ABSNotificationRule, enabled: boolean) {
    if (busy) return
    setShown((cur) => cur.map((r) => (r.id === rule.id ? { ...r, enabled } : r)))
    const ok = await run(() => updateNotificationRule(rule.id, enabled), {
      done: `${ruleLabel(rule.eventName)} ${enabled ? 'on' : 'off'}`,
      failed: "Couldn't change that rule.",
      reload: onSaved,
    })
    if (!ok) setShown(rules)
  }

  return (
    <SettingsGroup>
      {shown.map((rule, i) => (
        <SettingsRow
          key={rule.id}
          title={ruleLabel(rule.eventName)}
          control={<SettingsToggle on={rule.enabled} onChange={(on) => void toggle(rule, on)} />}
          last={i === shown.length - 1}
        />
      ))}
    </SettingsGroup>
  )
}
