/** The server's outgoing alerts: where they are sent, and which rules are on. */
import { ABS_ENDPOINTS, type ABSNotificationSettings } from '@hearthshelf/core'
import { ABSRequestError, adminRequest } from '@/api/abs'

export type AdminNotificationSettings = ABSNotificationSettings & {
  maxNotificationQueue?: number
}

export async function getNotificationSettings(): Promise<AdminNotificationSettings> {
  const res = await adminRequest<{ settings?: AdminNotificationSettings }>(
    ABS_ENDPOINTS.notifications,
  )
  if (!res?.settings) throw new ABSRequestError(502, ABS_ENDPOINTS.notifications)
  return { ...res.settings, notifications: res.settings.notifications ?? [] }
}

/** ABS resets maxNotificationQueue to 20 when a PATCH leaves it out, so callers
 *  send the current value back. It ignores notificationDelay altogether. */
export async function updateNotificationSettings(patch: {
  appriseApiUrl: string | null
  maxFailedAttempts: number
  maxNotificationQueue?: number
}): Promise<void> {
  await adminRequest(ABS_ENDPOINTS.notifications, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

/** ABS finds the rule by the id in the body, not the one in the path. */
export async function updateNotificationRule(id: string, enabled: boolean): Promise<void> {
  await adminRequest(ABS_ENDPOINTS.notification(id), {
    method: 'PATCH',
    body: JSON.stringify({ id, enabled }),
  })
}
