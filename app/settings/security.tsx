/**
 * Sign-in & security: every way this account can be signed into, in one place.
 *
 * WHY THIS IS A SCREEN OF ITS OWN. Account was a read-only card plus a sign-out
 * button, because when it was written the previous identity provider owned all
 * of this in its own hosted UI. Nothing hosts it now, so a phone-only user had
 * no way to add a passkey, set a password, turn on two-factor, see what else was
 * signed in, or delete their account - they had to find a desktop.
 *
 * THE LAST-METHOD GUARD IS THE SERVER'S. The service refuses to unlink an
 * account's only remaining credential, so a user cannot lock themselves out even
 * if this UI is wrong. The button is disabled to match, but the server is the
 * authority - the UI is a courtesy, not the enforcement.
 *
 * Mirrors the web app's ProfilePanel + SignInMethods + ActiveSessions, so the
 * two platforms stay one feature rather than drifting into two.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Linking, Pressable, StyleSheet, TextInput, View } from 'react-native'
import { authClient } from '@/auth/client'
import { useAuth } from '@/auth/useAuth'
import { AppText } from '@/ui/primitives'
import { SettingsPanel, SettingsGroup, SettingsLabel, SettingsRow } from '@/ui/settingsControls'
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { confirm } from '@/ui/confirm'
import { showToast } from '@/ui/Toast'

/** `providerId` is the social provider, or 'credential' for a password. */
interface LinkedAccount {
  id: string
  providerId: string
  accountId?: string
}

interface PasskeyRow {
  id: string
  name?: string | null
  createdAt?: string | Date | null
}

interface SessionRow {
  id: string
  token: string
  createdAt?: string | Date | null
  userAgent?: string | null
}

const PROVIDERS = [
  { id: 'google', label: 'Google' },
  { id: 'apple', label: 'Apple' },
  { id: 'discord', label: 'Discord' },
] as const

/** The app's own scheme, so a provider hand-off returns to the app not the web. */
const RETURN_TO_APP = 'hearthshelf://'

