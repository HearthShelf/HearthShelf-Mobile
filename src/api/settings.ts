/**
 * Per-key settings sync client. Settings live server-side keyed by ABS user id so
 * they follow the user across devices - this app's in-memory store
 * (src/store/settings.ts) is just the fast cache. Unlike the WebApp (which
 * proxies through its own origin), mobile talks directly to the connected
 * server's origin - same convention as getHSStats.
 *
 * Per-key contract (see docs/settings-sync.md in HearthShelf): GET returns
 * account + device (for this device) settings plus the non-secret connection;
 * PUT sends only the changed keys, each stamped with its updatedAt, and reports
 * which landed / were stale / failed validation.
 */
import type { SettingScope, SettingValue } from '@hearthshelf/core'
import { getSession } from './session'

export interface StoredSetting {
  value: SettingValue
  updatedAt: number
}

export interface ServerSettings {
  account: Record<string, StoredSetting>
  device: Record<string, StoredSetting>
  connection: { absUrl: string; label: string | null; connected: boolean } | null
}

export interface SettingChange {
  scope: SettingScope
  key: string
  value: SettingValue
  updatedAt: number
}

export interface PushResult {
  applied: string[]
  rejected: Array<{ key: string; value: SettingValue; updatedAt: number }>
  invalid: Array<{ key: string; value: SettingValue; reason: string }>
}

function requireSession() {
  const s = getSession()
  if (!s) throw new Error('not_connected')
  return s
}

export async function getServerSettings(deviceId: string): Promise<ServerSettings> {
  const { serverUrl, token } = requireSession()
  const q = deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''
  const res = await fetch(`${serverUrl}/hs/settings${q}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`settings ${res.status}`)
  return (await res.json()) as ServerSettings
}

export async function putServerSettings(deviceId: string, changes: SettingChange[]): Promise<PushResult> {
  const { serverUrl, token } = requireSession()
  const res = await fetch(`${serverUrl}/hs/settings`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, changes }),
  })
  if (!res.ok) throw new Error(`settings ${res.status}`)
  return (await res.json()) as PushResult
}
