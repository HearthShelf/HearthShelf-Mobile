/**
 * One account type, enabled state and permission set for every selected user,
 * replacing what each had. Sent one user at a time, so a failure names who was
 * missed and the rest still apply.
 */
import { useMemo, useRef, useState } from 'react'
import { router, useLocalSearchParams } from 'expo-router'
import {
  bulkSkipsSelf,
  bulkUserPatch,
  defaultPermissions,
  type ABSAdminUser,
} from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { TypedConfirm } from '@/admin/TypedConfirm'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { UserAccessForm, type UserAccess } from '@/admin/UserAccessForm'
import { markBulkFinished, useSelfAccount, userGuards, type SelfAccount } from '@/admin/UserGuards'
import { getUsers, updateUser, type UserPatch } from '@/api/admin/users'
import { icons } from '@/ui/icons'
import { AppText, Loading, type SheetRef } from '@/ui/primitives'
import { SettingsPanel } from '@/ui/settingsControls'
import { EmptyState } from '@/ui/states'
import { showToast } from '@/ui/Toast'
import { useColors } from '@/ui/ThemeProvider'

export default function BulkPermissionsScreen() {
  return (
    <AdminGate>
      <Bulk />
    </AdminGate>
  )
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? 'user' : 'users'}`
}

/** Core's patch, plus the two lockouts it leaves open: root stays as it is, and
 *  your own account keeps its type, the same as on the single-user screen. */
function safePatch(user: ABSAdminUser, access: UserAccess, self: SelfAccount): UserPatch {
  const patch: UserPatch = bulkUserPatch(user, access, self.id)
  const guards = userGuards(user, self)
  if (guards.isRoot) delete patch.isActive
  if (guards.isSelf) delete patch.type
  return patch
}

function Bulk() {
  const colors = useColors()
  const { ids } = useLocalSearchParams<{ ids?: string }>()
  const self = useSelfAccount()
  const accounts = useAdminResource(getUsers)
  const { run, busy } = useAdminWrite()
  const confirmRef = useRef<SheetRef>(null)
  const [failedNames, setFailedNames] = useState<string[]>([])
  const [access, setAccess] = useState<UserAccess>({
    type: 'user',
    isActive: true,
    permissions: defaultPermissions('user'),
  })

  const selected = useMemo(() => {
    const wanted = new Set((ids ?? '').split(',').filter(Boolean))
    return (accounts.data?.users ?? []).filter((u) => wanted.has(u.id))
  }, [accounts.data, ids])

  if (accounts.error && !accounts.data) {
    return <AdminUnavailable error={accounts.error} onRetry={accounts.reload} />
  }
  if (accounts.loading) return <Loading />

  const targets = selected.filter((u) => userGuards(u, self).canEdit)
  const skippedRoot = selected.length - targets.length
  const hasRoot = targets.some((u) => u.type === 'root')
  const includesSelf = targets.some((u) => u.id === self.id)
  const names = targets.map((u) => u.username).join(', ')

  if (targets.length === 0) {
    return (
      <EmptyState
        icon={icons.person}
        title="No one to change"
        body="Go back and select the people you want to change."
      />
    )
  }

  async function apply() {
    const failed: string[] = []
    await run(
      async () => {
        for (const user of targets) {
          try {
            await updateUser(user.id, safePatch(user, access, self))
          } catch {
            failed.push(user.username)
          }
        }
      },
      { failed: "Couldn't update those users.", reload: accounts.reload },
    )
    setFailedNames(failed)
    if (failed.length > 0) return
    markBulkFinished()
    showToast(
      `Updated ${countLabel(targets.length)}` +
        (bulkSkipsSelf(targets, access.isActive, self.id)
          ? '. Your own account stays enabled.'
          : ''),
    )
    router.back()
  }

  return (
    <SettingsPanel>
      <AppText variant="meta" color={colors.textMuted}>
        These settings replace the account type, enabled state and all permissions of {names}.
      </AppText>
      {hasRoot ? (
        <AppText variant="meta" color={colors.textMuted}>
          Root accounts only get the new permissions. Their type and enabled state stay the same.
        </AppText>
      ) : null}
      {includesSelf ? (
        <AppText variant="meta" color={colors.textMuted}>
          Your own account keeps its type and stays enabled.
        </AppText>
      ) : null}
      {skippedRoot > 0 ? (
        <AppText variant="meta" color={colors.textMuted}>
          Root accounts are skipped, because only root can change them.
        </AppText>
      ) : null}

      <UserAccessForm value={access} onChange={setAccess} />

      {failedNames.length > 0 ? (
        <AppText variant="meta" color={colors.destructive}>
          Couldn't update: {failedNames.join(', ')}. Check them, then try again.
        </AppText>
      ) : null}
      <AdminButton
        label={`Apply to ${countLabel(targets.length)}`}
        icon="save"
        busy={busy}
        disabled={!self.id}
        onPress={() => confirmRef.current?.present()}
      />

      <TypedConfirm
        ref={confirmRef}
        title={`Change ${countLabel(targets.length)}`}
        message={`${names} will become ${access.type} accounts, ${
          access.isActive ? 'enabled' : 'disabled'
        }, and lose any permissions not set here.`}
        confirmText={String(targets.length)}
        confirmLabel={`Apply to ${countLabel(targets.length)}`}
        onConfirm={() => void apply()}
      />
    </SettingsPanel>
  )
}
