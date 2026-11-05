/** Loads the account an edit screen works on from its `id` param, and handles every
 *  case where there is nothing to edit. */
import { useLocalSearchParams } from 'expo-router'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { useAdminResource } from '@/admin/useAdminResource'
import { useSelfAccount, userGuards, type UserGuards } from '@/admin/UserGuards'
import { adminErrorKind } from '@/api/admin/errors'
import { getUserDetail, type AdminUserDetail } from '@/api/admin/users'
import { icons } from '@/ui/icons'
import { Loading } from '@/ui/primitives'
import { EmptyState } from '@/ui/states'

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
  children: (detail: AdminUserDetail, guards: UserGuards) => React.ReactNode
}) {
  const { id } = useLocalSearchParams<{ id: string }>()
  const self = useSelfAccount()
  const detail = useAdminResource(() => getUserDetail(id))

  if (!detail.data) {
    if (detail.loading) return <Loading />
    if (adminErrorKind(detail.error) === 'missing') return <UserNotFound />
    return <AdminUnavailable error={detail.error} onRetry={detail.reload} />
  }
  const guards = userGuards(detail.data.user, self)
  if (!guards.canEdit) {
    return (
      <EmptyState
        icon={icons.lock}
        title="Only root can change this"
        body="A root account can only be edited while signed in as root."
      />
    )
  }
  return children(detail.data, guards)
}
