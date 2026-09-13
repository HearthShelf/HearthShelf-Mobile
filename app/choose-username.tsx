/**
 * Pick a username, for an account that arrived without one.
 *
 * WHY THIS EXISTS. Signing in with Google or Apple creates the account on the
 * spot, and the provider hands over a `name` - which for both of them is the
 * person's REAL NAME, not a handle. Nothing else fills the username in: the
 * username plugin only sets one when the sign-up supplied it, and a social
 * sign-up never does. So a new account is created with `username = NULL` and a
 * display name of "Jane Smith".
 *
 * That name is not private. It rides the session to every self-hosted server
 * (see the control plane's betterAuth.ts, which prefers `name`) and shows on
 * club rosters, note threads, @mentions, and the leaderboard. Someone signing
 * in with Apple - including through Hide My Email, where the address gives
 * nothing away - would be published under their real name without ever being
 * asked. The previous identity provider prompted for a handle during social
 * sign-up and we lost that step in the move; this restores it.
 *
 * It is a GATE, not a step in the sign-in screen: the browser fallback, the
 * native sheet and a web sign-up all land here the same way, so there is one
 * place to maintain rather than one per route.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { useRouter } from 'expo-router'
import { authClient } from '@/auth/client'
import { useAuth } from '@/auth/useAuth'
import { AppText } from '@/ui/primitives'
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { showToast } from '@/ui/Toast'
import { useBackHandler } from '@/ui/useBackHandler'

/** The server's own rule (username plugin): letters, digits, underscore, dot. */
const ALLOWED = /^[a-zA-Z0-9_.]+$/
const MIN = 3
const MAX = 30

/** How long to wait after typing before asking the server if it is free. */
const CHECK_DEBOUNCE_MS = 400

type Availability = 'idle' | 'checking' | 'free' | 'taken' | 'invalid'

/**
 * Turn a provider's display name into a plausible starting handle.
 *
 * Only a suggestion - it is pre-filled and fully editable, so a real name never
 * becomes the username unless the person actively keeps it.
 */
function suggestFrom(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9_.]/g, '')
    .slice(0, MAX)
  return base.length >= MIN ? base : ''
}

export default function ChooseUsernameScreen() {
  const router = useRouter()
  const { user } = useAuth()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const [value, setValue] = useState('')
  const [state, setState] = useState<Availability>('idle')
  const [saving, setSaving] = useState(false)
  const seeded = useRef(false)

  // Seed once from the provider's name, then leave it alone - re-seeding would
  // fight the user every time the session object refreshed.
  useEffect(() => {
    if (seeded.current || !user) return
    seeded.current = true
    setValue(suggestFrom(user.fullName || user.email.split('@')[0] || ''))
  }, [user])

  // Swallow hardware Back. The gate is only passable by choosing a handle, and
  // backing out would land on the tabs with the account still publishing the
  // person's real name - the very thing this screen exists to prevent.
  useBackHandler(useCallback(() => true, []))

  const trimmed = value.trim()
  const wellFormed = trimmed.length >= MIN && trimmed.length <= MAX && ALLOWED.test(trimmed)

  // Ask the server whether it is free, debounced. The check is advisory: the
  // save below is what actually decides, and it can still lose a race with
  // someone claiming the same handle a moment earlier.
  useEffect(() => {
    if (!trimmed) return setState('idle')
    if (!wellFormed) return setState('invalid')
    setState('checking')
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const res = await authClient.isUsernameAvailable({ username: trimmed })
        if (cancelled) return
        setState(res?.data?.available ? 'free' : 'taken')
      } catch {
        // A failed check must not block the attempt - let the save decide.
        if (!cancelled) setState('idle')
      }
    }, CHECK_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [trimmed, wellFormed])

  const save = useCallback(async () => {
    if (!wellFormed || saving) return
    setSaving(true)
    try {
      // `displayUsername` keeps the capitalisation the person typed; `username`
      // is the normalized (lowercased) key the server matches on.
      const res = await authClient.updateUser({ username: trimmed, displayUsername: trimmed })
      if (res?.error) {
        showToast(res.error.message || 'That username could not be saved')
        setState('taken')
        return
      }
      // Re-read the session so the rest of the app sees the new handle before
      // anything renders it.
      await authClient.getSession({ query: { disableCookieCache: true } })
      router.replace('/(tabs)')
    } catch (e) {
      showToast((e as Error)?.message || 'That username could not be saved')
    } finally {
      setSaving(false)
    }
  }, [trimmed, wellFormed, saving, router])

  if (!user) return null

  const hint =
    state === 'invalid'
      ? `Letters, numbers, dots and underscores, ${MIN}-${MAX} characters.`
      : state === 'taken'
        ? 'That one is taken - try another.'
        : state === 'free'
          ? 'That one is free.'
          : 'This is the name other listeners see on clubs, notes and the leaderboard.'

  const hintColor =
    state === 'taken' || state === 'invalid'
      ? colors.destructive
      : state === 'free'
        ? colors.success
        : colors.textMuted

  return (
    <View style={styles.screen}>
      <AppText variant="title">Choose a username</AppText>
      <AppText variant="body" color={colors.textMuted} style={styles.blurb}>
        Your account came from {user.email ? 'your sign-in provider' : 'your provider'}, which gave
        us your name. Pick what you would rather other people see.
      </AppText>

      <View style={styles.field}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={setValue}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          maxLength={MAX}
          placeholder="username"
          placeholderTextColor={colors.textMuted}
          returnKeyType="done"
          onSubmitEditing={() => void save()}
        />
        {state === 'checking' ? <ActivityIndicator style={styles.spinner} /> : null}
      </View>

      <AppText variant="caption" color={hintColor}>
        {hint}
      </AppText>

      <Pressable
        onPress={() => void save()}
        disabled={!wellFormed || saving || state === 'taken'}
        style={[styles.button, (!wellFormed || saving || state === 'taken') && styles.buttonOff]}
      >
        <AppText variant="body" color={colors.onAccent}>
          {saving ? 'Saving...' : 'Continue'}
        </AppText>
      </Pressable>
    </View>
  )
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: spacing.xl,
      gap: spacing.sm,
      backgroundColor: colors.scaffold,
    },
    blurb: { marginBottom: spacing.md },
    field: { justifyContent: 'center' },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      color: colors.text,
      backgroundColor: colors.fill,
      fontSize: 17,
    },
    spinner: { position: 'absolute', right: spacing.md },
    button: {
      marginTop: spacing.lg,
      borderRadius: 12,
      paddingVertical: spacing.md,
      alignItems: 'center',
      backgroundColor: colors.accent,
    },
    buttonOff: { opacity: 0.5 },
  })
}
