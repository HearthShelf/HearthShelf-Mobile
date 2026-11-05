/** API keys, plus the two lists the keys screen needs to label their owners. */
import {
  ABS_ENDPOINTS,
  HS_ENDPOINTS,
  type ABSAdminUser,
  type ABSApiKey,
  type ABSApiKeysResponse,
  type ABSUsersResponse,
  type ServiceAccountIdsResponse,
} from '@hearthshelf/core'
import { ABSRequestError, adminRequest } from '@/api/abs'

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

export async function getServiceAccountIds(): Promise<string[]> {
  const res = await adminRequest<Partial<ServiceAccountIdsResponse>>(HS_ENDPOINTS.serviceAccounts)
  if (!res?.ids) throw new ABSRequestError(502, HS_ENDPOINTS.serviceAccounts)
  return res.ids
}

export async function tagServiceAccount(userId: string): Promise<void> {
  await adminRequest(HS_ENDPOINTS.serviceAccounts, {
    method: 'POST',
    body: JSON.stringify({ userId }),
  })
}
