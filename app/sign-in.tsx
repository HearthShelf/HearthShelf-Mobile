import { useSSO } from '@clerk/expo'
// The classic create()/setActive() useSignIn shape (the new signal-based
// useSignIn in @clerk/expo's root would require a flow rewrite; the email path
// here is a secondary fallback to the primary Google flow).
import { useSignIn } from '@clerk/expo/legacy'
import { useSignInWithGoogle } from '@clerk/expo/google'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import * as WebBrowser from 'expo-web-browser'
import Svg, { Path } from 'react-native-svg'
import { NATIVE_GOOGLE_ENABLED } from '@/lib/config'
import { fonts } from '@/ui/theme'
import {
  ActivityIndicator,
  Image,
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

// Brand marks rendered inline so no extra image assets are needed.
function GoogleLogo() {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24">
      <Path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
      />
      <Path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <Path
        fill="#FBBC05"
        d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"
      />
      <Path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z"
      />
    </Svg>
  )
}

function DiscordLogo() {
  return (
    <Svg width={20} height={20} viewBox="0 0 127.14 96.36" fill="#fff">
      <Path d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z" />
    </Svg>
  )
}

/**
 * Clerk sign-in. Primary path is "Continue with Google":
 *   - When the Google client IDs are provisioned (NATIVE_GOOGLE_ENABLED), this
 *     uses Clerk's native Android Credential Manager account-picker sheet via
 *     useSignInWithGoogle() - one tap, no browser.
 *   - Otherwise it falls back to the browser-tab OAuth flow via useSSO().
 * "Continue with Discord" always uses the browser-tab OAuth flow - Clerk has no
 * native Discord hook, so there is no account-picker sheet for it on any
 * platform.
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
  const [emailMode, setEmailMode] = useState(false)
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

  // Completes a flow that returns a created session id + its own setActive
  // (both the native Google hook and useSSO share this shape). `label` is only
  // used to phrase the "did not complete" / failure messages.
  async function completeFlow(
    label: string,
    run: () => Promise<{
      createdSessionId?: string | null
      setActive?: (opts: { session: string }) => Promise<unknown>
    }>,
  ) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const { createdSessionId, setActive: flowSetActive } = await run()
      if (createdSessionId && flowSetActive) {
        await flowSetActive({ session: createdSessionId })
        router.replace('/(tabs)')
      } else {
        // No session usually means the user cancelled the picker / browser flow.
        setError(`${label} sign-in did not complete`)
      }
    } catch (e) {
      const msg =
        (e as { errors?: Array<{ message?: string }> })?.errors?.[0]?.message ||
        (e as Error).message ||
        `${label} sign-in failed`
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  function onGoogle() {
    // Native account-picker sheet (Android Credential Manager / iOS
    // ASAuthorization) when the Google client IDs are provisioned; otherwise
    // the browser-tab OAuth flow.
    //
    // Let useSSO build its own redirect (scheme + 'sso-callback' path) so it
    // matches Clerk's native flow exactly. Passing a custom one (e.g. '/home')
    // caused a redirect-url mismatch. The value to allowlist in the Clerk
    // dashboard is `hearthshelf://sso-callback`.
    return completeFlow('Google', () =>
      NATIVE_GOOGLE_ENABLED
        ? startGoogleAuthenticationFlow()
        : startSSOFlow({ strategy: 'oauth_google' }),
    )
  }

  function onDiscord() {
    // Discord has no native Clerk hook - always the browser-tab OAuth flow.
    return completeFlow('Discord', () => startSSOFlow({ strategy: 'oauth_discord' }))
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
    <View style={styles.bg}>
      <Image
        source={require('@/../assets/images/hearth-centered.webp')}
        style={styles.bgImage}
        resizeMode="cover"
      />
      <KeyboardAvoidingView
        style={styles.content}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.hero}>
          <Text style={styles.brand}>
            <Text style={styles.brandHearth}>Hearth</Text>
            <Text style={styles.brandShelf}>Shelf</Text>
          </Text>
        </View>
        <View style={styles.spacer} />

        <View style={styles.authBlock}>
          {emailMode ? (
            <View style={styles.formCard}>
              <TextInput
                style={styles.input}
                placeholder="Email"
                placeholderTextColor="#6f6557"
                autoCapitalize="none"
                keyboardType="email-address"
                value={email}
                onChangeText={setEmail}
              />
              <TextInput
                style={styles.input}
                placeholder="Password"
                placeholderTextColor="#6f6557"
                secureTextEntry
                value={password}
                onChangeText={setPassword}
              />

              {error ? <Text style={styles.error}>{error}</Text> : null}

              <TouchableOpacity style={styles.primaryButton} onPress={onSignIn} disabled={busy}>
                {busy ? (
                  <ActivityIndicator color="#fffaf6" />
                ) : (
                  <Text style={styles.primaryButtonText}>Sign in</Text>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.backLink}
                onPress={() => {
                  setEmailMode(false)
                  setError(null)
                }}
                disabled={busy}
              >
                <Text style={styles.backLinkText}>Back to all sign-in options</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.providers}>
              <TouchableOpacity style={styles.google} onPress={onGoogle} disabled={busy}>
                {busy ? (
                  <ActivityIndicator color="#1f1f1f" />
                ) : (
                  <>
                    <GoogleLogo />
                    <Text style={styles.googleText}>Continue with Google</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity style={styles.discord} onPress={onDiscord} disabled={busy}>
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <>
                    <DiscordLogo />
                    <Text style={styles.discordText}>Continue with Discord</Text>
                  </>
                )}
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.emailButton}
                onPress={() => setEmailMode(true)}
                disabled={busy}
              >
                <Text style={styles.emailButtonText}>Sign in with email</Text>
              </TouchableOpacity>

              {error ? <Text style={styles.error}>{error}</Text> : null}
            </View>
          )}

          <Text style={styles.footer}>
            By continuing you agree to the{'\n'}Terms & Privacy Policy
          </Text>
        </View>
      </KeyboardAvoidingView>
    </View>
  )
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: '#0e0d0c' },
  bgImage: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    width: '100%',
    height: '100%',
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(13,11,9,0.72)',
  },
  content: {
    flex: 1,
    paddingHorizontal: 30,
    paddingBottom: 40,
  },
  hero: { height: 300, alignItems: 'center', justifyContent: 'center' },
  spacer: { flex: 1 },
  authBlock: {},
  logoBadge: {
    width: 88,
    height: 88,
    borderRadius: 26,
    backgroundColor: 'rgba(189,134,63,0.20)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoImg: { width: 54, height: 54 },
  brand: { marginTop: 26, fontSize: 34, textAlign: 'center', fontFamily: fonts.brand },
  brandHearth: { color: '#bd863f', fontFamily: fonts.brand },
  brandShelf: { color: '#f0e6d6', fontFamily: fonts.brand, fontWeight: '700' },

  providers: { gap: 12 },
  google: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingVertical: 15,
  },
  googleText: { color: '#1f1f1f', fontSize: 15, fontWeight: '600' },
  discord: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: '#5865F2',
    borderRadius: 16,
    paddingVertical: 15,
  },
  discordText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  emailButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: '#383530',
    backgroundColor: 'transparent',
  },
  emailButtonText: { color: '#f4f1ea', fontSize: 14.5, fontWeight: '600' },

  formCard: { gap: 12 },
  input: {
    backgroundColor: 'rgba(42,40,37,0.85)',
    color: '#f4f1ea',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#383530',
    paddingHorizontal: 16,
    paddingVertical: 15,
    fontSize: 15,
  },
  primaryButton: {
    backgroundColor: '#e0654a',
    borderRadius: 16,
    paddingVertical: 15,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#fffaf6', fontSize: 15, fontWeight: '700' },
  backLink: {
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#383530',
    backgroundColor: 'transparent',
  },
  backLinkText: { color: '#aba498', fontSize: 13.5, fontWeight: '600' },

  error: { color: '#e0654a', fontSize: 13, textAlign: 'center' },
  footer: {
    textAlign: 'center',
    color: '#aba498',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 22,
  },
})
