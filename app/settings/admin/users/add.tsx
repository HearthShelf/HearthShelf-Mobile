/** Create an account by hand, with a password you choose for them. */
import { useState } from 'react'
import { router } from 'expo-router'
import { defaultPermissions } from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminField } from '@/admin/AdminField'
import { AdminGate } from '@/admin/AdminGate'
import { HttpWarning } from '@/admin/HttpWarning'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { UserAccessForm, type UserAccess } from '@/admin/UserAccessForm'
import { createUser, getUsers } from '@/api/admin/users'
import { SettingsPanel } from '@/ui/settingsControls'

export default function AddUserScreen() {
  return (
    <AdminGate>
      <AddUser />
    </AdminGate>
  )
}

function AddUser() {
  // A create that timed out may have worked. Reloading this shows the name as taken,
  // so the admin isn't left retrying blind.
  const accounts = useAdminResource(getUsers)
  const { run, busy } = useAdminWrite()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [email, setEmail] = useState('')
  const [access, setAccess] = useState<UserAccess>({
    type: 'user',
    isActive: true,
    permissions: defaultPermissions('user'),
  })
  const name = username.trim()
  const mismatch = again.length > 0 && password !== again
  const taken = accounts.data?.users.some((u) => u.username === name) ?? false

  async function create() {
    const ok = await run(
      () => createUser({ ...access, username: name, password, email: email.trim() || null }),
      {
        done: `Created ${name}`,
        failed: "Couldn't create the user.",
        reload: accounts.reload,
      },
    )
    if (ok) router.back()
  }

  return (
    <SettingsPanel>
      <HttpWarning />
      <AdminField
        label="Username"
        value={username}
        onChangeText={setUsername}
        placeholder="e.g. listener"
        error={taken ? 'That username is taken.' : undefined}
      />
      <AdminField
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType="newPassword"
      />
      <AdminField
        label="Password again"
        value={again}
        onChangeText={setAgain}
        secureTextEntry
        textContentType="newPassword"
        error={mismatch ? "These don't match." : undefined}
      />
      <AdminField
        label="Email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        placeholder="Optional"
      />
      <UserAccessForm value={access} onChange={setAccess} />
      <AdminButton
        label="Create user"
        icon="person-add"
        busy={busy}
        disabled={!name || !password || password !== again || taken}
        onPress={() => void create()}
      />
    </SettingsPanel>
  )
}
