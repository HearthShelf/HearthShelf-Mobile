/**
 * Sign-in, on HearthShelf's own auth service.
 *
 * Methods, in the order the screen offers them:
 *   - passkey  - the one we want people using; no password, no code, no mail
 *   - social   - Google / Apple / Discord, carried over from the old provider
 *   - email    - a magic link, or a 6-digit code if the link is awkward to tap
 *   - 2FA      - a TOTP step when the account has it switched on
 *
 * Magic link and email codes both depend on mail delivery, so they fail
 * together; passkeys and social do not. Offering all of them means no single
 * dependency locks anyone out.
 *
 * ACCOUNT CONTINUITY. Accounts carried over from the previous provider were
 * seeded with their original id and their known social identities, so signing
 * in with the same Google/Apple/Discord account lands on the SAME HearthShelf
 * account - the servers you are linked to, your progress, all of it. For Apple
 * Private Relay users the seeded identity is the ONLY thing that matches, since
 * their relay address is issued per developer team.
 *
 * The screen is deliberately DARK regardless of app theme - a brand moment over
 * the hearth photo, before the theme system is in play - so it uses a fixed ink
 * palette rather than useColors().
 */
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import * as WebBrowser from 'expo-web-browser'
import { LinearGradient } from 'expo-linear-gradient'
import Svg, { Path } from 'react-native-svg'
import { APP_SCHEME, APPLE_ENABLED } from '@/lib/config'
import { authClient } from '@/auth/client'
import { signInWithAppleNatively, signInWithGoogleNatively, type NativeResult } from '@/auth/native'
import { fonts } from '@/ui/theme'
import { useBackHandler } from '@/ui/useBackHandler'
import { MaterialIcons } from '@expo/vector-icons'
import {
  ActivityIndicator,
  BackHandler,
  Image,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native'

// Required so the OAuth browser tab closes and hands control back to the app.
WebBrowser.maybeCompleteAuthSession()

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
  dangerBg: 'rgba(224,101,74,0.16)',
}
function GoogleLogo() {
  return (
    <Svg width={22} height={22} viewBox="0 0 24 24">
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
    <Svg width={22} height={22} viewBox="0 0 24 24" fill="#fff">
      <Path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </Svg>
  )
}

