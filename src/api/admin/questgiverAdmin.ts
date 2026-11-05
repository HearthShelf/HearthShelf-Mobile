/** QuestGiver and Discover switches and provider status. The listener flow is in
 *  src/api/questgiver.ts. */
import {
  HS_ENDPOINTS,
  type HSQuestGiverAdminConfig,
  type HSQuestGiverAdminConfigUpdate,
} from '@hearthshelf/core'
import { adminRequest } from '@/api/abs'

const COPILOT_AUTH = '/hs/questgiver/admin/copilot'

interface QgCopilotAuth {
  authenticated: boolean
  login: string | null
}

export interface QgAdminStatus {
  config: HSQuestGiverAdminConfig
  /** Null unless the provider signs in through GitHub, or that check failed. */
  copilot: QgCopilotAuth | null
  copilotCheckFailed: boolean
}

/** A Copilot sign-in lives outside the saved key, so `hasKey` alone would call a
 *  connected account unset. */
export async function getQgAdminStatus(): Promise<QgAdminStatus> {
  const config = await adminRequest<HSQuestGiverAdminConfig>(HS_ENDPOINTS.questgiverAdminConfig)
  if (config.provider !== 'copilot' || config.hasKey) {
    return { config, copilot: null, copilotCheckFailed: false }
  }
  try {
    const copilot = await adminRequest<QgCopilotAuth>(COPILOT_AUTH)
    return { config, copilot, copilotCheckFailed: false }
  } catch {
    return { config, copilot: null, copilotCheckFailed: true }
  }
}

/** Fields left out of the patch keep their saved values on the server. */
export function saveQgAdminConfig(
  patch: Pick<HSQuestGiverAdminConfigUpdate, 'enabled' | 'discoverEnabled'>,
): Promise<HSQuestGiverAdminConfig> {
  return adminRequest<HSQuestGiverAdminConfig>(HS_ENDPOINTS.questgiverAdminConfig, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}
