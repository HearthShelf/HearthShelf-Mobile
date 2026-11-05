/** General server settings: the display name and the server-wide scanner and date options. */
import { ABS_ENDPOINTS, HS_ENDPOINTS, type ABSServerSettings } from '@hearthshelf/core'
import { ABSRequestError, adminRequest } from '@/api/abs'

/** ABS has no GET for these, so they come off POST /api/authorize. */
export async function getServerSettings(): Promise<ABSServerSettings> {
  const res = await adminRequest<{ serverSettings?: ABSServerSettings }>(ABS_ENDPOINTS.authorize, {
    method: 'POST',
  })
  if (!res?.serverSettings) throw new ABSRequestError(502, ABS_ENDPOINTS.authorize)
  return res.serverSettings
}

export async function updateServerSettings(patch: Partial<ABSServerSettings>): Promise<void> {
  await adminRequest(ABS_ENDPOINTS.serverSettings, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export async function setServerName(name: string): Promise<void> {
  await adminRequest(HS_ENDPOINTS.runtimeServerName, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}
