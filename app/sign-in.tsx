import type { SetActive, SignUpResource } from '@clerk/shared/types'
import { useSSO } from '@clerk/expo'
// The classic create()/setActive() useSignIn shape (the new signal-based
// useSignIn in @clerk/expo's root would require a flow rewrite; the email path
// here is a secondary fallback to the primary Google flow).
import { useSignIn, useSignUp } from '@clerk/expo/legacy'
import { useSignInWithGoogle } from '@clerk/expo/google'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useEffect, useState } from 'react'
import * as WebBrowser from 'expo-web-browser'
import { LinearGradient } from 'expo-linear-gradient'
import Svg, { Path } from 'react-native-svg'
import { APPLE_ENABLED, CLERK_PUBLISHABLE_KEY, NATIVE_GOOGLE_ENABLED } from '@/lib/config'
import { fonts } from '@/ui/theme'
import { MaterialIcons } from '@expo/vector-icons'
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'

// Required so the OAuth browser tab closes and hands control back to the app.
WebBrowser.maybeCompleteAuthSession()

// The sign-in screen is intentionally DARK regardless of the app theme (it's a
// brand moment over the hearth photo, before the theme system is even in play),
// so it uses a fixed ink palette rather than useColors(). Centralized here so
// there are no scattered magic hexes. Values mirror the brand tokens in theme.ts.
const INK = {
  bg: '#0e0d0c',
  hearth: '#bd863f',
  shelf: '#f0e6d6',
  accent: '#e0654a',
  onAccent: '#fffaf6',
  text: '#f4f1ea',
  muted: '#aba498',
  faint: '#6f6557',
  line: '#383530',
  field: 'rgba(42,40,37,0.85)',
  glass: 'rgba(28,26,23,0.6)',
  dangerBg: 'rgba(224,101,74,0.16)',
}

// The Clerk account-portal origin, decoded from the publishable key's frontend
// API domain (pk_live_<base64("clerk.example.com$")>). Used for the hosted
// forgot-password flow, which Clerk owns.
function accountPortalUrl(path: string): string {
  try {
    const b64 = CLERK_PUBLISHABLE_KEY.replace(/^pk_(test|live)_/, '')
    // atob isn't in RN; decode base64 manually via Buffer-free approach.
    const decoded = decodeBase64(b64).replace(/\$$/, '') // "clerk.hearthshelf.com"
    const domain = decoded.replace(/^clerk\./, '') // "hearthshelf.com"
    return `https://accounts.${domain}${path}`
  } catch {
    return `https://accounts.hearthshelf.com${path}`
  }
}

function decodeBase64(input: string): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let str = input.replace(/=+$/, '')
  let output = ''
  for (let bc = 0, bs = 0, buffer, i = 0; (buffer = str.charAt(i++)); ) {
    buffer = chars.indexOf(buffer)
    if (buffer === -1) continue
    bs = bc % 4 ? bs * 64 + buffer : buffer
    if (bc++ % 4) output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)))
  }
  return output
}

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

