/**
 * One account type, enabled state and permission set for every selected user,
 * replacing what each had. Sent one user at a time, so a failure names who was
 * missed and the rest still apply. Only confirmed people are changed: your own
 * account, root and machine accounts are left out entirely, even from a deep link.
 */
import { useMemo, useRef, useState } from 'react'
import { router, useLocalSearchParams } from 'expo-router'
import { bulkUserPatch, defaultPermissions } from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { TypedConfirm } from '@/admin/TypedConfirm'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { UserAccessForm, type UserAccess } from '@/admin/UserAccessForm'
import { markBulkFinished, useMachineCheck, useSelfAccount } from '@/admin/UserGuards'
import { getMe } from '@/api/abs'
import { adminWriteMessage } from '@/api/admin/errors'
import { getUsers, updateUser } from '@/api/admin/users'
import { icons } from '@/ui/icons'
import { AppText, Loading, type SheetRef } from '@/ui/primitives'
import { SettingsPanel } from '@/ui/settingsControls'
import { EmptyState, ErrorState } from '@/ui/states'
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

function Bulk() {
  const colors = useColors()
  const { ids } = useLocalSearchParams<{ ids?: string }>()
  const self = useSelfAccount()
  const accounts = useAdminResource(getUsers)
  const machine = useMachineCheck()
  const { run, busy } = useAdminWrite()
  const confirmRef = useRef<SheetRef>(null)
  const [failure, setFailure] = useState<string | null>(null)
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
  if (machine.failed) {
    return (
      <ErrorState
        title="Couldn't check these accounts"
        message="Changing a machine account can break the server, so this is off until we know which accounts are machines."
        onRetry={machine.reload}
      />
    )
  }
  if (accounts.loading || !machine.known) return <Loading />

  const people = selected.filter((u) => machine.stateOf(u) === 'person')
  const machineNames = selected
    .filter((u) => machine.stateOf(u) !== 'person')
    .map((u) => u.username)
    .join(', ')
  const targets = people.filter((u) => u.id !== self.id && u.type !== 'root')
  const leftOut = people.length - targets.length
  const names = targets.map((u) => u.username).join(', ')

  if (targets.length === 0) {
    return (
      <EmptyState
        icon={icons.person}
        title="No one to change"
        body="Your own account, root accounts and machine accounts can't be changed here."
      />
    )
  }

  async function apply() {
    const failed: string[] = []
    let firstError: unknown = null
    await run(
      async () => {
        for (const user of targets) {
          try {
            await updateUser(user.id, bulkUserPatch(user, access, self.id))
          } catch (e) {
            failed.push(user.username)
            firstError ??= e
          }
        }
      },
      { failed: "Couldn't update those users.", reload: accounts.reload },
    )
    if (failed.length > 0) {
      const reason = adminWriteMessage(firstError, "Couldn't update them.")
      setFailure(`${reason} Check these accounts: ${failed.join(', ')}.`)
      return
    }
    setFailure(null)
    markBulkFinished()
    showToast(`Updated ${countLabel(targets.length)}`)
    router.back()
  }

  return (
    <SettingsPanel>
      <AppText variant="meta" color={colors.textMuted}>
        These settings replace the account type, enabled state and all permissions of {names}.
      </AppText>
      {leftOut > 0 ? (
        <AppText variant="meta" color={colors.textMuted}>
          Your own account and root accounts are left out, and stay exactly as they are.
        </AppText>
      ) : null}

      {machineNames ? (
        <AppText variant="meta" color={colors.textMuted}>
          Machine accounts are left out and stay as they are: {machineNames}.
        </AppText>
      ) : null}

      <UserAccessForm value={access} onChange={setAccess} />

      {failure ? (
        <AppText variant="meta" color={colors.destructive}>
          {failure}
        </AppText>
      ) : null}
      {self.id ? null : (
        <>
          <AppText variant="meta" color={colors.destructive}>
            We can't tell which account is yours yet, so Apply is off. Your own account must be left
            out.
          </AppText>
          <AdminButton
            label="Try again"
            kind="secondary"
            onPress={() => void getMe().catch(() => {})}
          />
        </>
      )}
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
