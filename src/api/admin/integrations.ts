/** External services the server talks to, and ABS's custom metadata providers. */
import {
  ABS_ENDPOINTS,
  HS_ENDPOINTS,
  type ABSCustomProvider,
  type HSIntegrationsConfig,
  type HSIntegrationsPatch,
} from '@hearthshelf/core'
import { adminRequest } from '@/api/abs'

export function getIntegrationsConfig(): Promise<HSIntegrationsConfig> {
  return adminRequest<HSIntegrationsConfig>(HS_ENDPOINTS.integrationsConfig)
}

/** Saving a ReadMeABook change makes the server sign in to it first, so it can take
 *  longer than a plain write. */
export function saveIntegrationsConfig(patch: HSIntegrationsPatch): Promise<HSIntegrationsConfig> {
  return adminRequest<HSIntegrationsConfig>(
    HS_ENDPOINTS.integrationsConfig,
    { method: 'PUT', body: JSON.stringify(patch) },
    { timeoutMs: 30000 },
  )
}

export async function getCustomProviders(): Promise<ABSCustomProvider[]> {
  const res = await adminRequest<{ providers?: ABSCustomProvider[] }>(
    ABS_ENDPOINTS.customMetadataProviders,
  )
  return res.providers ?? []
}
