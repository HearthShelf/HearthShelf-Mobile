/**
 * Who the signed-in admin is, and what that lets them do to an account. Anything
 * not yet known counts against the action: until the admin's own id is known, and
 * until we know an account belongs to a person, nothing that could lock someone out
 * or break the server's own login is offered.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { isServiceAccount, type ABSAdminUser } from '@hearthshelf/core'
import { useAdminResource } from '@/admin/useAdminResource'
import { getMe } from '@/api/abs'
import { getServerRuntime } from '@/api/admin/server'
import { getServiceAccountIds } from '@/api/admin/users'
import { getMeId, getMeType, subscribeMeId, subscribeMeType } from '@/api/me'

interface SelfAccount {
  /** Empty until known. */
  id: string
  type: string
}

export function useSelfAccount(): SelfAccount {
  const id = useSyncExternalStore(subscribeMeId, getMeId)
  const type = useSyncExternalStore(subscribeMeType, getMeType)
  useEffect(() => {
    if (!id) void getMe().catch(() => {})
  }, [id])
  return { id, type }
}

export type MachineState = 'person' | 'machine' | 'unknown'

/** Which accounts are machine logins: anything tagged, plus the server's own. */
export function useMachineCheck() {
  const ids = useAdminResource(getServiceAccountIds)
  const runtime = useAdminResource(getServerRuntime)
  const known = Boolean(ids.data && runtime.data)
  const serviceIds = ids.data
  const serviceUsername = runtime.data?.serviceUsername ?? null
  return {
    known,
    /** True once a read has failed with nothing to fall back on. */
    failed: !known && Boolean((!ids.data && ids.error) || (!runtime.data && runtime.error)),
    settling: ids.loading || runtime.loading,
    serviceIds,
    serviceUsername,
    stateOf(user: Pick<ABSAdminUser, 'id' | 'username'>): MachineState {
      if (!known || !serviceIds) return 'unknown'
      return isServiceAccount(user, serviceIds, serviceUsername) ? 'machine' : 'person'
    },
    reload() {
      ids.reload()
      runtime.reload()
    },
  }
}

export interface UserGuards {
  isSelf: boolean
  isRoot: boolean
  /** Username, password and permissions. Only for people, and root only by root. */
  canEdit: boolean
  /** Covers disabling and deleting. Never yourself, never root. */
  canRemove: boolean
  /** The account type can change. Changing your own could end your admin access. */
  canChangeType: boolean
}

/** ABS refuses every edit to a root account unless it comes from root. */
export function canEditAccount(user: Pick<ABSAdminUser, 'type'>, self: SelfAccount): boolean {
  return user.type !== 'root' || self.type === 'root'
}

export function userGuards(
  user: Pick<ABSAdminUser, 'id' | 'type'>,
  self: SelfAccount,
  machine: MachineState,
): UserGuards {
  const isSelf = user.id === self.id
  const isRoot = user.type === 'root'
  const canEdit = machine === 'person' && canEditAccount(user, self)
  const safe = canEdit && self.id !== '' && !isSelf && !isRoot
  return { isSelf, isRoot, canEdit, canRemove: safe, canChangeType: safe }
}

// The bulk screen can't hand a result back through the stack, so it leaves this
// for the list to pick up when it regains focus.
let bulkFinished = false

export function markBulkFinished(): void {
  bulkFinished = true
}

export function takeBulkFinished(): boolean {
  const finished = bulkFinished
  bulkFinished = false
  return finished
}
