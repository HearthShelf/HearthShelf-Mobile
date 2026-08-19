import { getSession } from './session'

export interface HSNotification {
  id: string
  kind: string
  entityId: string | null
  title: string
  body: string
  data: Record<string, unknown>
  createdAt: number
  readAt: number | null
  actionStatus: string | null
}

export interface NotificationsResponse {
  notifications: HSNotification[]
  unreadCount: number
}

const EMPTY: NotificationsResponse = { notifications: [], unreadCount: 0 }

export async function getNotifications(): Promise<NotificationsResponse> {
  const session = getSession()
  if (!session) return EMPTY
  try {
    const res = await fetch(`${session.serverUrl}/hs/notifications`, {
      headers: { Authorization: `Bearer ${session.token}` },
    })
    if (!res.ok) return EMPTY
    const value = (await res.json()) as Partial<NotificationsResponse>
    return {
      notifications: Array.isArray(value.notifications) ? value.notifications : [],
      unreadCount: typeof value.unreadCount === 'number' ? value.unreadCount : 0,
    }
  } catch {
    return EMPTY
  }
}

async function mark(path: string): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  try {
    const res = await fetch(`${session.serverUrl}${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${session.token}` },
    })
    return res.ok
  } catch {
    return false
  }
}

/** Shared DELETE helper - mirrors `mark`, which does the same for PUT. */
async function remove(path: string): Promise<boolean> {
  const session = getSession()
  if (!session) return false
  try {
    const res = await fetch(`${session.serverUrl}${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${session.token}` },
    })
    return res.ok
  } catch {
    return false
  }
}

/** Dismiss one notification. */
export function deleteNotification(id: string): Promise<boolean> {
  return remove(`/hs/notifications/${encodeURIComponent(id)}`)
}

/** Clear the whole inbox. */
export function deleteAllNotifications(): Promise<boolean> {
  return remove('/hs/notifications')
}

export function markNotificationRead(id: string): Promise<boolean> {
  return mark(`/hs/notifications/${encodeURIComponent(id)}/read`)
}

export function markAllNotificationsRead(): Promise<boolean> {
  return mark('/hs/notifications/read-all')
}
