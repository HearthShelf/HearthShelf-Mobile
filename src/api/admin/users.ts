/** ABS user accounts and the per-user reads behind the admin Users section. */
import {
  ABS_ENDPOINTS,
  HS_ENDPOINTS,
  defaultPermissions,
  lastSeenByUser,
  onlineUserIds,
  type ABSAdminSession,
  type ABSAdminUser,
  type ABSListeningSessionsResponse,
  type ABSListeningStats,
  type ABSUserMediaProgress,
  type ABSUserPermissions,
  type ABSUsersOnlineResponse,
  type ABSUsersResponse,
  type ABSUserType,
  type ServiceAccountIdsResponse,
  type UserFormValues,
} from '@hearthshelf/core'
import { adminRequest } from '@/api/abs'

/** GET /api/users/:id. ABS sends library and tag access beside `permissions`, not
 *  inside it, though it accepts them in either place on write. */
type ABSUserRecord = ABSAdminUser & {
  itemTagsSelected?: string[]
  mediaProgress?: Partial<ABSUserMediaProgress>[]
}

export interface AdminUserDetail {
  user: ABSAdminUser
  /** The full permission set, with library and tag access folded back in. */
  permissions: ABSUserPermissions
  progress: ABSUserMediaProgress[]
}

export type UserPatch = Partial<UserFormValues> & { password?: string }

export function getUsers(): Promise<ABSUsersResponse> {
  return adminRequest<ABSUsersResponse>(ABS_ENDPOINTS.users)
}

export async function getOnlineUserIds(): Promise<Set<string>> {
  return onlineUserIds(await adminRequest<ABSUsersOnlineResponse>(ABS_ENDPOINTS.usersOnline))
}

/** Last activity per user, from the newest 200 sessions. */
export async function getLastSeenByUser(): Promise<Map<string, number>> {
  const res = await adminRequest<{ sessions?: ABSAdminSession[] }>(
    `${ABS_ENDPOINTS.sessions}?page=0&itemsPerPage=200`,
  )
  return lastSeenByUser(res.sessions ?? [])
}

export async function getServiceAccountIds(): Promise<Set<string>> {
  const res = await adminRequest<ServiceAccountIdsResponse>(HS_ENDPOINTS.serviceAccounts)
  return new Set(res.ids)
}

function progressFraction(p: Partial<ABSUserMediaProgress>): number {
  if (p.isFinished) return 1
  const duration = p.duration ?? 0
  const position = p.currentTime ?? 0
  if (duration > 0 && position > 0) return Math.min(1, position / duration)
  return Math.min(1, Math.max(0, p.progress ?? 0))
}

export async function getUserDetail(userId: string): Promise<AdminUserDetail> {
  const res = await adminRequest<ABSUserRecord>(ABS_ENDPOINTS.user(userId))
  return {
    user: res,
    permissions: {
      ...defaultPermissions('user'),
      ...res.permissions,
      librariesAccessible: res.permissions?.librariesAccessible ?? res.librariesAccessible ?? [],
      itemTagsSelected: res.permissions?.itemTagsSelected ?? res.itemTagsSelected ?? [],
    },
    progress: (res.mediaProgress ?? []).map((p) => ({
      id: p.id ?? '',
      libraryItemId: p.libraryItemId ?? '',
      episodeId: p.episodeId ?? null,
      duration: p.duration ?? 0,
      progress: progressFraction(p),
      currentTime: p.currentTime ?? 0,
      isFinished: Boolean(p.isFinished),
      hideFromContinueListening: Boolean(p.hideFromContinueListening),
      lastUpdate: p.lastUpdate ?? 0,
      startedAt: p.startedAt ?? 0,
      finishedAt: p.finishedAt ?? null,
      displayTitle: p.displayTitle,
    })),
  }
}

export function getUserListeningStats(userId: string): Promise<ABSListeningStats> {
  return adminRequest<ABSListeningStats>(ABS_ENDPOINTS.userListeningStats(userId))
}

export async function getUserListeningSessions(
  userId: string,
  page: number,
  itemsPerPage: number,
): Promise<ABSListeningSessionsResponse> {
  const res = await adminRequest<Partial<ABSListeningSessionsResponse>>(
    `${ABS_ENDPOINTS.userListeningSessions(userId)}?page=${page}&itemsPerPage=${itemsPerPage}`,
  )
  return {
    total: res.total ?? 0,
    numPages: res.numPages ?? 0,
    page: res.page ?? page,
    itemsPerPage: res.itemsPerPage ?? itemsPerPage,
    sessions: res.sessions ?? [],
  }
}

export function createUser(
  values: UserFormValues & { password: string },
): Promise<{ user: ABSAdminUser }> {
  return adminRequest<{ user: ABSAdminUser }>(ABS_ENDPOINTS.users, {
    method: 'POST',
    body: JSON.stringify({
      username: values.username,
      password: values.password,
      email: values.email || null,
      type: values.type,
      isActive: values.isActive,
      permissions: values.permissions,
    }),
  })
}

/** Sends only what is in the patch. A blank password is never sent. */
export function updateUser(userId: string, patch: UserPatch): Promise<{ user: ABSAdminUser }> {
  const { password, ...rest } = patch
  return adminRequest<{ user: ABSAdminUser }>(ABS_ENDPOINTS.user(userId), {
    method: 'PATCH',
    body: JSON.stringify(password ? { ...rest, password } : rest),
  })
}

export interface PermissionChoices {
  libraries: { id: string; label: string }[]
  tags: { id: string; label: string }[]
}

/** What the library and tag access pickers offer. */
export async function getPermissionChoices(): Promise<PermissionChoices> {
  const [libs, tags] = await Promise.all([
    adminRequest<{ libraries?: { id: string; name: string }[] }>(ABS_ENDPOINTS.libraries),
    adminRequest<{ tags?: string[] }>(ABS_ENDPOINTS.tags),
  ])
  return {
    libraries: (libs.libraries ?? []).map((l) => ({ id: l.id, label: l.name })),
    tags: (tags.tags ?? []).map((t) => ({ id: t, label: t })),
  }
}

/** A stored account type as one the form can pick. Root is never written. */
export function formUserType(type: string): ABSUserType {
  return type === 'guest' || type === 'admin' ? type : 'user'
}
