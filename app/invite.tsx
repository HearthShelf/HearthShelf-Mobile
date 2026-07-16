import { useAuth } from '@clerk/expo'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useConnection } from '@/api/ConnectionProvider'
import { setPendingInviteToken } from '@/api/session'
import { FlameLogo } from '@/ui/FlameLogo'
import { fonts } from '@/ui/theme'

/**
 * Landing for the invite universal link: app.hearthshelf.com/invite?token=...
 * (opened in-app via associated domains / App Links).
 *
 * A branded hearth moment (flame + "Opening your invitation") while we stash the
 * token and hand off. We do NOT redeem the token here - the connection flow does
 * (ConnectionProvider.runConnect() calls takePendingInviteToken() before listing
 * servers, links the invited server, connects into it). This one path works
 * whether the user is already signed in or has to sign in first (the token
 * persists across the sign-in redirect) and reuses the launch connect/splash.
 *
 * Flow:
 *  - Signed in: stash token, kick a reconnect, and the gate takes over.
 *  - Signed out: stash token; the AuthGate redirects to /sign-in, and the token
 *    is redeemed on the first connect after a successful sign-in.
 *  - No/empty token: a failed state ("ask for a new link"), no silent bounce.
 */
export default function InviteScreen() {
  const { token } = useLocalSearchParams<{ token?: string }>()
  const { isLoaded, isSignedIn } = useAuth()
  const { retry } = useConnection()
  const router = useRouter()
  const handled = useRef(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (handled.current) return
    // No token: the link is incomplete - show a failed state instead of a silent
    // bounce, so the user knows to ask for a fresh link.
    if (!token || !token.trim()) {
      handled.current = true
      setFailed(true)
      return
    }
    // Persist first so it survives a sign-in redirect / cold restart, then act.
    void (async () => {
      await setPendingInviteToken(token)
      if (!isLoaded) return // wait for Clerk; effect re-runs on isLoaded change
      handled.current = true
      if (isSignedIn) {
        retry()
        router.replace('/(tabs)')
      } else {
        router.replace('/sign-in')
      }
    })()
  }, [token, isLoaded, isSignedIn, retry, router])

  if (failed) {
    return (
      <View style={styles.bg}>
        <FlameLogo size={96} />
        <Text style={styles.title}>This invite link is incomplete</Text>
        <Text style={styles.text}>
          It's missing its code. Ask whoever shared it for a fresh link.
        </Text>
        <Pressable style={styles.button} onPress={() => router.replace('/(tabs)')}>
          <Text style={styles.buttonText}>Continue</Text>
        </Pressable>
      </View>
    )
  }

  return (
    <View style={styles.bg}>
      <FlameLogo size={120} />
      <Text style={styles.title}>Opening your invitation…</Text>
      <Text style={styles.text}>Warming the hearth and linking you up.</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  bg: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0e0d0c',
    gap: 14,
    paddingHorizontal: 40,
  },
  title: {
    color: '#f4f1ea',
    fontSize: 20,
    fontWeight: '700',
    fontFamily: fonts.sans,
    textAlign: 'center',
    marginTop: 8,
  },
  text: { color: '#aba498', fontSize: 14, fontFamily: fonts.sans, textAlign: 'center', lineHeight: 20 },
  button: {
    marginTop: 12,
    backgroundColor: '#e0654a',
    borderRadius: 16,
    paddingHorizontal: 28,
    paddingVertical: 13,
  },
  buttonText: { color: '#fffaf6', fontSize: 15, fontWeight: '700' },
})
