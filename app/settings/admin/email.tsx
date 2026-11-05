/**
 * Email: the part of email an admin needs on a phone. The mail server form is on
 * the web. So is turning on HearthShelf email, which overwrites the server's own
 * mail settings and has no off switch.
 */
import { useState } from 'react'
import { View } from 'react-native'
import * as WebBrowser from 'expo-web-browser'
import { AdminButton } from '@/admin/AdminButton'
import { AdminField } from '@/admin/AdminField'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { StatusPill } from '@/admin/StatusPill'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import {
  addEreaderDevice,
  getEmailRelayStatus,
  getEmailSettings,
  removeEreaderDevice,
  sendTestEmail,
  setTestAddress,
  type EmailSettings,
  type EreaderDevice,
} from '@/api/admin/email'
import { WEBAPP_URL } from '@/lib/config'
import { confirm } from '@/ui/confirm'
import { IconButton } from '@/ui/primitives'
import { SettingsGroup, SettingsLabel, SettingsPanel, SettingsRow } from '@/ui/settingsControls'
import { SkeletonRow } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

function openEmailOnWeb() {
  void WebBrowser.openBrowserAsync(`${WEBAPP_URL}/config/email`)
}

export default function EmailScreen() {
  return (
    <AdminGate>
      <Email />
    </AdminGate>
  )
}

function Email() {
  const settings = useAdminResource(getEmailSettings)
  const relay = useAdminResource(getEmailRelayStatus)
  const data = settings.data

  if (settings.error && !data) {
    return <AdminUnavailable error={settings.error} onRetry={settings.reload} />
  }

  if (settings.loading || !data) {
    return (
      <SettingsPanel>
        <SkeletonRow />
        <SkeletonRow />
      </SettingsPanel>
    )
  }

  const relayActive = relay.data?.active ?? false

  return (
    <SettingsPanel>
      <SettingsLabel>Sending</SettingsLabel>
      <SettingsGroup>
        {relay.data ? (
          <SettingsRow
            icon="mark-email-read"
            title="HearthShelf email"
            desc={
              relayActive
                ? "Email goes out through HearthShelf, so this server doesn't need its own mail server."
                : relay.data.available
                  ? 'You can send through HearthShelf instead of your own mail server. Tap to set it up on the web.'
                  : 'This server sends with its own mail settings.'
            }
            control={
              <StatusPill
                label={relayActive ? 'On' : 'Off'}
                tone={relayActive ? 'good' : 'neutral'}
              />
            }
            onPress={!relayActive && relay.data.available ? openEmailOnWeb : undefined}
            last={relayActive}
          />
        ) : relay.loading ? null : (
          <SettingsRow
            icon="error-outline"
            title="Couldn't check HearthShelf email"
            desc="Tap to try again."
            onPress={relay.reload}
          />
        )}
        {relayActive ? null : (
          <SettingsRow
            icon="dns"
            title="Mail server"
            desc={
              data.host
                ? `Using ${data.host}. Change this on the web.`
                : 'Not set up yet. Set this up on the web.'
            }
            onPress={openEmailOnWeb}
            last
          />
        )}
      </SettingsGroup>

      <SettingsLabel>Test email</SettingsLabel>
      <TestSend key={data.testAddress ?? ''} settings={data} onSaved={settings.reload} />

      <SettingsLabel>{`E-reader devices · ${data.ereaderDevices.length}`}</SettingsLabel>
      <Devices devices={data.ereaderDevices} onSaved={settings.reload} />
    </SettingsPanel>
  )
}

function TestSend({ settings, onSaved }: { settings: EmailSettings; onSaved: () => void }) {
  const { run, busy } = useAdminWrite()
  const [address, setAddress] = useState(settings.testAddress ?? '')
  const typed = address.trim()
  // The server sends to the saved address, and to the from address if none is saved.
  const canSend = Boolean(settings.host) && Boolean(typed || settings.fromAddress)

  return (
    <View style={{ gap: spacing.md }}>
      <AdminField
        label="Send the test to"
        placeholder={settings.fromAddress ?? 'you@example.com'}
        hint={settings.host ? undefined : 'Set up a mail server before sending a test.'}
        keyboardType="email-address"
        value={address}
        onChangeText={setAddress}
      />
      <AdminButton
        label="Send test"
        icon="send"
        kind="secondary"
        busy={busy}
        disabled={!canSend}
        onPress={() =>
          void run(
            async () => {
              if (typed !== (settings.testAddress ?? '')) await setTestAddress(typed || null)
              await sendTestEmail()
            },
            {
              done: 'Test email sent',
              failed: "The test didn't send. Check the mail server settings on the web.",
              reload: onSaved,
            },
          )
        }
      />
    </View>
  )
}

function Devices({ devices, onSaved }: { devices: EreaderDevice[]; onSaved: () => void }) {
  const colors = useColors()
  const { run, busy } = useAdminWrite()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const trimmedName = name.trim()
  const trimmedEmail = email.trim()
  // The server finds a device by its name when sending, so a repeat would be
  // unreachable.
  const taken = devices.some((d) => d.name === trimmedName)

  async function add() {
    const ok = await run(() => addEreaderDevice({ name: trimmedName, email: trimmedEmail }), {
      done: `Added ${trimmedName}`,
      failed: "Couldn't add that device.",
      reload: onSaved,
    })
    if (ok) {
      setName('')
      setEmail('')
    }
  }

  async function remove(device: EreaderDevice) {
    const yes = await confirm({
      title: 'Remove this device?',
      message: `People won't be able to send books to ${device.name} (${device.email}) anymore.`,
      confirmLabel: 'Remove',
    })
    if (!yes) return
    await run(() => removeEreaderDevice(device), {
      done: `Removed ${device.name}`,
      failed: "Couldn't remove that device.",
      reload: onSaved,
    })
  }

  return (
    <>
      {devices.length > 0 ? (
        <SettingsGroup>
          {devices.map((device, i) => (
            <SettingsRow
              key={`${device.name}-${device.email}`}
              icon="tablet"
              title={device.name}
              desc={device.email}
              control={
                <IconButton
                  name="delete"
                  size={22}
                  color={colors.textMuted}
                  accessibilityLabel={`Remove ${device.name}`}
                  onPress={() => void remove(device)}
                />
              }
              last={i === devices.length - 1}
            />
          ))}
        </SettingsGroup>
      ) : null}
      <AdminField
        label="Device name"
        placeholder="My e-reader"
        autoCapitalize="words"
        value={name}
        onChangeText={setName}
        error={taken ? 'A device already has this name.' : undefined}
      />
      <AdminField
        label="Device email"
        placeholder="device@example.com"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <AdminButton
        label="Add device"
        icon="add"
        kind="secondary"
        busy={busy}
        disabled={!trimmedName || !trimmedEmail.includes('@') || taken}
        onPress={() => void add()}
      />
    </>
  )
}
