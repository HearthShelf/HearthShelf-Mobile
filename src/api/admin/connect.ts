/** HearthShelf Connect health. Everything that changes the connection is web only. */
import {
  HostedError,
  HS_ENDPOINTS,
  type HSHostedHsDirectState,
  type HSHostedPortCheckResult,
  type HSServiceHealth,
} from '@hearthshelf/core'
import { ABSRequestError, adminRequest } from '@/api/abs'

export function getServiceHealth(): Promise<HSServiceHealth> {
  return adminRequest<HSServiceHealth>(HS_ENDPOINTS.hostedServiceHealth)
}

export function getSecureAddress(): Promise<HSHostedHsDirectState> {
  return adminRequest<HSHostedHsDirectState>(HS_ENDPOINTS.hostedHsDirect)
}

/**
 * Throws a HostedError so the screen can use isHostedOutage. This route's own 502s
 * (probe_failed, broker_unreachable) mean the check service failed, not the box. A
 * 502 from a proxy in front of the box carries neither code and stays an error.
 */
export async function checkPort(): Promise<HSHostedPortCheckResult> {
  try {
    return await adminRequest<HSHostedPortCheckResult>(HS_ENDPOINTS.hostedPortCheck)
  } catch (e) {
    if (!(e instanceof ABSRequestError)) throw new HostedError('network', 0, null)
    if (e.status === 502 && /probe_failed|broker_unreachable/.test(e.detail)) {
      throw new HostedError('broker_unreachable', 502, null)
    }
    throw e
  }
}
