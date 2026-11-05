/** Every user's listening sessions. */
import { ABS_ENDPOINTS, type ABSAdminSession, type ABSSessionsResponse } from '@hearthshelf/core'
import { adminRequest } from '@/api/abs'
import type { PagedResult } from '@/ui/usePagedList'

/** The server adds who listened. It is missing once that account has been deleted. */
export type AdminSessionRow = ABSAdminSession & {
  user?: { id: string; username: string } | null
}

type AdminSessionsResponse = Omit<ABSSessionsResponse, 'sessions'> & {
  sessions?: AdminSessionRow[]
}

/** The server pages by number and the list anchors on rows held, so a page can start
 *  before `offset`. `desc=1` is required: the server sorts oldest first without it. */
export async function getAdminSessions(
  offset: number,
  limit: number,
): Promise<PagedResult<AdminSessionRow>> {
  const page = Math.floor(offset / limit)
  const res = await adminRequest<AdminSessionsResponse>(
    `${ABS_ENDPOINTS.sessions}?page=${page}&itemsPerPage=${limit}&sort=updatedAt&desc=1`,
  )
  const rows = res.sessions ?? []
  return { rows: rows.slice(offset - page * limit), total: res.total ?? 0 }
}

export function deleteAdminSession(sessionId: string): Promise<unknown> {
  return adminRequest<unknown>(ABS_ENDPOINTS.listeningSession(sessionId), { method: 'DELETE' })
}
