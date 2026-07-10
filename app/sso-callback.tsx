import { useAuth } from '@clerk/expo'
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
 * For a returning user the browser-tab flow resolves in-place (useSSO's promise)
 * and this route is never navigated to. A NEW user's sign-up does an extra
 * transfer hop whose second redirect the OS delivers to expo-router as a real
 * deep link - without this route that lands on "Unmatched Route". The session is
 * already being established by the in-memory startSSOFlow promise back on the
 * sign-in screen (which calls setActive), so this screen does no auth work: it
 * just exists to catch the URL and hand control back. The root AuthGate then
 * routes to the tabs (signed in) or sign-in, so we send everyone to '/' and let
 * it decide.
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

const styles = StyleSheet.create({
  bg: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0e0d0c' },
})
