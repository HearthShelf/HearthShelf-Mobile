/** API keys, plus the user list the keys screen needs to label their owners. */
import {
  ABS_ENDPOINTS,
  type ABSAdminUser,
  type ABSApiKey,
  type ABSApiKeysResponse,
  type ABSUsersResponse,
} from '@hearthshelf/core'
import { ABSRequestError, adminRequest } from '@/api/abs'

/** Keys the server made for itself: one per person for their apps, and one it uses
 *  to set up invited people. It hands these out from a cache and only re-checks them
 *  every 12 hours, so revoking one locks that person or the box out until then. */
const PROTECTED_KEY_PREFIXES = ['hearthshelf-app:', 'hearthshelf-service:']

export function isProtectedKey(key: Pick<ABSApiKey, 'name'>): boolean {
  return PROTECTED_KEY_PREFIXES.some((prefix) => key.name.startsWith(prefix))
}

/** ABS lets any admin revoke root's keys, so the app holds that line itself. An
 *  owner we can't identify counts as root. */
export function canRevokeKey(
  key: Pick<ABSApiKey, 'name'>,
  ownerType: string | undefined,
  callerType: string,
): boolean {
  if (isProtectedKey(key)) return false
  return callerType === 'root' || (ownerType !== undefined && ownerType !== 'root')
}

/** A key with a reserved name could never be revoked in the app. */
export function reservedKeyNameError(name: string): string | undefined {
  return isProtectedKey({ name: name.trim() })
    ? 'HearthShelf saves names that start this way. Pick another name.'
    : undefined
}

export async function getApiKeys(): Promise<ABSApiKey[]> {
  const res = await adminRequest<Partial<ABSApiKeysResponse>>(ABS_ENDPOINTS.apiKeys)
  if (!res?.apiKeys) throw new ABSRequestError(502, ABS_ENDPOINTS.apiKeys)
  return res.apiKeys
}

/** The new key's token is on `apiKey`, on this response only. */
export async function createApiKey(
  name: string,
  userId: string,
  expiresIn: number | null,
): Promise<ABSApiKey> {
  const res = await adminRequest<{ apiKey?: ABSApiKey }>(ABS_ENDPOINTS.apiKeys, {
    method: 'POST',
    body: JSON.stringify({ name, userId, isActive: true, ...(expiresIn ? { expiresIn } : {}) }),
  })
  if (!res?.apiKey) throw new ABSRequestError(502, ABS_ENDPOINTS.apiKeys)
  return res.apiKey
}

export async function deleteApiKey(keyId: string): Promise<void> {
  await adminRequest(ABS_ENDPOINTS.apiKey(keyId), { method: 'DELETE' })
}

export async function getKeyOwners(): Promise<ABSAdminUser[]> {
  const res = await adminRequest<Partial<ABSUsersResponse>>(ABS_ENDPOINTS.users)
  if (!res?.users) throw new ABSRequestError(502, ABS_ENDPOINTS.users)
  return res.users
}
