import { useAuth } from '@/auth/useAuth'
import { useRouter } from 'expo-router'
import { useEffect } from 'react'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import * as WebBrowser from 'expo-web-browser'

// Close any lingering auth browser session the moment this module loads, in case
// the redirect reached the router instead of being swallowed in-place.
WebBrowser.maybeCompleteAuthSession()

/**
 * Catches the `hearthshelf://sso-callback` OAuth redirect.
 *
 * Most of the time the browser-tab flow resolves in-place and this route is
 * never navigated to. But some provider flows do an extra transfer hop whose
 * second redirect the OS delivers to expo-router as a real deep link - without
 * this route that lands on "Unmatched Route". The session is already being
 * established by the auth client, so this screen does no auth work: it just
 * catches the URL and hands control back, routing to the tabs (signed in) or
 * sign-in once the session resolves.
 */
export default function SSOCallbackScreen() {
  const { isLoaded, isSignedIn } = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (!isLoaded) return
    router.replace(isSignedIn ? '/(tabs)' : '/sign-in')
  }, [isLoaded, isSignedIn, router])

  return (
    <View style={styles.bg}>
      <ActivityIndicator color="#bd863f" />
    </View>
  )
}

// Same fixed ink as sign-in (app/sign-in.tsx INK) - a mid-OAuth interstitial
// that returns to that screen; theming it would flash light between two dark
// frames.
const styles = StyleSheet.create({
  bg: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0e0d0c' },
})
