import { useSSO } from '@clerk/expo'
// The classic create()/setActive() useSignIn shape (the new signal-based
// useSignIn in @clerk/expo's root would require a flow rewrite; the email path
// here is a secondary fallback to the primary Google flow).
import { useSignIn } from '@clerk/expo/legacy'
import { useSignInWithGoogle } from '@clerk/expo/google'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import * as WebBrowser from 'expo-web-browser'
import { NATIVE_GOOGLE_ENABLED } from '@/lib/config'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'

// Required so the OAuth browser tab closes and hands control back to the app.
WebBrowser.maybeCompleteAuthSession()

/**
 * Clerk sign-in. Primary path is "Continue with Google":
 *   - When the Google client IDs are provisioned (NATIVE_GOOGLE_ENABLED), this
 *     uses Clerk's native Android Credential Manager account-picker sheet via
 *     useSignInWithGoogle() - one tap, no browser.
 *   - Otherwise it falls back to the browser-tab OAuth flow via useSSO().
 * Email/password is kept as a secondary fallback. Either way the result is a
 * real Clerk session, which the control plane verifies for the grant ->
 * /hs/hosted/connect -> ABS token handshake.
 */
export default function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn()
  const { startSSOFlow } = useSSO()
  const { startGoogleAuthenticationFlow } = useSignInWithGoogle()
  const router = useRouter()
  const { reason } = useLocalSearchParams<{ reason?: string }>()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(
    reason === 'expired' ? 'Your session expired. Please sign in again.' : null,
  )

  // Warm up the browser on Android so the OAuth tab opens snappily.
  useEffect(() => {
    void WebBrowser.warmUpAsync()
    return () => {
      void WebBrowser.coolDownAsync()
    }
  }, [])

  async function onGoogle() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      // Native account-picker sheet (Android Credential Manager) when the
      // Google client IDs are provisioned; otherwise the browser-tab OAuth flow.
      const { createdSessionId, setActive: flowSetActive } = NATIVE_GOOGLE_ENABLED
        ? await startGoogleAuthenticationFlow()
        : // Let useSSO build its own redirect (scheme + 'sso-callback' path) so
          // it matches Clerk's native flow exactly. Passing a custom one (e.g.
          // '/home') caused a redirect-url mismatch. The value to allowlist in
          // the Clerk dashboard is `hearthshelf://sso-callback`.
          await startSSOFlow({ strategy: 'oauth_google' })

      if (createdSessionId && flowSetActive) {
        await flowSetActive({ session: createdSessionId })
        router.replace('/(tabs)')
      } else {
        // No session usually means the user cancelled the picker / browser flow.
        setError('Google sign-in did not complete')
      }
    } catch (e) {
      const msg =
        (e as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message ||
        (e as Error).message ||
        'Google sign-in failed'
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  async function onSignIn() {
    if (!isLoaded || busy) return
    setBusy(true)
    setError(null)
    try {
      const attempt = await signIn.create({ identifier: email, password })
      if (attempt.status === 'complete') {
        await setActive({ session: attempt.createdSessionId })
        router.replace('/(tabs)')
      } else {
        // e.g. needs 2FA / email code - out of scope for the spike.
        setError(`Sign-in needs another step: ${attempt.status}`)
      }
    } catch (e) {
      const msg =
        (e as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message ||
        (e as Error).message ||
        'Sign-in failed'
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <Text style={styles.brand}>HearthShelf</Text>
      <Text style={styles.subtitle}>Sign in to app.hearthshelf.com</Text>

      <TouchableOpacity style={styles.google} onPress={onGoogle} disabled={busy}>
        {busy ? (
          <ActivityIndicator color="#1f1b18" />
        ) : (
          <Text style={styles.googleText}>Continue with Google</Text>
        )}
      </TouchableOpacity>

      <View style={styles.dividerRow}>
        <View style={styles.divider} />
        <Text style={styles.dividerText}>or</Text>
        <View style={styles.divider} />
      </View>

      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor="#888"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor="#888"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <TouchableOpacity style={styles.button} onPress={onSignIn} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Sign in</Text>}
      </TouchableOpacity>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#14110f',
    padding: 24,
    justifyContent: 'center',
  },
  brand: { color: '#f3e9dd', fontSize: 32, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: '#a99', fontSize: 14, textAlign: 'center', marginBottom: 28 },
  input: {
    backgroundColor: '#221d19',
    color: '#f3e9dd',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    marginBottom: 12,
  },
  button: {
    backgroundColor: '#c4633a',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: '#e88', marginBottom: 8 },
  google: {
    backgroundColor: '#f3e9dd',
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 4,
  },
  googleText: { color: '#1f1b18', fontSize: 16, fontWeight: '600' },
  dividerRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 16 },
  divider: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: '#3a322c' },
  dividerText: { color: '#a99', fontSize: 13 },
})
