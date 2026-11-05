/**
 * Who the signed-in admin is, and what that lets them do to an account. Until the
 * admin's own id is known, nothing that could lock them out is offered.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { ABSAdminUser } from '@hearthshelf/core'
import { getMe } from '@/api/abs'
import { getMeId, getMeType, subscribeMeId, subscribeMeType } from '@/api/me'

export interface SelfAccount {
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

export interface UserGuards {
  isSelf: boolean
  isRoot: boolean
  /** ABS refuses every edit to a root account unless it comes from root. */
  canEdit: boolean
  /** Covers disabling and deleting. Never yourself, never root. */
  canRemove: boolean
  /** The account type can change. Changing your own could end your admin access. */
  canChangeType: boolean
}

export function userGuards(user: Pick<ABSAdminUser, 'id' | 'type'>, self: SelfAccount): UserGuards {
  const isSelf = user.id === self.id
  const isRoot = user.type === 'root'
  const safe = self.id !== '' && !isSelf && !isRoot
  return {
    isSelf,
    isRoot,
    canEdit: !isRoot || self.type === 'root',
    canRemove: safe,
    canChangeType: safe,
  }
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
