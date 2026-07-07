/**
 * Integrations panel: connect other services and import your reading history.
 *
 * Cards, top to bottom: Hardcover (connect / sync / disconnect), Import from
 * Goodreads (its own card, opens a bottom sheet), Server integrations (info -
 * RMAB etc. are set up server-side by an admin), and External book links (which
 * store search links show on a book's detail page).
 *
 * This replaces the old "Connections" panel; the search toggle moved to
 * app/settings/search.tsx and the social toggles to app/settings/community.tsx.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, TextInput, View } from 'react-native'
import type { BottomSheetModal } from '@gorhom/bottom-sheet'
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
import { GoodreadsImportSheet } from '@/settings/GoodreadsImportSheet'
import {
  connectHardcover,
  disconnectHardcover,
  getHardcoverAccount,
  triggerHardcoverSync,
  type HardcoverAccountStatus,
} from '@/api/finishedBooks'

export default function IntegrationsPanel() {
  const colors = useColors()
  const importSheet = useRef<BottomSheetModal>(null)
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
  const externalLinkGoodreads = useSyncExternalStore(
    subscribeSettings,
    () => getSettingsState().externalLinkGoodreads,
  )
  const externalLinkAudible = useSyncExternalStore(
    subscribeSettings,
    () => getSettingsState().externalLinkAudible,
  )
  const externalLinkHardcover = useSyncExternalStore(
    subscribeSettings,
    () => getSettingsState().externalLinkHardcover,
  )

  return (
    <SettingsPanel>
      <SettingsLabel>Services</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          icon="link"
          title="Hardcover"
          desc={
            connected
              ? `Connected as ${status?.username ?? 'your Hardcover account'}.`
              : 'Sync the books you finish here to your Hardcover reading history.'
          }
          last
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
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          icon="upload-file"
          title="Import from Goodreads"
          desc="Upload your Goodreads export CSV to bring in your reading history."
          onPress={() => importSheet.current?.present()}
          last
        />
      </SettingsGroup>

      <SettingsGroup>
        <SettingsRow
          icon="dns"
          title="Server integrations"
          desc="ReadMeABook and similar integrations are set up by your server admin under Server Admin on the server itself."
          last
        />
      </SettingsGroup>

      <SettingsLabel>External book links</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          icon="menu-book"
          title="Goodreads"
          desc="Show a Goodreads search link on each book's detail page."
          control={
            <SettingsToggle
              on={externalLinkGoodreads}
              onChange={(v) => setSetting('externalLinkGoodreads', v)}
            />
          }
        />
        <SettingsRow
          icon="headphones"
          title="Audible"
          desc="Show an Audible search link on each book's detail page."
          control={
            <SettingsToggle
              on={externalLinkAudible}
              onChange={(v) => setSetting('externalLinkAudible', v)}
            />
          }
        />
        <SettingsRow
          icon="auto-stories"
          title="Hardcover"
          desc="Show a Hardcover search link on each book's detail page."
          control={
            <SettingsToggle
              on={externalLinkHardcover}
              onChange={(v) => setSetting('externalLinkHardcover', v)}
            />
          }
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

      <GoodreadsImportSheet ref={importSheet} />
    </SettingsPanel>
  )
}
