/** The phone's slice of email: e-reader devices, a test send, and relay status. */
import {
  ABS_ENDPOINTS,
  HS_ENDPOINTS,
  type ABSEmailSettings,
  type ABSEreaderDevice,
  type HSHostedEmailRelayStatus,
} from '@hearthshelf/core'
import { ABSRequestError, adminRequest } from '@/api/abs'

/** ABS also keeps who may use a device. A device list write replaces everything,
 *  so these have to survive the round trip. */
export type EreaderDevice = ABSEreaderDevice & {
  availabilityOption?: string
  users?: string[]
}

export type EmailSettings = Pick<ABSEmailSettings, 'host' | 'fromAddress' | 'testAddress'> & {
  ereaderDevices: EreaderDevice[]
}

/** Picks fields one by one because the raw response carries the SMTP password. */
export async function getEmailSettings(): Promise<EmailSettings> {
  const res = await adminRequest<{ settings?: Partial<EmailSettings> }>(ABS_ENDPOINTS.emailSettings)
  const s = res?.settings
  if (!s) throw new ABSRequestError(502, ABS_ENDPOINTS.emailSettings)
  return {
    host: s.host ?? null,
    fromAddress: s.fromAddress ?? null,
    testAddress: s.testAddress ?? null,
    ereaderDevices: s.ereaderDevices ?? [],
  }
}

export async function setTestAddress(testAddress: string | null): Promise<void> {
  await adminRequest(ABS_ENDPOINTS.emailSettings, {
    method: 'PATCH',
    body: JSON.stringify({ testAddress }),
  })
}

/** The server waits on the mail server, which can take a while to fail. */
export async function sendTestEmail(): Promise<void> {
  await adminRequest(ABS_ENDPOINTS.emailTest, { method: 'POST' }, { timeoutMs: 60000 })
}

/** Reads the list first: the write replaces it whole, so a list that went stale
 *  on this screen would drop a device someone else added. */
async function changeDevices(change: (devices: EreaderDevice[]) => EreaderDevice[]): Promise<void> {
  const { ereaderDevices } = await getEmailSettings()
  await adminRequest(ABS_ENDPOINTS.emailEreaderDevices, {
    method: 'POST',
    body: JSON.stringify({ ereaderDevices: change(ereaderDevices) }),
  })
}

export function addEreaderDevice(device: ABSEreaderDevice): Promise<void> {
  return changeDevices((devices) => [...devices, device])
}

export function removeEreaderDevice(device: ABSEreaderDevice): Promise<void> {
  return changeDevices((devices) =>
    devices.filter((d) => d.name !== device.name || d.email !== device.email),
  )
}

export function getEmailRelayStatus(): Promise<HSHostedEmailRelayStatus> {
  return adminRequest<HSHostedEmailRelayStatus>(HS_ENDPOINTS.hostedEmailRelay)
}