function fmtDay(d: string | Date | null | undefined): string {
  if (!d) return ''
  const date = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export default function SecurityScreen() {
  const { user } = useAuth()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])

  const [accounts, setAccounts] = useState<LinkedAccount[] | null>(null)
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null)
  const [sessions, setSessions] = useState<SessionRow[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // Password. Setting one when none exists and changing an existing one are the
  // same endpoint; `currentPassword` is what differs.
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')

  // Two-factor. `totpUri` is only held between enabling and verifying.
  const [twoFactorPassword, setTwoFactorPassword] = useState('')
  const [totpUri, setTotpUri] = useState<string | null>(null)
  const [totpCode, setTotpCode] = useState('')
  const [backupCodes, setBackupCodes] = useState<string[]>([])

  const twoFactorEnabled = user?.twoFactorEnabled === true

  const loadAccounts = useCallback(async () => {
    const res = await authClient.listAccounts()
    setAccounts((res?.data as LinkedAccount[] | undefined) ?? [])
  }, [])

  const loadPasskeys = useCallback(async () => {
    const res = await authClient.passkey.listUserPasskeys()
    setPasskeys((res?.data as PasskeyRow[] | undefined) ?? [])
  }, [])

  const loadSessions = useCallback(async () => {
    const res = await authClient.listSessions()
    setSessions((res?.data as SessionRow[] | undefined) ?? [])
  }, [])

  useEffect(() => {
    void loadAccounts().catch(() => setAccounts([]))
    void loadPasskeys().catch(() => setPasskeys([]))
    void loadSessions().catch(() => setSessions([]))
  }, [loadAccounts, loadPasskeys, loadSessions])

  const linked = accounts ?? []
  const hasPassword = linked.some((a) => a.providerId === 'credential')
  const social = linked.filter((a) => a.providerId !== 'credential')
  // What the server counts when it refuses the last unlink.
  const onlyOneMethod = linked.length <= 1

  async function link(provider: string) {
    setBusy(provider)
    try {
      const res = await authClient.linkSocial({ provider, callbackURL: RETURN_TO_APP })
      if (res?.error) showToast(res.error.message || `Could not connect ${provider}`)
    } catch (e) {
      showToast((e as Error)?.message || `Could not connect ${provider}`)
    } finally {
      setBusy(null)
    }
  }

  async function unlink(account: LinkedAccount, label: string) {
    if (
      !(await confirm({
        title: `Disconnect ${label}?`,
        message: `You will no longer be able to sign in with ${label}.`,
        confirmLabel: 'Disconnect',
      }))
    )
      return
    setBusy(account.id)
    try {
      const res = await authClient.unlinkAccount({ accountId: account.id })
      if (res?.error) {
        showToast(res.error.message || 'Could not disconnect that account')
        return
      }
      showToast('Disconnected')
      await loadAccounts()
    } finally {
      setBusy(null)
    }
  }

  async function savePassword() {
    if (!newPassword) return
    setBusy('password')
    try {
      const res = await authClient.changePassword({
        newPassword,
        currentPassword,
        // Other devices keep their sessions: changing a password here is routine
        // account hygiene, not a "someone got in" response. A user who wants
        // everything signed out can do that below.
        revokeOtherSessions: false,
      })
      if (res?.error) {
        showToast(res.error.message || 'Could not change your password')
        return
      }
      setCurrentPassword('')
      setNewPassword('')
      showToast(hasPassword ? 'Password changed' : 'Password set')
      await loadAccounts()
    } finally {
      setBusy(null)
    }
  }

  function addPasskey() {
    // The auth library's passkey client is browser-only: it calls
    // navigator.credentials, which does not exist in a native app, so calling it
    // here fails with "WebAuthn is not supported on this browser" - an error
    // that is unfixable from this screen and confusing besides, since there is
    // no browser in sight. Say what is actually true instead.
    //
    // Creating one needs a native passkey module and a rebuild. The server half
    // is already done: hearthshelf.com now publishes the Android and Apple
    // association files a phone needs to verify this app owns the domain.
    // Existing passkeys still LIST and can be removed here - only creating one
    // is unavailable, so the section stays useful.
    showToast('Adding a passkey from the phone app is coming soon - use the web app for now')
  }

  async function removePasskey(row: PasskeyRow) {
    if (
      !(await confirm({
        title: 'Remove passkey?',
        message: 'This device will no longer be able to sign in with a passkey.',
        confirmLabel: 'Remove',
      }))
    )
      return
    setBusy(row.id)
    try {
      const res = await authClient.passkey.deletePasskey({ id: row.id })
      if (res?.error) {
        showToast(res.error.message || 'Could not remove that passkey')
        return
      }
      showToast('Passkey removed')
      await loadPasskeys()
    } finally {
      setBusy(null)
    }
  }

  async function startTwoFactor() {
    setBusy('2fa')
    try {
      const res = await authClient.twoFactor.enable({ password: twoFactorPassword })
      if (res?.error) {
        showToast(res.error.message || 'Could not turn on two-factor')
        return
      }
      const data = res?.data as { totpURI?: string; backupCodes?: string[] } | undefined
      setTotpUri(data?.totpURI ?? null)
      setBackupCodes(data?.backupCodes ?? [])
      setTwoFactorPassword('')
    } finally {
      setBusy(null)
    }
  }

  async function confirmTwoFactor() {
    setBusy('2fa')
    try {
      const res = await authClient.twoFactor.verifyTotp({ code: totpCode.trim() })
      if (res?.error) {
        showToast(res.error.message || 'That code did not match')
        return
      }
      setTotpUri(null)
      setTotpCode('')
      showToast('Two-factor is on')
    } finally {
      setBusy(null)
    }
  }

  async function disableTwoFactor() {
    setBusy('2fa')
    try {
      const res = await authClient.twoFactor.disable({ password: twoFactorPassword })
      if (res?.error) {
        showToast(res.error.message || 'Could not turn off two-factor')
        return
      }
      setTwoFactorPassword('')
      showToast('Two-factor is off')
    } finally {
      setBusy(null)
    }
  }

  async function revokeSession(row: SessionRow) {
    if (
      !(await confirm({
        title: 'Sign out that device?',
        message: 'It will need to sign in again.',
        confirmLabel: 'Sign out',
      }))
    )
      return
    setBusy(row.id)
    try {
      const res = await authClient.revokeSession({ token: row.token })
      if (res?.error) {
        showToast(res.error.message || 'Could not sign that device out')
        return
      }
      await loadSessions()
    } finally {
      setBusy(null)
    }
  }

  async function revokeOthers() {
    if (
      !(await confirm({
        title: 'Sign out everywhere else?',
        message: 'Every other device will need to sign in again. This one stays signed in.',
        confirmLabel: 'Sign out others',
      }))
    )
      return
    setBusy('others')
    try {
      const res = await authClient.revokeOtherSessions()
      if (res?.error) {
        showToast(res.error.message || 'Could not sign the other devices out')
        return
      }
      showToast('Other devices signed out')
      await loadSessions()
    } finally {
      setBusy(null)
    }
  }

  async function deleteAccount() {
    // Two confirmations, because this is irreversible and the second one names
    // what actually goes. The service then emails a link that does the deed, so
    // an unlocked phone alone is never enough.
    if (
      !(await confirm({
        title: 'Delete your account?',
        message:
          'This permanently deletes your HearthShelf account: your sign-in, your linked servers, and your remembered devices. It does not touch the books on your own server.',
        confirmLabel: 'Continue',
      }))
    )
      return
    if (
      !(await confirm({
        title: 'This cannot be undone',
        message: 'We will email you a link to finish deleting your account.',
        confirmLabel: 'Email me the link',
      }))
    )
      return
    setBusy('delete')
    try {
      const res = await authClient.deleteUser({ callbackURL: RETURN_TO_APP })
      if (res?.error) {
        showToast(res.error.message || 'Could not start deleting your account')
        return
      }
      showToast('Check your email to finish deleting your account')
    } catch (e) {
      showToast((e as Error)?.message || 'Could not start deleting your account')
    } finally {
      setBusy(null)
    }
  }

  if (!user) return null

  return (
    <SettingsPanel>
      <SettingsLabel>Sign-in methods</SettingsLabel>
      <SettingsGroup>
        {PROVIDERS.map((p, i) => {
          const existing = social.find((a) => a.providerId === p.id)
          return (
            <SettingsRow
              key={p.id}
              title={p.label}
              // Muted grey reads identically linked or not - the one thing this
              // row exists to tell you. Green carries it at a glance, as on web.
              desc={existing ? 'Connected' : 'Not connected'}
              descColor={existing ? colors.success : undefined}
              last={i === PROVIDERS.length - 1}
              control={
                <Pressable
                  onPress={() => (existing ? void unlink(existing, p.label) : void link(p.id))}
                  disabled={busy !== null || (!!existing && onlyOneMethod)}
                  style={styles.action}
                >
                  <AppText
                    variant="caption"
                    color={existing && !onlyOneMethod ? colors.destructive : colors.accent}
                  >
                    {existing ? 'Disconnect' : 'Connect'}
                  </AppText>
                </Pressable>
              }
            />
          )
        })}
      </SettingsGroup>

      <SettingsLabel>{hasPassword ? 'Password' : 'Add a password'}</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          title={hasPassword ? 'Change your password' : 'Set a password'}
          desc={
            hasPassword
              ? 'You can sign in with this as well as your other methods.'
              : 'Optional if you prefer passkeys or email codes.'
          }
          stacked
          last
        >
          <View style={styles.stack}>
            {hasPassword ? (
              <TextInput
                style={styles.input}
                secureTextEntry
                autoComplete="current-password"
                placeholder="Current password"
                placeholderTextColor={colors.textMuted}
                value={currentPassword}
                onChangeText={setCurrentPassword}
              />
            ) : null}
            <TextInput
              style={styles.input}
              secureTextEntry
              autoComplete="new-password"
              placeholder={hasPassword ? 'New password' : 'Password'}
              placeholderTextColor={colors.textMuted}
              value={newPassword}
              onChangeText={setNewPassword}
            />
            <Pressable
              onPress={() => void savePassword()}
              disabled={busy !== null || !newPassword || (hasPassword && !currentPassword)}
              style={styles.button}
            >
              <AppText variant="body" color={colors.accent}>
                {hasPassword ? 'Change password' : 'Set password'}
              </AppText>
            </Pressable>
          </View>
        </SettingsRow>
      </SettingsGroup>

      <SettingsLabel>Passkeys</SettingsLabel>
      <SettingsGroup>
        {(passkeys ?? []).map((row) => (
          <SettingsRow
            key={row.id}
            title={row.name || 'Passkey'}
            desc={fmtDay(row.createdAt) ? `Added ${fmtDay(row.createdAt)}` : undefined}
            control={
              <Pressable
                onPress={() => void removePasskey(row)}
                disabled={busy !== null}
                style={styles.action}
              >
                <AppText variant="caption" color={colors.destructive}>
                  Remove
                </AppText>
              </Pressable>
            }
          />
        ))}
        <SettingsRow
          title="Add a passkey"
          desc="Sign in with your face, fingerprint, or screen lock. Add one from the web app for now."
          onPress={addPasskey}
          last
        />
      </SettingsGroup>

      <SettingsLabel>Two-factor</SettingsLabel>
      <SettingsGroup>
        {totpUri ? (
          <SettingsRow
            title="Finish turning it on"
            desc="Add this to your authenticator app, then enter the 6-digit code it shows."
            stacked
            last
          >
            <View style={styles.stack}>
              <Pressable onPress={() => void Linking.openURL(totpUri)} style={styles.button}>
                <AppText variant="body" color={colors.accent}>
                  Open in my authenticator app
                </AppText>
              </Pressable>
              {backupCodes.length > 0 ? (
                <View style={styles.codeBox}>
                  <AppText variant="caption" color={colors.textMuted}>
                    Backup codes - save these somewhere safe. Each one works once if you lose your
                    phone.
                  </AppText>
                  <AppText variant="body" style={{ marginTop: spacing.xs }}>
                    {backupCodes.join('  ')}
                  </AppText>
                </View>
              ) : null}
              <TextInput
                style={styles.input}
                keyboardType="number-pad"
                maxLength={6}
                placeholder="000000"
                placeholderTextColor={colors.textMuted}
                value={totpCode}
                onChangeText={setTotpCode}
              />
              <Pressable
                onPress={() => void confirmTwoFactor()}
                disabled={busy !== null || totpCode.trim().length < 6}
                style={styles.button}
              >
                <AppText variant="body" color={colors.accent}>
                  Verify and turn on
                </AppText>
              </Pressable>
            </View>
          </SettingsRow>
        ) : (
          <SettingsRow
            title={twoFactorEnabled ? 'Two-factor is on' : 'Turn on two-factor'}
            desc={
              twoFactorEnabled
                ? 'You enter a code from your authenticator app when you sign in.'
                : 'Ask for a code from your authenticator app as well as your password.'
            }
            stacked
            last
          >
            <View style={styles.stack}>
              <TextInput
                style={styles.input}
                secureTextEntry
                autoComplete="current-password"
                placeholder="Your password"
                placeholderTextColor={colors.textMuted}
                value={twoFactorPassword}
                onChangeText={setTwoFactorPassword}
              />
              <Pressable
                onPress={() => (twoFactorEnabled ? void disableTwoFactor() : void startTwoFactor())}
                disabled={busy !== null || !twoFactorPassword}
                style={styles.button}
              >
                <AppText
                  variant="body"
                  color={twoFactorEnabled ? colors.destructive : colors.accent}
                >
                  {twoFactorEnabled ? 'Turn off two-factor' : 'Turn on two-factor'}
                </AppText>
              </Pressable>
            </View>
          </SettingsRow>
        )}
      </SettingsGroup>

      <SettingsLabel>Where you are signed in</SettingsLabel>
      <SettingsGroup>
        {(sessions ?? []).map((row) => (
          <SettingsRow
            key={row.id}
            title={row.userAgent || 'A device'}
            desc={fmtDay(row.createdAt) ? `Signed in ${fmtDay(row.createdAt)}` : undefined}
            control={
              <Pressable
                onPress={() => void revokeSession(row)}
                disabled={busy !== null}
                style={styles.action}
              >
                <AppText variant="caption" color={colors.destructive}>
                  Sign out
                </AppText>
              </Pressable>
            }
          />
        ))}
        <SettingsRow
          title="Sign out everywhere else"
          desc="This device stays signed in."
          danger
          onPress={() => void revokeOthers()}
          last
        />
      </SettingsGroup>

      <SettingsLabel>Danger zone</SettingsLabel>
      <SettingsGroup>
        <SettingsRow
          icon="delete"
          title="Delete my account"
          desc="Permanently deletes your HearthShelf account. Does not touch your own server."
          danger
          onPress={() => void deleteAccount()}
          last
        />
      </SettingsGroup>
    </SettingsPanel>
  )
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    stack: { gap: spacing.sm, marginTop: spacing.sm },
    input: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      color: colors.text,
      backgroundColor: colors.fill,
      fontSize: 16,
    },
    button: { paddingVertical: spacing.sm },
    action: { paddingVertical: spacing.xs, paddingHorizontal: spacing.sm },
    codeBox: {
      borderRadius: 10,
      padding: spacing.md,
      backgroundColor: colors.fill,
    },
  })
}
