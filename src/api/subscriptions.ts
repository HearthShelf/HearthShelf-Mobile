/**
 * Release-subscriptions + push-token client. Same direct-origin convention as
 * absAudible.ts / getServerQueue: talks to the connected server's own /hs
 * surface with the per-user ABS bearer token. Subscriptions carry their full
 * display payload, so the Home banner + settings list render straight from the
 * GET without any Audible round-trip.
 */
import { getSession } from './session'
import type {
  HSSubscription,
  HSSubscriptionCreate,
  HSSubscriptionsResponse,
} from '@hearthshelf/core'

function requireSession() {
  const s = getSession()
  if (!s) throw new Error('not_connected')
  return s
}

export async function getSubscriptions(): Promise<HSSubscription[]> {
  const { serverUrl, token } = requireSession()
  const res = await fetch(`${serverUrl}/hs/subscriptions`, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`subscriptions ${res.status}`)
  const data = (await res.json()) as HSSubscriptionsResponse
  return data.subscriptions ?? []
}

export async function createSubscription(
  sub: HSSubscriptionCreate & { id?: string },
): Promise<HSSubscription> {
  const { serverUrl, token } = requireSession()
  const res = await fetch(`${serverUrl}/hs/subscriptions`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(sub),
  })
  if (!res.ok) throw new Error(`subscribe ${res.status}`)
  const data = (await res.json()) as { subscription: HSSubscription }
  return data.subscription
}

export async function deleteSubscription(id: string): Promise<void> {
  const { serverUrl, token } = requireSession()
  const res = await fetch(`${serverUrl}/hs/subscriptions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`unsubscribe ${res.status}`)
}

/** Register this device's Expo push token so the server can notify it. */
export async function registerPushToken(
  pushToken: string,
  platform: 'ios' | 'android',
): Promise<void> {
  const { serverUrl, token } = requireSession()
  const res = await fetch(`${serverUrl}/hs/push/register`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ token: pushToken, platform }),
  })
  if (!res.ok) throw new Error(`push register ${res.status}`)
}
