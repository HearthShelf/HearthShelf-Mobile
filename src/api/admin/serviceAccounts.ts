/**
 * Service accounts are ordinary ABS admin users. HearthShelf only stores which ids
 * were tagged as machine logins, so every create and delete touches two systems and
 * can stop halfway. These functions report that rather than hide it.
 */
import {
  ABS_ENDPOINTS,
  HS_ENDPOINTS,
  isServiceAccount,
  type ABSAdminUser,
  type ABSUsersResponse,
  type ServiceAccountIdsResponse,
} from '@hearthshelf/core'
import { ABSRequestError, adminRequest } from '@/api/abs'
import { getServerRuntime } from './server'
import { getServiceAccountIds } from './users'

interface ServiceAccountsData {
  accounts: ABSAdminUser[]
  trackedIds: ReadonlySet<string>
  /** The box's auto-created account, which is matched by name and never tagged. */
  serviceUsername: string | null
}

export async function getServiceAccounts(): Promise<ServiceAccountsData> {
  const [users, trackedIds, runtime] = await Promise.all([
    adminRequest<ABSUsersResponse>(ABS_ENDPOINTS.users),
    getServiceAccountIds(),
    getServerRuntime(),
  ])
  const serviceUsername = runtime.serviceUsername ?? null
  return {
    accounts: users.users.filter((u) => isServiceAccount(u, trackedIds, serviceUsername)),
    trackedIds,
    serviceUsername,
  }
}

export function tagServiceAccount(userId: string): Promise<ServiceAccountIdsResponse> {
  return adminRequest<ServiceAccountIdsResponse>(HS_ENDPOINTS.serviceAccounts, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  })
}

export function untagServiceAccount(userId: string): Promise<ServiceAccountIdsResponse> {
  return adminRequest<ServiceAccountIdsResponse>(HS_ENDPOINTS.serviceAccount(userId), {
    method: 'DELETE',
  })
}

/** Creates the ABS user, then tags it. `tagged: false` means the user exists but
 *  still counts as a person, so the password must be shown anyway. */
export async function createServiceAccount(input: {
  username: string
  password: string
  email: string | null
}): Promise<{ user: ABSAdminUser; tagged: boolean }> {
  const { user } = await adminRequest<{ user: ABSAdminUser }>(ABS_ENDPOINTS.users, {
    method: 'POST',
    body: JSON.stringify({ ...input, type: 'admin', isActive: true }),
  })
  try {
    await tagServiceAccount(user.id)
    return { user, tagged: true }
  } catch {
    return { user, tagged: false }
  }
}

export interface ServiceAccountPatch {
  username?: string
  email?: string
  isActive?: boolean
  password?: string
}

export function updateServiceAccount(userId: string, patch: ServiceAccountPatch): Promise<unknown> {
  return adminRequest(ABS_ENDPOINTS.user(userId), {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

/** Deletes the ABS user, then clears the tag. A 404 counts as deleted: an earlier
 *  try may have timed out after ABS finished. A tag left behind matches no user, so
 *  it is reported but harmless. */
export async function deleteServiceAccount(userId: string): Promise<{ tagCleared: boolean }> {
  try {
    await adminRequest(ABS_ENDPOINTS.user(userId), { method: 'DELETE' })
  } catch (e) {
    if (!(e instanceof ABSRequestError && e.status === 404)) throw e
  }
  try {
    await untagServiceAccount(userId)
    return { tagCleared: true }
  } catch {
    return { tagCleared: false }
  }
}
