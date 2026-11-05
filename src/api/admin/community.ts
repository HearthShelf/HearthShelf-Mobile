/**
 * Community defaults, feature switches, and the anonymous stats opt-in.
 *
 * Unlike getCommunityConfig in src/api/social.ts, a failed read throws. Falling
 * back to defaults would show an admin settings the server never reported.
 */
import {
  HS_ENDPOINTS,
  mapCommunityConfig,
  type HSCommunityConfig,
  type HSCommunityConfigPatch,
  type HSTelemetryStatus,
} from '@hearthshelf/core'
import { ABSRequestError, adminRequest } from '@/api/abs'

const CONFIG = HS_ENDPOINTS.socialCommunityConfig

export async function getCommunityConfig(): Promise<HSCommunityConfig> {
  const data = await adminRequest<Partial<HSCommunityConfig> | undefined>(CONFIG)
  if (!data) throw new ABSRequestError(502, CONFIG)
  return mapCommunityConfig(data)
}

export async function setCommunityConfig(patch: HSCommunityConfigPatch): Promise<void> {
  await adminRequest(CONFIG, { method: 'PUT', body: JSON.stringify(patch) })
}

export async function getTelemetry(): Promise<HSTelemetryStatus> {
  const data = await adminRequest<HSTelemetryStatus | undefined>(HS_ENDPOINTS.telemetry)
  if (!data) throw new ABSRequestError(502, HS_ENDPOINTS.telemetry)
  return data
}

export async function setTelemetryEnabled(enabled: boolean): Promise<void> {
  await adminRequest(HS_ENDPOINTS.telemetry, {
    method: 'PUT',
    body: JSON.stringify({ enabled }),
  })
}
