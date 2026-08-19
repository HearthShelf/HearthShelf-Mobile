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

export function markNotificationRead(id: string): Promise<boolean> {
  return mark(`/hs/notifications/${encodeURIComponent(id)}/read`)
}

export function markAllNotificationsRead(): Promise<boolean> {
  return mark('/hs/notifications/read-all')
}