function AppleLogo() {
  return (
    <Svg width={20} height={20} viewBox="0 0 24 24" fill="#fff">
      <Path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
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
 * Clerk sign-in. Primary path is "Continue with Google" (see completeFlow).
 * Email/password is a full secondary flow: sign-in, a real second-factor code
 * step when the account has 2FA, a hosted forgot-password link, and the OAuth
 * "choose a username" step for new Apple/Google users.
 *
 * Bottom-aligned auth block over the hearth photo (thumb zone), wordmark in the
 * upper third, a bottom scrim for legibility. The screen stays dark by design.
 */
export default function SignInScreen() {
  const { signIn, setActive, isLoaded } = useSignIn()
  const { signUp, setActive: setActiveSignUp, isLoaded: signUpLoaded } = useSignUp()
  const { startSSOFlow } = useSSO()
  const { startGoogleAuthenticationFlow } = useSignInWithGoogle()
  const router = useRouter()
  const { reason } = useLocalSearchParams<{ reason?: string }>()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [emailMode, setEmailMode] = useState(false)
  // Within emailMode, whether we're registering a new account rather than
  // signing in to an existing one.
  const [signUpMode, setSignUpMode] = useState(false)
  // A created-but-unverified sign-up: Clerk has emailed a 6-digit code and we
  // collect it here before the account (and session) exist.
  const [verifyingSignUp, setVerifyingSignUp] = useState(false)
  const [busy, setBusy] = useState(false)
  // A pending second-factor challenge: after signIn.create returns
  // needs_second_factor, we collect the code here and attempt it.
  const [twoFactor, setTwoFactor] = useState(false)
  const [code, setCode] = useState('')
  // When an OAuth sign-up completes everything except a required username, we
  // hold the in-progress sign-up here and show the "choose a username" step.
  const [pendingSignUp, setPendingSignUp] = useState<SignUpResource | null>(null)
  const [pendingSetActive, setPendingSetActive] = useState<SetActive | null>(null)
  const [username, setUsername] = useState('')
  const [error, setError] = useState<string | null>(
    reason === 'expired' ? 'Your session expired. Please sign in again.' : null,
  )

  useEffect(() => {
    void WebBrowser.warmUpAsync()
    return () => {
      void WebBrowser.coolDownAsync()
    }
  }, [])

  async function completeFlow(
    label: string,
    run: () => Promise<{
      createdSessionId?: string | null
      setActive?: SetActive
      signIn?: { createdSessionId?: string | null } | null
      signUp?: SignUpResource | null
      authSessionResult?: { type?: string } | null
    }>,
  ) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await run()
      const flowSetActive = res.setActive
      const sessionId =
        res.createdSessionId || res.signUp?.createdSessionId || res.signIn?.createdSessionId
      if (sessionId && flowSetActive) {
        await flowSetActive({ session: sessionId })
        router.replace('/(tabs)')
        return
      }

      const su = res.signUp
      const usernameOutstanding =
        !!su &&
        !su.createdSessionId &&
        !su.username &&
        (su.missingFields.includes('username') || su.requiredFields.includes('username'))
      if (su && usernameOutstanding && flowSetActive) {
        setPendingSignUp(su)
        setPendingSetActive(() => flowSetActive)
        setUsername(su.emailAddress ? su.emailAddress.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '') : '')
        return
      }

      if (res.authSessionResult && res.authSessionResult.type !== 'success') {
        setError(`${label} sign-in was cancelled`)
      } else {
        setError(`${label} sign-in did not complete`)
      }
    } catch (e) {
      setError(clerkMessage(e, `${label} sign-in failed`))
    } finally {
      setBusy(false)
    }
  }

  function onGoogle() {
    return completeFlow('Google', () =>
      NATIVE_GOOGLE_ENABLED
        ? startGoogleAuthenticationFlow()
        : startSSOFlow({ strategy: 'oauth_google' }),
    )
  }
  function onApple() {
    return completeFlow('Apple', () => startSSOFlow({ strategy: 'oauth_apple' }))
  }
  function onDiscord() {
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
      } else if (attempt.status === 'needs_second_factor') {
        // Account has 2FA. Prepare a code challenge (phone code where set up;
        // TOTP apps need no prepare) and switch to the code-entry step.
        try {
          await signIn.prepareSecondFactor({ strategy: 'phone_code' })
        } catch {
          // TOTP / no preparable factor - the user reads the code from their app.
        }
        setTwoFactor(true)
      } else {
        setError(`This account needs another step to sign in (${attempt.status}).`)
      }
    } catch (e) {
      setError(clerkMessage(e, 'Sign-in failed'))
    } finally {
      setBusy(false)
    }
  }

  async function onSignUp() {
    if (!signUpLoaded || busy) return
    const user = username.trim()
    if (!email.trim() || !password || !user) {
      setError('Enter an email, password, and username to create your account.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const attempt = await signUp.create({
        emailAddress: email.trim(),
        password,
        username: user,
      })
      // A new account is never complete on create - Clerk requires the emailed
      // code first. Send it and move to the code step.
      if (attempt.status === 'complete' && attempt.createdSessionId) {
        await setActiveSignUp({ session: attempt.createdSessionId })
        router.replace('/(tabs)')
        return
      }
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' })
      setVerifyingSignUp(true)
      setCode('')
    } catch (e) {
      setError(clerkMessage(e, 'Could not create your account'))
    } finally {
      setBusy(false)
    }
  }

  async function onVerifySignUp() {
    if (!signUpLoaded || busy) return
    const value = code.trim()
    if (!value) {
      setError('Enter the code we emailed you.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const attempt = await signUp.attemptEmailAddressVerification({ code: value })
      if (attempt.status === 'complete' && attempt.createdSessionId) {
        await setActiveSignUp({ session: attempt.createdSessionId })
        router.replace('/(tabs)')
      } else if (attempt.missingFields.length) {
        setError(`Your account still needs: ${attempt.missingFields.join(', ')}`)
      } else {
        setError('That code was not accepted. Try again.')
      }
    } catch (e) {
      setError(clerkMessage(e, 'That code was not accepted.'))
    } finally {
      setBusy(false)
    }
  }

  async function onResendSignUpCode() {
    if (!signUpLoaded || busy) return
    setBusy(true)
    setError(null)
    try {
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' })
      setError('We sent a new code to your email.')
    } catch (e) {
      setError(clerkMessage(e, 'Could not resend the code'))
    } finally {
      setBusy(false)
    }
  }

  async function onSubmitCode() {
    if (!isLoaded || busy) return
    const value = code.trim()
    if (!value) {
      setError('Enter the code from your authenticator or text.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      // Try TOTP first (authenticator app), then fall back to a phone code.
      let attempt
      try {
        attempt = await signIn.attemptSecondFactor({ strategy: 'totp', code: value })
      } catch {
        attempt = await signIn.attemptSecondFactor({ strategy: 'phone_code', code: value })
      }
      if (attempt.status === 'complete') {
        await setActive({ session: attempt.createdSessionId })
        router.replace('/(tabs)')
      } else {
        setError('That code was not accepted. Try again.')
      }
    } catch (e) {
      setError(clerkMessage(e, 'That code was not accepted.'))
    } finally {
      setBusy(false)
    }
  }

  async function onForgotPassword() {
    // Clerk owns password reset; open its hosted account portal.
    try {
      const url = accountPortalUrl(
        `/sign-in?redirect_url=hearthshelf://sso-callback${email ? `&email_address=${encodeURIComponent(email)}` : ''}`,
      )
      await WebBrowser.openBrowserAsync(url)
    } catch {
      setError('Could not open the password reset page.')
    }
  }

  async function onSubmitUsername() {
    if (!pendingSignUp || !pendingSetActive || busy) return
    const value = username.trim()
    if (!value) {
      setError('Please choose a username')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const updated = await pendingSignUp.update({ username: value })
      if (updated.status === 'complete' && updated.createdSessionId) {
        await pendingSetActive({ session: updated.createdSessionId })
        setPendingSignUp(null)
        setPendingSetActive(null)
        router.replace('/(tabs)')
      } else {
        setError(`Sign-up still needs: ${updated.missingFields.join(', ') || updated.status}`)
      }
    } catch (e) {
      setError(clerkMessage(e, 'Could not set username'))
    } finally {
      setBusy(false)
    }
  }

  const errorBanner = error ? (
    <View style={styles.errorBanner}>
      <MaterialIcons name="error-outline" size={18} color={INK.accent} />
      <Text style={styles.errorBannerText}>{error}</Text>
    </View>
  ) : null

  return (
    <View style={styles.bg}>
      <Image
        source={require('@/../assets/images/hearth-centered.webp')}
        style={styles.bgImage}
        resizeMode="cover"
      />
      {/* Bottom-heavy scrim so the auth block stays legible over the fire. */}
      <LinearGradient
        colors={['transparent', 'rgba(10,9,8,0.35)', 'rgba(10,9,8,0.92)']}
        locations={[0, 0.45, 1]}
        style={styles.scrim}
        pointerEvents="none"
      />

      {/* Wordmark anchored in the upper third. */}
      <View style={styles.heroTop} pointerEvents="none">
        <Text style={styles.brand}>
          <Text style={styles.brandHearth}>Hearth</Text>
          <Text style={styles.brandShelf}>Shelf</Text>
        </Text>
      </View>

      {/* No behavior on Android: MainActivity is windowSoftInputMode=adjustResize,
          so the window is already resized for us - adding 'height' on top of that
          compensates twice and over-shrinks the frame. */}
      <KeyboardAvoidingView
        style={styles.content}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          <View style={styles.authBlock}>
            {pendingSignUp ? (
              <View style={styles.formCard}>
                <Text style={styles.stepTitle}>Choose a username</Text>
                <Text style={styles.stepHint}>This is how you'll show up in HearthShelf.</Text>
                <TextInput
                  style={styles.input}
                  placeholder="Username"
                  placeholderTextColor={INK.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={username}
                  onChangeText={setUsername}
                />
                {errorBanner}
                <TouchableOpacity style={styles.primaryButton} onPress={onSubmitUsername} disabled={busy}>
                  {busy ? (
                    <ActivityIndicator color={INK.onAccent} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Continue</Text>
                  )}
                </TouchableOpacity>
              </View>
            ) : verifyingSignUp ? (
              <View style={styles.formCard}>
                <Text style={styles.stepTitle}>Check your email</Text>
                <Text style={styles.stepHint}>
                  We sent a 6-digit code to {email.trim() || 'your email'}. Enter it below to
                  finish creating your account.
                </Text>
                <TextInput
                  style={[styles.input, styles.codeInput]}
                  placeholder="123456"
                  placeholderTextColor={INK.faint}
                  keyboardType="number-pad"
                  autoFocus
                  value={code}
                  onChangeText={setCode}
                  maxLength={8}
                />
                {errorBanner}
                <TouchableOpacity style={styles.primaryButton} onPress={onVerifySignUp} disabled={busy}>
                  {busy ? (
                    <ActivityIndicator color={INK.onAccent} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Create account</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity onPress={() => void onResendSignUpCode()} style={styles.forgot} disabled={busy}>
                  <Text style={styles.forgotText}>Resend code</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.backLink}
                  onPress={() => {
                    setVerifyingSignUp(false)
                    setCode('')
                    setError(null)
                  }}
                  disabled={busy}
                >
                  <Text style={styles.backLinkText}>Back</Text>
                </TouchableOpacity>
              </View>
            ) : twoFactor ? (
              <View style={styles.formCard}>
                <Text style={styles.stepTitle}>Enter your code</Text>
                <Text style={styles.stepHint}>
                  Open your authenticator app (or check your texts) for the 6-digit code.
                </Text>
                <TextInput
                  style={[styles.input, styles.codeInput]}
                  placeholder="123456"
                  placeholderTextColor={INK.faint}
                  keyboardType="number-pad"
                  autoFocus
                  value={code}
                  onChangeText={setCode}
                  maxLength={8}
                />
                {errorBanner}
                <TouchableOpacity style={styles.primaryButton} onPress={onSubmitCode} disabled={busy}>
                  {busy ? (
                    <ActivityIndicator color={INK.onAccent} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Verify</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.backLink}
                  onPress={() => {
                    setTwoFactor(false)
                    setCode('')
                    setError(null)
                  }}
                  disabled={busy}
                >
                  <Text style={styles.backLinkText}>Back</Text>
                </TouchableOpacity>
              </View>
            ) : emailMode ? (
              <View style={styles.formCard}>
                {signUpMode ? (
                  <>
                    <Text style={styles.stepTitle}>Create your account</Text>
                    <Text style={styles.stepHint}>We'll email you a code to confirm it's you.</Text>
                  </>
                ) : null}
                <TextInput
                  style={styles.input}
                  placeholder="Email"
                  placeholderTextColor={INK.faint}
                  autoCapitalize="none"
                  keyboardType="email-address"
                  value={email}
                  onChangeText={setEmail}
                />
                {signUpMode ? (
                  <TextInput
                    style={styles.input}
                    placeholder="Username"
                    placeholderTextColor={INK.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={username}
                    onChangeText={setUsername}
                  />
                ) : null}
                <View style={styles.passwordRow}>
                  <TextInput
                    style={[styles.input, { flex: 1 }]}
                    placeholder="Password"
                    placeholderTextColor={INK.faint}
                    secureTextEntry={!showPassword}
                    value={password}
                    onChangeText={setPassword}
                  />
                  <Pressable
                    onPress={() => setShowPassword((v) => !v)}
                    hitSlop={10}
                    style={styles.eyeBtn}
                  >
                    <MaterialIcons
                      name={showPassword ? 'visibility-off' : 'visibility'}
                      size={22}
                      color={INK.muted}
                    />
                  </Pressable>
                </View>

                {signUpMode ? null : (
                  <TouchableOpacity onPress={() => void onForgotPassword()} style={styles.forgot}>
                    <Text style={styles.forgotText}>Forgot password?</Text>
                  </TouchableOpacity>
                )}

                {errorBanner}

                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={signUpMode ? onSignUp : onSignIn}
                  disabled={busy}
                >
                  {busy ? (
                    <ActivityIndicator color={INK.onAccent} />
                  ) : (
                    <Text style={styles.primaryButtonText}>
                      {signUpMode ? 'Continue' : 'Sign in'}
                    </Text>
                  )}
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.switchLink}
                  onPress={() => {
                    setSignUpMode((v) => !v)
                    setError(null)
                  }}
                  disabled={busy}
                >
                  <Text style={styles.switchLinkText}>
                    {signUpMode ? 'Already have an account? ' : "Don't have an account? "}
                    <Text style={styles.switchLinkStrong}>
                      {signUpMode ? 'Sign in' : 'Sign up'}
                    </Text>
                  </Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.backLink}
                  onPress={() => {
                    setEmailMode(false)
                    setSignUpMode(false)
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

                {APPLE_ENABLED ? (
                  <TouchableOpacity style={styles.apple} onPress={onApple} disabled={busy}>
                    {busy ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <>
                        <AppleLogo />
                        <Text style={styles.appleText}>Continue with Apple</Text>
                      </>
                    )}
                  </TouchableOpacity>
                ) : null}

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
                  <Text style={styles.emailButtonText}>Continue with email</Text>
                </TouchableOpacity>

                {errorBanner}
              </View>
            )}

            <Text style={styles.footer}>
              By continuing you agree to the{' '}
              <Text
                style={styles.footerLink}
                onPress={() => void WebBrowser.openBrowserAsync('https://hearthshelf.com/terms')}
              >
                Terms
              </Text>{' '}
              &{' '}
              <Text
                style={styles.footerLink}
                onPress={() => void WebBrowser.openBrowserAsync('https://hearthshelf.com/privacy')}
              >
                Privacy Policy
              </Text>
              .
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  )
}

/** Clerk's short `message` is often "is invalid"; `longMessage` names the
 *  offending parameter, which actually tells you what's wrong. */
function clerkMessage(e: unknown, fallback: string): string {
  const clerkErr = (e as { errors?: Array<{ message?: string; longMessage?: string }> })?.errors?.[0]
  return clerkErr?.longMessage || clerkErr?.message || (e as Error)?.message || fallback
}

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: INK.bg },
  bgImage: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, width: '100%', height: '100%' },
  scrim: { position: 'absolute', left: 0, right: 0, bottom: 0, top: 0 },
  heroTop: {
    position: 'absolute',
    top: '18%',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  content: { flex: 1 },
  scroll: { flexGrow: 1, justifyContent: 'flex-end', paddingHorizontal: 30, paddingBottom: 40 },
  authBlock: {},
  brand: { fontSize: 36, textAlign: 'center', fontFamily: fonts.brand },
  brandHearth: { color: INK.hearth, fontFamily: fonts.brand },
  brandShelf: { color: INK.shelf, fontFamily: fonts.brand, fontWeight: '700' },

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
  apple: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: '#000',
    borderRadius: 16,
    paddingVertical: 15,
  },
  appleText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  emailButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
    paddingVertical: 13,
    borderWidth: 1,
    borderColor: INK.line,
    backgroundColor: INK.glass,
  },
  emailButtonText: { color: INK.text, fontSize: 14.5, fontWeight: '600' },

  formCard: { gap: 12 },
  stepTitle: { color: INK.text, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  stepHint: { color: INK.muted, fontSize: 13.5, textAlign: 'center', marginBottom: 4, lineHeight: 19 },
  input: {
    backgroundColor: INK.field,
    color: INK.text,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: INK.line,
    paddingHorizontal: 16,
    paddingVertical: 15,
    fontSize: 15,
  },
  codeInput: { textAlign: 'center', letterSpacing: 8, fontSize: 22, fontWeight: '700' },
  passwordRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  eyeBtn: {
    width: 48,
    height: 52,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: INK.line,
    backgroundColor: INK.field,
    alignItems: 'center',
    justifyContent: 'center',
  },
  forgot: { alignSelf: 'flex-end', paddingVertical: 2 },
  forgotText: { color: INK.muted, fontSize: 13, fontWeight: '600' },

  primaryButton: {
    backgroundColor: INK.accent,
    borderRadius: 16,
    paddingVertical: 15,
    alignItems: 'center',
  },
  primaryButtonText: { color: INK.onAccent, fontSize: 15, fontWeight: '700' },
  backLink: {
    alignItems: 'center',
    paddingVertical: 10,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: INK.line,
    backgroundColor: 'transparent',
  },
  backLinkText: { color: INK.muted, fontSize: 13.5, fontWeight: '600' },
  switchLink: { alignItems: 'center', paddingVertical: 6 },
  switchLinkText: { color: INK.muted, fontSize: 13.5 },
  switchLinkStrong: { color: INK.hearth, fontWeight: '700' },

  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 12,
    borderRadius: 14,
    backgroundColor: INK.dangerBg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: INK.accent,
  },
  errorBannerText: { color: INK.text, fontSize: 13, flex: 1, lineHeight: 18 },
  footer: {
    textAlign: 'center',
    color: INK.muted,
    fontSize: 11,
    lineHeight: 18,
    marginTop: 14,
  },
  footerLink: { color: INK.hearth, fontWeight: '600' },
})
