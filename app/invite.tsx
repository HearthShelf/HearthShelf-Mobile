import { useAuth } from '@clerk/expo'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef } from 'react'
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { useConnection } from '@/api/ConnectionProvider'
import { setPendingInviteToken } from '@/api/session'
import { fonts } from '@/ui/theme'

/**
 * Landing for the invite universal link: app.hearthshelf.com/invite?token=...
 * (opened in-app via associated domains / App Links).
 *
 * We do NOT redeem the token here. We stash it, then let the connection flow
 * redeem it: ConnectionProvider.runConnect() calls takePendingInviteToken()
 * before listing servers, links the invited server, and connects straight into
 * it. This one path works whether the user is already signed in or has to sign
 * in first (the token persists across the sign-in redirect), and it reuses the
 * same connect/splash machinery as a normal launch.
 *
 * Flow:
 *  - Signed in: stash token, kick a reconnect (retry), and the gate takes over.
 *  - Signed out: stash token; the root AuthGate redirects to /sign-in, and the
 *    token is redeemed on the first connect after a successful sign-in.
 */
export default function InviteScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>()
  const { isLoaded, isSignedIn } = useAuth()
  const { retry } = useConnection()
  const router = useRouter()
  const handled = useRef(false)

  useEffect(() => {
    if (handled.current) return
    // No token: nothing to accept, just get out of the way.
    if (!token) {
      handled.current = true
      router.replace('/(tabs)')
      return
    }
    // Persist first so it survives a sign-in redirect / cold restart, then act.
    void (async () => {
      await setPendingInviteToken(token)
      if (!isLoaded) return // wait for Clerk; effect re-runs on isLoaded change
      handled.current = true
      if (isSignedIn) {
        // Already signed in: re-run connect, which redeems the token and jumps
        // into the invited server. Land on tabs; the gate covers with the splash
        // until the connection is ready.
        retry()
        router.replace('/(tabs)')
      } else {
        // Signed out: the AuthGate will bounce to /sign-in. The token waits in
        // SecureStore and is redeemed on the first post-sign-in connect.
        router.replace('/sign-in')
      }
    })()
  }, [token, isLoaded, isSignedIn, retry, router])

  return (
    <View style={styles.bg}>
      <ActivityIndicator color="#bd863f" />
      <Text style={styles.text}>Opening your invitation...</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  bg: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0e0d0c', gap: 14 },
  text: { color: '#aba498', fontSize: 14, fontFamily: fonts.sans },
})
