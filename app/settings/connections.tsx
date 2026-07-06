import { useEffect, useState, useSyncExternalStore } from 'react'
import { Pressable, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import {
  SettingsPanel,
  SettingsGroup,
  SettingsLabel,
  SettingsRow,
  SettingsToggle,
} from '@/ui/settingsControls'
import { AppText } from '@/ui/primitives'
import { spacing } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { getSettingsState, subscribeSettings, setSetting } from '@/store/settings'
import {
  connectHardcover,
  disconnectHardcover,
  getHardcoverAccount,
  triggerHardcoverSync,
  type HardcoverAccountStatus,
} from '@/api/finishedBooks'

export default function ConnectionsPanel() {
  const router = useRouter()
  const colors = useColors()
  const [status, setStatus] = useState<HardcoverAccountStatus | null>(null)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = () => {
    getHardcoverAccount()
      .then(setStatus)
      .catch(() => setStatus(null))
  }

  useEffect(load, [])

  async function connect() {
    if (!token.trim()) return
    setBusy(true)
    setMessage(null)
    try {
      setStatus(await connectHardcover(token.trim()))
      setToken('')
      setMessage('Hardcover connected')
    } catch {
      setMessage('Could not connect Hardcover')
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    setBusy(true)
    setMessage(null)
    try {
      await disconnectHardcover()
      setStatus({
        connected: false,
        username: null,
        lastSyncAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
      })
      setMessage('Hardcover disconnected')
    } catch {
      setMessage('Could not disconnect Hardcover')
    } finally {
      setBusy(false)
    }
  }

  async function sync() {
    setBusy(true)
    setMessage(null)
    try {
      const result = await triggerHardcoverSync()
      load()
      setMessage(`Synced ${result.synced} book${result.synced === 1 ? '' : 's'}`)
    } catch {
      setMessage('Hardcover sync failed')
    } finally {
      setBusy(false)
    }
  }

  const connected = status?.connected === true
  const searchExternalSources = useSyncExternalStore(
    subscribeSettings,
    () => getSettingsState().searchExternalSources,
  )

  return (
    <SettingsPanel>
      <SettingsLabel>Search</SettingsLabel>
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
      <SettingsGroup>
        <SettingsRow
          icon="link"
          title="Hardcover"
          desc={
            connected
              ? `Connected as ${status?.username ?? 'your Hardcover account'}.`
              : 'Sync finished books to your Hardcover reading history.'
          }
        />
        {!connected ? (
          <View
            style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.sm }}
          >
            <TextInput
              value={token}
              onChangeText={setToken}
              placeholder="Paste your Hardcover API token"
              placeholderTextColor={colors.textFaint}
              secureTextEntry
              autoCapitalize="none"
              style={{
                color: colors.text,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 10,
                padding: spacing.sm,
              }}
            />
            <Pressable onPress={() => void connect()} disabled={busy || !token.trim()}>
              <AppText variant="label" color={colors.accent}>
                {busy ? 'Connecting...' : 'Connect'}
              </AppText>
            </Pressable>
          </View>
        ) : (
          <View
            style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.sm }}
          >
            {status?.lastSyncAt ? (
              <AppText variant="caption" color={colors.textMuted}>
                Last synced {new Date(status.lastSyncAt).toLocaleString()}
                {status.lastSyncStatus === 'error' && status.lastSyncError
                  ? ` (${status.lastSyncError})`
                  : ''}
              </AppText>
            ) : null}
            <View style={{ flexDirection: 'row', gap: spacing.lg }}>
              <Pressable onPress={() => void sync()} disabled={busy}>
                <AppText variant="label" color={colors.accent}>
                  {busy ? 'Working...' : 'Sync now'}
                </AppText>
              </Pressable>
              <Pressable onPress={() => void disconnect()} disabled={busy}>
                <AppText variant="label" color={colors.textMuted}>
                  Disconnect
                </AppText>
              </Pressable>
            </View>
          </View>
        )}
        <SettingsRow
          icon="upload-file"
          title="Import from Goodreads"
          desc="Paste a Goodreads CSV export and review matches before importing."
          onPress={() => router.push('/settings/import-goodreads')}
        />
        <SettingsRow
          icon="hub"
          title="External book links"
          desc="Goodreads, Audible, and Hardcover search links are managed by your server admin."
          last
        />
      </SettingsGroup>
      {message ? (
        <AppText
          variant="caption"
          color={colors.textMuted}
          style={{ paddingHorizontal: spacing.xs }}
        >
          {message}
        </AppText>
      ) : null}
    </SettingsPanel>
  )
}
