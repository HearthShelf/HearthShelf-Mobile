/**
 * My servers: every server this account has linked. Tap to switch (mint grant ->
 * ABS token -> session, via the connection provider so all sync state updates
 * together). Long-press for the default-server action: the account default is the
 * server a fresh device auto-connects to (see ConnectionProvider), stored per
 * account in the control plane, so it follows you to new devices. Header comes
 * from settings/_layout.
 */
import { useAuth } from '@clerk/expo'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import {
  fetchLinkedServers,
  setDefaultServer,
  clearDefaultServer,
  type LinkedServer,
} from '@/api/controlPlane'
import { useConnection } from '@/api/ConnectionProvider'
import { CLERK_JWT_TEMPLATE } from '@/lib/config'
import { AppText, Centered } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { spacing, radius, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { SettingsPanel } from '@/ui/settingsControls'

type Status = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready' }

export default function ServersScreen() {
  const router = useRouter()
  const { getToken } = useAuth()
  const { connectTo, serverName } = useConnection()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const [status, setStatus] = useState<Status>({ phase: 'loading' })
  const [servers, setServers] = useState<LinkedServer[]>([])
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  // The connected server, straight from the connection provider so it stays in
  // sync with reconnects rather than a one-time getSession() read.
  const activeName = serverName

  const tokenFn = useCallback(async () => {
    try {
      return await getToken({ template: CLERK_JWT_TEMPLATE })
    } catch {
      return null
    }
  }, [getToken])

  // `silent` refreshes the list in place (e.g. after toggling a default) without
  // flashing the spinner over an already-populated list.
  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!opts?.silent) setStatus((s) => (s.phase === 'ready' ? s : { phase: 'loading' }))
      try {
        const list = await fetchLinkedServers(tokenFn)
        setServers(list)
        setStatus({ phase: 'ready' })
      } catch (e) {
        setStatus({ phase: 'error', message: (e as Error).message })
      }
    },
    [tokenFn],
  )

  useEffect(() => {
    void load()
  }, [load])

  async function switchTo(server: LinkedServer) {
    if (server.name === activeName || switchingId) return
    setSwitchingId(server.id)
    try {
      // Await the reconnect so we only leave settings once the session actually
      // points at the new server; the connection gate covers the reconnect.
      await connectTo(server)
      router.replace('/(tabs)')
    } catch {
      Alert.alert('Could not switch server', 'Please try again.')
    } finally {
      setSwitchingId(null)
    }
  }

  async function toggleDefault(server: LinkedServer) {
    try {
      if (server.isDefault) await clearDefaultServer(tokenFn, server.id)
      else await setDefaultServer(tokenFn, server.id)
      await load({ silent: true })
    } catch {
      Alert.alert('Could not update default', 'Please try again.')
    }
  }

  function onLongPress(server: LinkedServer) {
    Alert.alert(
      server.name,
      server.isDefault
        ? 'This is your default server - a new device opens here.'
        : 'Make this the server a new device opens to?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: server.isDefault ? 'Remove as default' : 'Make default',
          onPress: () => void toggleDefault(server),
        },
      ],
    )
  }

  return (
    <SettingsPanel>
      {status.phase === 'loading' ? (
        <Centered>
          <ActivityIndicator color={colors.accent} />
        </Centered>
      ) : status.phase === 'error' ? (
        <Centered>
          <AppText variant="body" color={colors.textMuted}>
            Couldn't load your servers.
          </AppText>
          <Pressable onPress={() => void load()} style={{ marginTop: spacing.md }}>
            <AppText variant="label" color={colors.accent}>
              Retry
            </AppText>
          </Pressable>
        </Centered>
      ) : (
        <>
          <AppText variant="caption" color={colors.textMuted} style={{ paddingHorizontal: spacing.xs }}>
            Tap to switch. Long-press to set the server new devices open to.
          </AppText>
          {servers.map((server) => {
            const active = server.name === activeName
            const busy = switchingId === server.id
            return (
              <Pressable
                key={server.id}
                onPress={() => switchTo(server)}
                onLongPress={() => onLongPress(server)}
                disabled={busy}
                style={({ pressed }) => [styles.card, pressed && !active && styles.cardPressed]}
              >
                <View style={styles.tile}>
                  <Icon name={icons.server} size={24} color={colors.accent} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={styles.nameRow}>
                    <AppText variant="label" numberOfLines={1}>
                      {server.name}
                    </AppText>
                    {server.isDefault ? <Icon name="star" size={15} color={colors.accent} /> : null}
                  </View>
                  <AppText variant="caption" color={colors.textMuted} numberOfLines={1} style={{ marginTop: 2 }}>
                    {active ? 'Currently browsing' : server.isDefault ? 'Your default library' : server.role === 'admin' ? 'Admin' : 'Member'}
                  </AppText>
                </View>
                {busy ? (
                  <ActivityIndicator color={colors.accent} />
                ) : active ? (
                  <Icon name="check-circle" size={24} color={colors.accent} />
                ) : null}
              </Pressable>
            )
          })}
        </>
      )}
    </SettingsPanel>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    cardPressed: { opacity: 0.7 },
    nameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    tile: {
      width: 44,
      height: 44,
      borderRadius: radius.tile,
      backgroundColor: colors.elevated,
      alignItems: 'center',
      justifyContent: 'center',
    },
  })
