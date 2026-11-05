/** Server identity for the admin home: its name and what it is running. */
import { HS_ENDPOINTS, type HSRuntimeInfo } from '@hearthshelf/core'
import { adminRequest } from '@/api/abs'

export function getServerRuntime(): Promise<HSRuntimeInfo> {
  return adminRequest<HSRuntimeInfo>(HS_ENDPOINTS.runtime)
}
