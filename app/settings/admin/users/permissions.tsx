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
import { confirm } from '@/ui/confirm'
import { SettingsPanel } from '@/ui/settingsControls'

export default function EditPermissionsScreen() {
  return (
    <AdminGate>
      <UserEditLoader>
        {(detail, guards, reload) => (
          <PermissionsForm detail={detail} guards={guards} reload={reload} />
        )}
      </UserEditLoader>
    </AdminGate>
  )
}

const TYPE_RANK: Record<string, number> = { guest: 0, user: 1, admin: 2 }

function PermissionsForm({
  detail,
  guards,
  reload,
}: {
  detail: AdminUserDetail
  guards: UserGuards
  reload: () => void
}) {
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
    const losses: string[] = []
    if (guards.canRemove && user.isActive && !access.isActive) {
      losses.push("be disabled and won't be able to sign in")
    }
    if (guards.canChangeType && TYPE_RANK[access.type] < (TYPE_RANK[user.type] ?? 0)) {
      losses.push(`go from ${user.type} to ${access.type}`)
    }
    if (losses.length > 0) {
      const ok = await confirm({
        title: 'Save changes',
        message: `${user.username} will ${losses.join(' and ')}. Save anyway?`,
        confirmLabel: 'Save changes',
      })
      if (!ok) return
    }
    const patch: UserPatch = { permissions: access.permissions }
    if (guards.canChangeType) patch.type = access.type
    if (guards.canRemove) patch.isActive = access.isActive
    const ok = await run(() => updateUser(user.id, patch), {
      done: 'Permissions saved',
      failed: "Couldn't save the permissions.",
      reload,
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