function DiscordLogo() {
  return (
    <Svg width={22} height={22} viewBox="0 0 127.14 96.36" fill="#5865F2">
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
/** Which sub-step the screen is showing. 'providers' is the root. */
type Step = 'providers' | 'email' | 'magic-sent' | 'otp' | 'two-factor'

export default function SignInScreen() {
  const router = useRouter()
  const { reason } = useLocalSearchParams<{ reason?: string }>()

  const [step, setStep] = useState<Step>('providers')
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(
    reason === 'signed-out' ? 'You have been signed out.' : null,
  )

  // Second back press at the root exits, rather than popping to a screen the
  // user cannot use while signed out.
  const exitArmedRef = useRef(false)
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const done = useCallback(() => router.replace('/(tabs)'), [router])

  // Hardware back unwinds sub-steps instead of popping the route. /sign-in is
  // always entered with router.replace, so a pop lands on (tabs) while still
  // signed out - a screen they cannot use. Each press retreats one step; at the
  // provider list a second press exits the app.
  useBackHandler(
    useCallback(() => {
      if (step !== 'providers') {
        setStep(step === 'otp' || step === 'magic-sent' ? 'email' : 'providers')
        setCode('')
        setError(null)
        return true
      }
      if (exitArmedRef.current) {
        if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
        BackHandler.exitApp()
        return true
      }
      exitArmedRef.current = true
      setError('Press back again to exit')
      exitTimerRef.current = setTimeout(() => {
        exitArmedRef.current = false
      }, 2000)
      return true
    }, [step]),
  )

  /**
   * Run an auth call and map its outcome onto the screen.
   *
   * Better Auth resolves with `{ data, error }` rather than throwing, so a
   * rejected sign-in is a value to inspect - but a network failure still
   * throws, hence both paths.
   */
  async function run(
    label: string,
    fn: () => Promise<{ error?: { message?: string } | null } | void>,
    onDone?: () => void,
  ) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fn()
      const failure = res && 'error' in res ? res.error : null
      if (failure) {
        setError(failure.message || label + ' did not complete')
        return
      }
      if (onDone) onDone()
      else done()
    } catch (e) {
      setError((e as Error)?.message || label + ' failed')
    } finally {
      setBusy(false)
    }
  }

  /**
   * Browser-tab OAuth: opens a tab, runs the redirect, deep-links back. The
   * only path for Discord, and the fallback for Google / Apple.
   */
  const browserSocial = (provider: 'google' | 'apple' | 'discord', label: string) => () =>
    run(
      label,
      () =>
        // An ABSOLUTE deep link, not a route path. This is the address the OS
        // sends the browser tab back to when the provider is done, so it has to
        // be something Android/iOS can route to us - a bare "/(tabs)" resolves
        // against nothing and the tab never comes home.
        authClient.signIn.social({ provider, callbackURL: `${APP_SCHEME}://` }),
      // The auth client drives the browser tab itself; navigating here would
      // race it and land us on a screen we are not signed in to yet.
      () => {},
    )

  /**
   * Google / Apple, preferring the OS account picker.
   *
   * Falls through to the browser tab only on `unavailable` - a device or build
   * that cannot show the native sheet. A `cancelled` deliberately does nothing:
   * popping a browser tab open because someone dismissed the picker would look
   * like a bug, not a fallback.
   */
  const nativeSocial = (provider: 'google' | 'apple', label: string) => async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    let outcome: NativeResult
    try {
      outcome =
        provider === 'google' ? await signInWithGoogleNatively() : await signInWithAppleNatively()
    } catch (e) {
      outcome = { status: 'error', message: (e as Error)?.message || label + ' failed' }
    } finally {
      setBusy(false)
    }

    if (outcome.status === 'signed-in') {
      done()
      return
    }
    if (outcome.status === 'cancelled') return
    if (outcome.status === 'error') {
      setError(outcome.message)
      return
    }
    // unavailable - take the browser flow without saying anything about it.
    browserSocial(provider, label)()
  }

  /**
   * Sign in with a passkey.
   *
   * Offered unconditionally rather than behind a capability check: the OS
   * prompt is itself the discovery mechanism, and a device holding no passkey
   * for this account reports none - surfaced as a hint to use another method,
   * not as a failure.
   */
  function onPasskey() {
    return run('Passkey sign-in', async () => {
      const res = await authClient.signIn.passkey()
      if (res?.error) {
        return {
          error: {
            message:
              'No passkey found on this device. Sign in another way, then add a passkey in Settings.',
          },
        }
      }
      return res
    })
  }

  function onMagicLink() {
    if (!email.trim()) {
      setError('Enter your email first')
      return
    }
    return run(
      'Magic link',
      () => authClient.signIn.magicLink({ email: email.trim(), callbackURL: '/(tabs)' }),
      () => setStep('magic-sent'),
    )
  }

  function onSendCode() {
    if (!email.trim()) {
      setError('Enter your email first')
      return
    }
    return run(
      'Sending your code',
      () => authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: 'sign-in' }),
      () => setStep('otp'),
    )
  }

  function onVerifyCode() {
    return run('That code', () =>
      authClient.signIn.emailOtp({ email: email.trim(), otp: code.trim() }),
    )
  }

  function onVerifyTwoFactor() {
    return run('That code', () => authClient.twoFactor.verifyTotp({ code: code.trim() }))
  }

  const errorBanner = error ? (
    <View style={styles.errorBanner}>
      <MaterialIcons name="error-outline" size={18} color={INK.accent} />
      <Text style={styles.errorBannerText}>{error}</Text>
    </View>
  ) : null

  const backToOptions = (
    <TouchableOpacity
      style={styles.backLink}
      onPress={() => {
        setStep('providers')
        setCode('')
        setError(null)
      }}
      disabled={busy}
    >
      <Text style={styles.backLinkText}>Back to all sign-in options</Text>
    </TouchableOpacity>
  )

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

      {/* 'padding' on BOTH platforms: SDK 57 forces edge-to-edge on Android,
          where the system ignores adjustResize and never resizes the window,
          so the JS side must pad for the keyboard itself. */}
      <KeyboardAvoidingView style={styles.content} behavior="padding" keyboardVerticalOffset={0}>
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          bounces={false}
        >
          <View style={styles.authBlock}>
            {step === 'two-factor' ? (
              <View style={styles.formCard}>
                <Text style={styles.stepTitle}>Two-factor code</Text>
                <Text style={styles.stepHint}>
                  Open your authenticator app and enter the 6-digit code.
                </Text>
                <TextInput
                  style={styles.codeInput}
                  placeholder="000000"
                  placeholderTextColor={INK.faint}
                  keyboardType="number-pad"
                  maxLength={6}
                  value={code}
                  onChangeText={setCode}
                />
                {errorBanner}
                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={onVerifyTwoFactor}
                  disabled={busy}
                >
                  {busy ? (
                    <ActivityIndicator color={INK.onAccent} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Verify</Text>
                  )}
                </TouchableOpacity>
                {backToOptions}
              </View>
            ) : step === 'magic-sent' ? (
              <View style={styles.formCard}>
                <Text style={styles.stepTitle}>Check your email</Text>
                <Text style={styles.stepHint}>
                  We sent a sign-in link to {email}. Tap it on this device and you are in.
                </Text>
                {errorBanner}
                <TouchableOpacity style={styles.primaryButton} onPress={onSendCode} disabled={busy}>
                  {busy ? (
                    <ActivityIndicator color={INK.onAccent} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Send a code instead</Text>
                  )}
                </TouchableOpacity>
                {backToOptions}
              </View>
            ) : step === 'otp' ? (
              <View style={styles.formCard}>
                <Text style={styles.stepTitle}>Enter your code</Text>
                <Text style={styles.stepHint}>We sent a 6-digit code to {email}.</Text>
                <TextInput
                  style={styles.codeInput}
                  placeholder="000000"
                  placeholderTextColor={INK.faint}
                  keyboardType="number-pad"
                  maxLength={6}
                  value={code}
                  onChangeText={setCode}
                />
                {errorBanner}
                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={onVerifyCode}
                  disabled={busy}
                >
                  {busy ? (
                    <ActivityIndicator color={INK.onAccent} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Sign in</Text>
                  )}
                </TouchableOpacity>
                {backToOptions}
              </View>
            ) : step === 'email' ? (
              <View style={styles.formCard}>
                <Text style={styles.stepTitle}>Sign in with email</Text>
                <Text style={styles.stepHint}>
                  No password needed - we will send you a link, or a code if you prefer.
                </Text>
                <TextInput
                  style={styles.input}
                  placeholder="you@example.com"
                  placeholderTextColor={INK.faint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  textContentType="emailAddress"
                  value={email}
                  onChangeText={setEmail}
                />
                {errorBanner}
                <TouchableOpacity
                  style={styles.primaryButton}
                  onPress={onMagicLink}
                  disabled={busy}
                >
                  {busy ? (
                    <ActivityIndicator color={INK.onAccent} />
                  ) : (
                    <Text style={styles.primaryButtonText}>Email me a link</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity style={styles.switchLink} onPress={onSendCode} disabled={busy}>
                  <Text style={styles.switchLinkText}>
                    Prefer a code? <Text style={styles.switchLinkStrong}>Send one</Text>
                  </Text>
                </TouchableOpacity>
                {backToOptions}
              </View>
            ) : (
              <View style={styles.providers}>
                <TouchableOpacity style={styles.passkey} onPress={onPasskey} disabled={busy}>
                  {busy ? (
                    <ActivityIndicator color="#1f1f1f" />
                  ) : (
                    <>
                      <MaterialIcons name="fingerprint" size={20} color="#1f1f1f" />
                      <Text style={styles.passkeyText}>Sign in with a passkey</Text>
                    </>
                  )}
                </TouchableOpacity>

                <View style={styles.providerDivider}>
                  <View style={styles.providerDividerLine} />
                  <Text style={styles.providerDividerText}>OR CONTINUE WITH</Text>
                  <View style={styles.providerDividerLine} />
                </View>

                <View style={styles.socialRow}>
                  <TouchableOpacity
                    style={styles.socialButton}
                    onPress={nativeSocial('google', 'Google sign-in')}
                    disabled={busy}
                    activeOpacity={0.6}
                    accessibilityRole="button"
                    accessibilityLabel="Continue with Google"
                    accessibilityHint="Signs in using your Google account"
                  >
                    <GoogleLogo />
                  </TouchableOpacity>

                  {APPLE_ENABLED ? (
                    <TouchableOpacity
                      style={styles.socialButton}
                      onPress={nativeSocial('apple', 'Apple sign-in')}
                      disabled={busy}
                      activeOpacity={0.6}
                      accessibilityRole="button"
                      accessibilityLabel="Continue with Apple"
                      accessibilityHint="Signs in using your Apple account"
                    >
                      <AppleLogo />
                    </TouchableOpacity>
                  ) : null}

                  <TouchableOpacity
                    style={styles.socialButton}
                    onPress={browserSocial('discord', 'Discord sign-in')}
                    disabled={busy}
                    activeOpacity={0.6}
                    accessibilityRole="button"
                    accessibilityLabel="Continue with Discord"
                    accessibilityHint="Signs in using your Discord account"
                  >
                    <DiscordLogo />
                  </TouchableOpacity>
                </View>

                <TouchableOpacity
                  style={styles.emailButton}
                  onPress={() => setStep('email')}
                  disabled={busy}
                  activeOpacity={0.6}
                  accessibilityRole="button"
                  accessibilityLabel="Use email instead"
                >
                  <MaterialIcons name="mail-outline" size={18} color={INK.muted} />
                  <Text style={styles.emailButtonText}>Use email instead</Text>
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

const styles = StyleSheet.create({
  bg: { flex: 1, backgroundColor: INK.bg },
  bgImage: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    width: '100%',
    height: '100%',
  },
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
  passkey: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    backgroundColor: '#fff',
    borderRadius: 16,
    paddingVertical: 15,
  },
  passkeyText: { color: '#1f1f1f', fontSize: 15, fontWeight: '600' },
  providerDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  providerDividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: INK.line,
  },
  providerDividerText: {
    color: INK.muted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.7,
  },
  socialRow: { flexDirection: 'row', gap: 12 },
  socialButton: {
    flex: 1,
    minWidth: 0,
    height: 56,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: INK.line,
    backgroundColor: INK.field,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emailButton: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 12,
  },
  emailButtonText: { color: INK.muted, fontSize: 14, fontWeight: '600' },

  formCard: { gap: 12 },
  stepTitle: { color: INK.text, fontSize: 20, fontWeight: '700', textAlign: 'center' },
  stepHint: {
    color: INK.muted,
    fontSize: 13.5,
    textAlign: 'center',
    marginBottom: 4,
    lineHeight: 19,
  },
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
