/** Edit an account's type, enabled state and permissions. Your own account and root
 *  keep their type and stay enabled, so an edit here can't lock anyone out. */
import { useState } from 'react'
import { router } from 'expo-router'
import { AdminButton } from '@/admin/AdminButton'
import { AdminGate } from '@/admin/AdminGate'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { UserAccessForm, type UserAccess } from '@/admin/UserAccessForm'
import { UserEditLoader } from '@/admin/UserEditLoader'
import type { UserGuards } from '@/admin/UserGuards'
import { formUserType, updateUser, type AdminUserDetail, type UserPatch } from '@/api/admin/users'
import { SettingsPanel } from '@/ui/settingsControls'

export default function EditPermissionsScreen() {
  return (
    <AdminGate>
      <UserEditLoader>
        {(detail, guards) => <PermissionsForm detail={detail} guards={guards} />}
      </UserEditLoader>
    </AdminGate>
  )
}

function PermissionsForm({ detail, guards }: { detail: AdminUserDetail; guards: UserGuards }) {
  const { user } = detail
  const { run, busy } = useAdminWrite()
  const [access, setAccess] = useState<UserAccess>({
    type: formUserType(user.type),
    isActive: user.isActive,
    permissions: detail.permissions,
  })
  const lockReason = guards.isRoot
    ? "A root account can't change this."
    : "You can't change this on your own account."

  async function save() {
    const patch: UserPatch = { permissions: access.permissions }
    if (guards.canChangeType) patch.type = access.type
    if (guards.canRemove) patch.isActive = access.isActive
    const ok = await run(() => updateUser(user.id, patch), {
      done: 'Permissions saved',
      failed: "Couldn't save the permissions.",
    })
    if (ok) router.back()
  }

  return (
    <SettingsPanel>
      <UserAccessForm
        value={access}
        onChange={setAccess}
        typeLocked={guards.canChangeType ? undefined : `${user.type}. ${lockReason}`}
        enabledLocked={guards.canRemove ? undefined : lockReason}
      />
      <AdminButton label="Save changes" icon="save" busy={busy} onPress={() => void save()} />
    </SettingsPanel>
  )
}
