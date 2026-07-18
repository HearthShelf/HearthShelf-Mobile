/**
 * My servers: every server this account has linked. Tap to switch (mint grant ->
 * ABS token -> session, via the connection provider so all sync state updates
 * together). A visible star per card sets the default server (the one a fresh
 * device auto-connects to, stored per account in the control plane so it follows
 * you to new devices). An "Add a library" row accepts an invite code (or a
 * pasted invite link) to join another library. Header comes from settings/_layout.
 */
import { useAuth } from '@clerk/expo'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import {
  fetchLinkedServers,
  setDefaultServer,
  clearDefaultServer,
  acceptInvite,
  ApiError,
  type LinkedServer,
} from '@/api/controlPlane'
import { useConnection } from '@/api/ConnectionProvider'
import { CLERK_JWT_TEMPLATE } from '@/lib/config'
import { AppText, Centered } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { showToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { spacing, radius, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { SettingsPanel } from '@/ui/settingsControls'

/** Pull the invite code out of a pasted app.hearthshelf.com/invite?token=...
 *  link, or accept a bare code (ABCD-1234) typed straight in. Casing and
 *  separators don't matter - the control plane normalizes before lookup. */
function inviteTokenFrom(raw: string): string | null {
  const s = raw.trim()
  if (!s) return null
  const m = s.match(/[?&]token=([^&\s]+)/)
  if (m) return decodeURIComponent(m[1])
  // A bare token (no URL): accept it if it looks like one (no spaces/slashes).
  return /^[\w.-]+$/.test(s) ? s : null
}

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
  const [linking, setLinking] = useState(false)
  const [linkInput, setLinkInput] = useState('')
  const [linkBusy, setLinkBusy] = useState(false)
  // The connected server, straight from the connection provider so it stays in
  // sync with reconnects rather than a one-time getSession() read.
  const activeName = serverName

  const tokenFn = useCallback(
    async (opts?: { forceRefresh?: boolean }) => {
      try {
        // skipCache forces a fresh JWT so a stale-token 401 can be retried before
        // the session-expired handler fires (see controlPlane.request).
        return await getToken({ template: CLERK_JWT_TEMPLATE, skipCache: opts?.forceRefresh })
      } catch {
        return null
      }
    },
    [getToken],
  )

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
    haptics.select()
    try {
      if (server.isDefault) {
        await clearDefaultServer(tokenFn, server.id)
        showToast('No default server')
      } else {
        await setDefaultServer(tokenFn, server.id)
        showToast(`Default: ${server.name}`)
      }
      await load({ silent: true })
    } catch {
      showToast('Could not update the default')
    }
  }

  async function linkServer() {
    const token = inviteTokenFrom(linkInput)
    if (!token) {
      showToast('Enter your invite code')
      return
    }
    setLinkBusy(true)
    try {
      await acceptInvite(tokenFn, token)
      haptics.success()
      setLinkInput('')
      setLinking(false)
      showToast('Library added')
      await load({ silent: true })
    } catch (err) {
      // An expired code, a used code, and a typo need different fixes - one
      // generic message for all three leaves the user with nothing to act on.
      if (err instanceof ApiError && err.status === 429) {
        showToast('Too many tries. Wait a bit and try again.')
      } else if (err instanceof ApiError && err.status === 404) {
        showToast("That code didn't work. Check it, or ask for a new one.")
      } else {
        showToast('Something went wrong. Check your connection and try again.')
      }
    } finally {
      setLinkBusy(false)
    }
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
          <AppText
            variant="caption"
            color={colors.textMuted}
            style={{ paddingHorizontal: spacing.xs }}
          >
            Tap a library to switch to it. Tap the star to pick the one new devices open first.
          </AppText>
          {servers.map((server) => {
            const active = server.name === activeName
            const busy = switchingId === server.id
            return (
              <Pressable
                key={server.id}
                onPress={() => switchTo(server)}
                disabled={busy}
                style={({ pressed }) => [styles.card, pressed && !active && styles.cardPressed]}
              >
                <View style={styles.tile}>
                  <Icon name={icons.server} size={24} color={colors.accent} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <AppText variant="label" numberOfLines={1}>
                    {server.name}
                  </AppText>
                  <AppText
                    variant="caption"
                    color={colors.textMuted}
                    numberOfLines={1}
                    style={{ marginTop: 2 }}
                  >
                    {active
                      ? 'Currently browsing'
                      : server.isDefault
                        ? 'Your default library'
                        : server.role === 'admin'
                          ? 'Admin'
                          : 'Member'}
                  </AppText>
                </View>
                {busy ? (
                  <ActivityIndicator color={colors.accent} />
                ) : (
                  <>
                    {active ? <Icon name="check-circle" size={22} color={colors.accent} /> : null}
                    {/* Visible default-star button (replaces the long-press secret). */}
                    <Pressable
                      onPress={() => void toggleDefault(server)}
                      hitSlop={10}
                      style={({ pressed }) => [styles.starBtn, pressed && styles.cardPressed]}
                    >
                      <Icon
                        name={server.isDefault ? 'star' : 'star-border'}
                        size={22}
                        color={server.isDefault ? colors.accent : colors.textMuted}
                      />
                    </Pressable>
                  </>
                )}
              </Pressable>
            )
          })}

          {/* Link a server from an invite link/code. */}
          {linking ? (
            <View style={styles.linkCard}>
              <AppText variant="label">Add a library</AppText>
              <AppText variant="caption" color={colors.textMuted}>
                Enter the invite code someone shared with you.
              </AppText>
              <TextInput
                value={linkInput}
                onChangeText={setLinkInput}
                placeholder="ABCD-1234"
                placeholderTextColor={colors.textFaint}
                style={styles.linkInput}
                autoCapitalize="characters"
                autoCorrect={false}
              />
              <View style={styles.linkActions}>
                <Pressable onPress={() => setLinking(false)} hitSlop={6}>
                  <AppText variant="label" color={colors.textMuted}>
                    Cancel
                  </AppText>
                </Pressable>
                <Pressable
                  onPress={() => void linkServer()}
                  disabled={linkBusy}
                  style={({ pressed }) => [styles.linkBtn, pressed && styles.cardPressed]}
                >
                  {linkBusy ? (
                    <ActivityIndicator size="small" color={colors.onAccent} />
                  ) : (
                    <AppText variant="label" color={colors.onAccent}>
                      Link
                    </AppText>
                  )}
                </Pressable>
              </View>
            </View>
          ) : (
            <Pressable
              onPress={() => setLinking(true)}
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
            >
              <View style={styles.tile}>
                <Icon name="add" size={24} color={colors.accent} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="label">Add a library</AppText>
                <AppText variant="caption" color={colors.textMuted} style={{ marginTop: 2 }}>
                  Join another library with an invite code.
                </AppText>
              </View>
              <Icon name="chevron-right" size={22} color={colors.textMuted} />
            </Pressable>
          )}
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
    tile: {
      width: 44,
      height: 44,
      borderRadius: radius.tile,
      backgroundColor: colors.elevated,
      alignItems: 'center',
      justifyContent: 'center',
    },
    starBtn: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
    },
    linkCard: {
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    linkInput: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: radius.row,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      color: colors.text,
      fontSize: 14,
    },
    linkActions: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: spacing.lg,
      marginTop: spacing.xs,
    },
    linkBtn: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
      minWidth: 72,
      alignItems: 'center',
    },
  })
