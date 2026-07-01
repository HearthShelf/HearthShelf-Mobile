/**
 * My servers: every server this account has linked, matching the DS mock
 * (dns tile, name/url/count, active check) plus real switch logic ported from
 * the Home connect flow (connectTo in app/(tabs)/index.tsx) - mint a grant,
 * exchange it for an ABS token, store the session, then bounce to Home so its
 * own connect() effect reloads shelves/stats for the new server.
 */
import { useAuth } from '@clerk/expo'
import { useCallback, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import { fetchLinkedServers, type LinkedServer } from '@/api/controlPlane'
import { getSession } from '@/api/session'
import { useConnection } from '@/api/ConnectionProvider'
import { CLERK_JWT_TEMPLATE } from '@/lib/config'
import { AppText, Centered, IconButton, Screen } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { colors, radius, spacing } from '@/ui/theme'

type Status = { phase: 'loading' } | { phase: 'error'; message: string } | { phase: 'ready' }

export default function ServersScreen() {
  const router = useRouter()
  const { getToken } = useAuth()
  const { connectTo } = useConnection()
  const [status, setStatus] = useState<Status>({ phase: 'loading' })
  const [servers, setServers] = useState<LinkedServer[]>([])
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const activeUrl = getSession()?.serverUrl

  const load = useCallback(async () => {
    setStatus({ phase: 'loading' })
    try {
      const token = async () => {
        try {
          return await getToken({ template: CLERK_JWT_TEMPLATE })
        } catch {
          return null
        }
      }
      const list = await fetchLinkedServers(token)
      setServers(list)
      setStatus({ phase: 'ready' })
    } catch (e) {
      setStatus({ phase: 'error', message: (e as Error).message })
    }
  }, [getToken])

  useEffect(() => {
    load()
  }, [load])

  async function switchTo(server: LinkedServer) {
    if (server.url === activeUrl) return
    setSwitchingId(server.id)
    // Delegate to the connection provider so the session, "last server" memory,
    // Auto bridge, queue sync, and the root gate's status all update together.
    // (Doing the handshake here directly would leave the provider's status stale,
    // so the boot gate wouldn't know the connection had recovered.)
    connectTo(server)
    router.replace('/(tabs)')
  }

  return (
    <Screen>
      <View style={styles.header}>
        <IconButton name={icons.back} onPress={() => router.back()} style={styles.headerBtn} />
        <AppText variant="title">Server settings</AppText>
      </View>

      {status.phase === 'loading' ? (
        <Centered>
          <ActivityIndicator color={colors.accent} />
        </Centered>
      ) : status.phase === 'error' ? (
        <Centered>
          <AppText variant="body" color={colors.textMuted}>
            Couldn't load your servers.
          </AppText>
          <Pressable onPress={load} style={{ marginTop: spacing.md }}>
            <AppText variant="label" color={colors.accent}>
              Retry
            </AppText>
          </Pressable>
        </Centered>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {servers.map((server) => {
            const active = server.url === activeUrl
            const busy = switchingId === server.id
            return (
              <Pressable
                key={server.id}
                onPress={() => switchTo(server)}
                disabled={active || busy}
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
                    {server.url} · {server.role === 'admin' ? 'Admin' : 'Member'}
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
        </ScrollView>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  headerBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: { padding: spacing.lg, paddingBottom: 140, gap: spacing.md },
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
})
