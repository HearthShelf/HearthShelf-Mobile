/** The forms inside the Service Accounts sheets. Each sits in a bottom sheet, so its
 *  fields use AdminField inSheet. */
import { useState } from 'react'
import { View } from 'react-native'
import { getRandomBytes } from 'expo-crypto'
import { generatePassword, type ABSAdminUser } from '@hearthshelf/core'
import { reservedKeyNameError } from '@/api/admin/apikeys'
import type { ServiceAccountPatch } from '@/api/admin/serviceAccounts'
import { AppText } from '@/ui/primitives'
import { SettingsRow, SettingsToggle } from '@/ui/settingsControls'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'
import { AdminButton } from './AdminButton'
import { AdminField } from './AdminField'
import { HttpWarning } from './HttpWarning'

export function NewServiceAccountForm({
  busy,
  onSubmit,
}: {
  busy: boolean
  onSubmit: (input: { username: string; password: string; email: string | null }) => void
}) {
  const colors = useColors()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [email, setEmail] = useState('')
  const [showPassword, setShowPassword] = useState(false)

  return (
    <View style={{ gap: spacing.md }}>
      <HttpWarning />
      <AppText variant="meta" color={colors.textMuted}>
        This makes an admin account for another app. Its password is shown once. After that, only
        the tokens you make for it matter.
      </AppText>
      <AdminField
        inSheet
        label="Username"
        placeholder="backup-bot"
        value={username}
        onChangeText={setUsername}
      />
      <AdminField
        inSheet
        label="Password"
        placeholder="Choose a strong password"
        secureTextEntry={!showPassword}
        value={password}
        onChangeText={setPassword}
      />
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <AdminButton
          label={showPassword ? 'Hide' : 'Show'}
          icon={showPassword ? 'visibility-off' : 'visibility'}
          kind="secondary"
          onPress={() => setShowPassword((v) => !v)}
        />
        <AdminButton
          label="Generate"
          icon="casino"
          kind="secondary"
          onPress={() => {
            setPassword(generatePassword(getRandomBytes))
            setShowPassword(true)
          }}
        />
      </View>
      <AdminField
        inSheet
        label="Email (optional)"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <AdminButton
        label="Create account"
        icon="smart-toy"
        busy={busy}
        disabled={!username.trim() || !password}
        onPress={() =>
          onSubmit({ username: username.trim(), password, email: email.trim() || null })
        }
      />
    </View>
  )
}

export function EditServiceAccountForm({
  account,
  isSelf,
  busy,
  onSubmit,
}: {
  account: ABSAdminUser
  isSelf: boolean
  busy: boolean
  onSubmit: (patch: ServiceAccountPatch) => void
}) {
  const [username, setUsername] = useState(account.username)
  const [email, setEmail] = useState(account.email ?? '')
  const [password, setPassword] = useState('')
  const [isActive, setIsActive] = useState(account.isActive)

  // Never offer a switch that would lock out this admin or the root account.
  const canDisable = !isSelf && account.type !== 'root'

  const patch: ServiceAccountPatch = {}
  if (username.trim() && username.trim() !== account.username) patch.username = username.trim()
  // ABS ignores an empty email, so a blank field can't clear one.
  if (email.trim() && email.trim() !== (account.email ?? '')) patch.email = email.trim()
  if (password) patch.password = password
  if (canDisable && isActive !== account.isActive) patch.isActive = isActive

  return (
    <View style={{ gap: spacing.md }}>
      <HttpWarning />
      <AdminField inSheet label="Username" value={username} onChangeText={setUsername} />
      <AdminField
        inSheet
        label="New password"
        placeholder="Leave blank to keep it"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />
      <AdminField
        inSheet
        label="Email"
        keyboardType="email-address"
        hint={account.email ? 'You can change this email, but not remove it.' : undefined}
        value={email}
        onChangeText={setEmail}
      />
      {canDisable ? (
        <SettingsRow
          title="Enabled"
          desc="When off, this account and its tokens stop working."
          control={<SettingsToggle on={isActive} onChange={setIsActive} />}
          last
        />
      ) : null}
      <AdminButton
        label="Save changes"
        icon="save"
        busy={busy}
        disabled={Object.keys(patch).length === 0}
        onPress={() => onSubmit(patch)}
      />
    </View>
  )
}

export function NewServiceTokenForm({
  account,
  busy,
  onSubmit,
}: {
  account: ABSAdminUser
  busy: boolean
  onSubmit: (name: string) => void
}) {
  const colors = useColors()
  const [name, setName] = useState('')
  const nameError = reservedKeyNameError(name)
  return (
    <View style={{ gap: spacing.md }}>
      <HttpWarning />
      <AppText variant="meta" color={colors.textMuted}>
        The app you give this token to acts as {account.username}.
      </AppText>
      <AdminField
        inSheet
        label="Token name"
        placeholder="Backup script"
        error={nameError}
        autoCapitalize="sentences"
        value={name}
        onChangeText={setName}
      />
      <AdminButton
        label="Create token"
        icon="key"
        busy={busy}
        disabled={!name.trim() || Boolean(nameError)}
        onPress={() => onSubmit(name.trim())}
      />
    </View>
  )
}
