/** Loads the account an edit screen works on from its `id` param, and handles every
 *  case where there is nothing to edit. */
import { router, useLocalSearchParams } from 'expo-router'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { useAdminResource } from '@/admin/useAdminResource'
import { useMachineCheck, useSelfAccount, userGuards, type UserGuards } from '@/admin/UserGuards'
import { adminErrorKind } from '@/api/admin/errors'
import { getUserDetail, type AdminUserDetail } from '@/api/admin/users'
import { icons } from '@/ui/icons'
import { Loading } from '@/ui/primitives'
import { EmptyState, ErrorState } from '@/ui/states'

export function UserNotFound() {
  return (
    <EmptyState
      icon={icons.person}
      title="User not found"
      body="This account may have been deleted."
    />
  )
}

export function UserEditLoader({
  children,
}: {
  children: (detail: AdminUserDetail, guards: UserGuards, reload: () => void) => React.ReactNode
}) {
  const { id } = useLocalSearchParams<{ id: string }>()
  const self = useSelfAccount()
  const detail = useAdminResource(() => getUserDetail(id))
  const machine = useMachineCheck()

  if (!detail.data) {
    if (detail.loading) return <Loading />
    if (adminErrorKind(detail.error) === 'missing') return <UserNotFound />
    return <AdminUnavailable error={detail.error} onRetry={detail.reload} />
  }
  const state = machine.stateOf(detail.data.user)
  if (state === 'unknown') {
    if (machine.failed) {
      return (
        <ErrorState
          title="Couldn't check this account"
          message="Changing a machine account can break the server, so editing is off until we know."
          onRetry={machine.reload}
        />
      )
    }
    return <Loading />
  }
  if (state === 'machine') {
    return (
      <EmptyState
        icon={icons.lock}
        title="This is a machine account"
        body="Changes here could break the server. Use Service accounts instead."
        cta="Service accounts"
        onCta={() => router.replace('/settings/admin/service-accounts')}
      />
    )
  }
  const guards = userGuards(detail.data.user, self, state)
  if (!guards.canEdit) {
    return (
      <EmptyState
        icon={icons.lock}
        title="Only root can change this"
        body="A root account can only be edited while signed in as root."
      />
    )
  }
  return children(detail.data, guards, detail.reload)
}
