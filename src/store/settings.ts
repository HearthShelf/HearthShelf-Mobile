/**
 * Cross-device user preferences (queue mode + auto-rules today; more will land
 * here as mobile grows a Settings screen). Plain subscribe/snapshot store,
 * matching player/store.ts's convention - no Zustand in this app.
 *
 * Values persist server-side via /hs/settings (see queueSync.ts), same blob
 * the WebApp reads/writes, keyed by ABS user id - so switching between web and
 * mobile keeps the same queue mode and auto-rule choices. Local state here is
 * just the fast in-memory cache; sync is best-effort (offline keeps defaults).
 */
import type { QueueMode, AutoRulePref } from '@hearthshelf/core'
import { DEFAULT_AUTO_RULES } from '@hearthshelf/core'

export interface SettingsState {
  queueMode: QueueMode
  queueAutoRules: AutoRulePref[]
}

let state: SettingsState = {
  queueMode: 'off',
  queueAutoRules: DEFAULT_AUTO_RULES,
}

const listeners = new Set<() => void>()

export function getSettingsState(): SettingsState {
  return state
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function set(patch: Partial<SettingsState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

/** Bulk-replace with values pulled from the server (device sync). */
export function applyServerSettings(values: Partial<SettingsState>): void {
  set(values)
}

export function setQueueMode(queueMode: QueueMode): void {
  set({ queueMode })
}

export function toggleAutoRule(id: AutoRulePref['id']): void {
  set({
    queueAutoRules: state.queueAutoRules.map((r) => (r.id === id ? { ...r, on: !r.on } : r)),
  })
}

/** Snapshot the syncable values for a /hs/settings PUT. */
export function settingsValues(s: SettingsState = state): Record<string, unknown> {
  return { queueMode: s.queueMode, queueAutoRules: s.queueAutoRules }
}
