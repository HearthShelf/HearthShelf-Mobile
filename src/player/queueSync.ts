/**
 * Keeps the local queue + settings stores in sync with the server, so the
 * up-next list and queue mode/auto-rules follow the user across devices.
 * Mirrors the WebApp's useQueueSync/useSettingsSync pull/push shape, but as
 * plain start/stop functions (this app has no settings-sync hook convention
 * yet) called from the connect flow in app/(tabs)/index.tsx, alongside
 * setAutoSession - and torn down on sign-out.
 *
 * Conflict rule: while this device has an active playback session (a track
 * loaded in player/store.ts), it is the authority over its own queue - it
 * doesn't adopt a remote pull mid-session. An idle device always adopts the
 * latest queue/settings the next time the app comes to the foreground.
 */
import { AppState, type AppStateStatus } from 'react-native'
import { validateSetting, SETTINGS_CATALOG } from '@hearthshelf/core'
import { getQueueState, setQueueItems, setQueuePlaylistId, subscribeQueue } from './queue'
import { getState as getPlayerState } from './store'
import { getServerQueue, putServerQueue } from '@/api/queue'
import { getServerSettings, putServerSettings, type SettingChange } from '@/api/settings'
import {
  applyServerKeys,
  ensureDeviceId,
  getDeviceId,
  getSettingsMeta,
  getSettingsState,
  storedSettings,
  subscribeSettings,
} from '@/store/settings'

const QUEUE_PUSH_DEBOUNCE_MS = 400
const SETTINGS_PUSH_DEBOUNCE_MS = 1200

let started = false
let hydratingQueue = false
let hydratedQueue = false
let hydratingSettings = false
let hydratedSettings = false
let queueTimer: ReturnType<typeof setTimeout> | null = null
let settingsTimer: ReturnType<typeof setTimeout> | null = null
// Snapshot of per-key meta at last push, to diff which keys changed since.
let lastSettingsMeta: Record<string, number> = {}
let unsubQueue: (() => void) | null = null
let unsubSettings: (() => void) | null = null
let appStateSub: { remove: () => void } | null = null

function hasActiveSession(): boolean {
  return !!getPlayerState().nowPlaying
}

async function pullQueue(): Promise<void> {
  try {
    const server = await getServerQueue()
    // The active-session guard only protects a MANUAL queue: manual is the one
    // mode this device hand-edits, so a remote pull mustn't stomp its own
    // in-flight order mid-session. Auto/playlist/off are server-authoritative
    // and read-only here, so always adopt the server's list - otherwise a device
    // that's actively listening (which is the normal case for an auto queue)
    // never picks up the queue the server just computed, and the sheet reads
    // "Nothing queued" despite a full server-side queue.
    const mode = getSettingsState().queueMode
    if (mode === 'manual' && hasActiveSession()) return
    hydratingQueue = true
    // bump=false: adopting the server's state shouldn't immediately look like
    // a new local write and re-push what we just pulled.
    setQueueItems(server.items, false)
    setQueuePlaylistId(server.playlistId, false)
    hydratingQueue = false
  } catch {
    // Backend unreachable - keep the local queue as-is.
  } finally {
    hydratedQueue = true
  }
}

async function pullSettings(): Promise<void> {
  try {
    const deviceId = await ensureDeviceId()
    const server = await getServerSettings(deviceId)
    hydratingSettings = true
    // Account settings apply only when this device opts into shared settings;
    // device settings always round-trip (they're this device's own backup).
    if (getSettingsState().useSharedSettings && server.account) applyServerKeys(server.account)
    if (server.device) applyServerKeys(server.device)
    hydratingSettings = false
  } catch {
    // Backend unreachable - keep local defaults/current values.
  } finally {
    lastSettingsMeta = { ...getSettingsMeta() }
    hydratedSettings = true
  }
}

function pushQueue(): void {
  if (!hydratedQueue || hydratingQueue) return
  if (queueTimer) clearTimeout(queueTimer)
  queueTimer = setTimeout(() => {
    const { items, playlistId, updatedAt } = getQueueState()
    putServerQueue(items, playlistId, updatedAt)
      .then((res) => {
        if (res.applied === false && !hasActiveSession()) {
          hydratingQueue = true
          setQueueItems(res.items, false)
          setQueuePlaylistId(res.playlistId, false)
          hydratingQueue = false
        }
      })
      .catch(() => {
        // Best-effort; the local store already holds the change.
      })
  }, QUEUE_PUSH_DEBOUNCE_MS)
}

function pushSettings(): void {
  if (!hydratedSettings || hydratingSettings) return
  if (settingsTimer) clearTimeout(settingsTimer)
  settingsTimer = setTimeout(() => {
    const stored = storedSettings()
    const changes: SettingChange[] = []
    for (const key of Object.keys(stored)) {
      const row = stored[key]
      if (row.updatedAt === 0) continue // never set locally - leave as default
      if (lastSettingsMeta[key] === row.updatedAt) continue // unchanged since last push
      const def = SETTINGS_CATALOG[key]
      if (!def) continue
      // Validate client-side so we never push a value the server would reject.
      const v = validateSetting(key, row.value)
      if (!v.ok) continue
      changes.push({ scope: def.scope, key, value: v.value, updatedAt: row.updatedAt })
    }
    if (!changes.length) return
    // If the queue mode or auto-rules changed, the server recomputes the auto
    // queue on the next GET - re-pull once the new settings have landed so the
    // sheet reflects the change immediately (not just on the next foreground).
    const queueSettingsChanged = changes.some(
      (c) => c.key === 'queueMode' || c.key === 'queueAutoRules',
    )
    putServerSettings(getDeviceId(), changes)
      .then((res) => {
        // Adopt any value the server rejected as stale (another device newer).
        if (res.rejected?.length) {
          const rows: Record<string, { value: unknown; updatedAt: number }> = {}
          for (const r of res.rejected) rows[r.key] = { value: r.value, updatedAt: r.updatedAt }
          hydratingSettings = true
          applyServerKeys(rows as Record<string, { value: never; updatedAt: number }>)
          hydratingSettings = false
        }
        lastSettingsMeta = { ...getSettingsMeta() }
        if (queueSettingsChanged) void pullQueue()
      })
      .catch(() => {
        // Best-effort; the local store already holds the change.
      })
  }, SETTINGS_PUSH_DEBOUNCE_MS)
}

function onAppStateChange(nextState: AppStateStatus): void {
  if (nextState === 'active') {
    void pullQueue()
    void pullSettings()
  }
}

/** Call once a session is established (after setSession/setAutoSession). */
export function startQueueSync(): void {
  if (started) return
  started = true
  hydratedQueue = false
  hydratedSettings = false

  void pullQueue()
  void pullSettings()

  unsubQueue = subscribeQueue(pushQueue)
  unsubSettings = subscribeSettings(pushSettings)
  appStateSub = AppState.addEventListener('change', onAppStateChange)
}

/** Call on sign-out / session clear. */
export function stopQueueSync(): void {
  started = false
  hydratedQueue = false
  hydratedSettings = false
  if (queueTimer) clearTimeout(queueTimer)
  if (settingsTimer) clearTimeout(settingsTimer)
  unsubQueue?.()
  unsubSettings?.()
  appStateSub?.remove()
  unsubQueue = null
  unsubSettings = null
  appStateSub = null
}
