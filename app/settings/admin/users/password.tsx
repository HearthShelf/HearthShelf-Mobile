/** Set a new password for an account. */
import { useState } from 'react'
import { router } from 'expo-router'
import { AdminButton } from '@/admin/AdminButton'
import { AdminField } from '@/admin/AdminField'
import { AdminGate } from '@/admin/AdminGate'
import { HttpWarning } from '@/admin/HttpWarning'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { UserEditLoader } from '@/admin/UserEditLoader'
import { updateUser, type AdminUserDetail } from '@/api/admin/users'
import { confirm } from '@/ui/confirm'
import { SettingsPanel } from '@/ui/settingsControls'

export default function ResetPasswordScreen() {
  return (
    <AdminGate>
      <UserEditLoader>
        {(detail, _, reload) => <PasswordForm user={detail.user} reload={reload} />}
      </UserEditLoader>
    </AdminGate>
  )
}

function PasswordForm({ user, reload }: { user: AdminUserDetail['user']; reload: () => void }) {
  const { run, busy } = useAdminWrite()
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const mismatch = again.length > 0 && password !== again

  async function save() {
    const ok = await confirm({
      title: 'Reset password',
      message: `Change the password for ${user.username}? Their old password stops working, and they may be signed out.`,
      confirmLabel: 'Reset password',
    })
    if (!ok) return
    const saved = await run(() => updateUser(user.id, { password }), {
      done: 'Password changed',
      failed: "Couldn't change the password.",
      reload,
    })
    if (saved) router.back()
  }

  return (
    <SettingsPanel>
      <HttpWarning />
      <AdminField
        label="New password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        textContentType="newPassword"
      />
      <AdminField
        label="New password again"
        value={again}
        onChangeText={setAgain}
        secureTextEntry
        textContentType="newPassword"
        error={mismatch ? "These don't match." : undefined}
      />
      <AdminButton
        label="Save password"
        icon="save"
        busy={busy}
        disabled={!password || password !== again}
        onPress={() => void save()}
      />
    </SettingsPanel>
  )
}
