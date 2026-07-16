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
import { validateSetting, SETTINGS_CATALOG, type QueueEntry } from '@hearthshelf/core'
import {
  getQueueState,
  setQueueItems,
  setQueueManual,
  setQueuePlaylistId,
  subscribeQueue,
} from './queue'
import { getState as getPlayerState } from './store'
import { getServerQueue, putServerQueue, recomputeServerQueue } from '@/api/queue'
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
// updatedAt of the last queue we adopted from the server. A push is only worth
// making when the local updatedAt has moved past this - i.e. the user actually
// edited the queue here. Without this gate, adopting a large server-computed
// Auto queue (which we hold in `items` to display) would immediately be pushed
// straight back, and the stored queue inflates across syncs. Mirrors the
// WebApp's serverUpdatedAt/lastAt guard in useQueueSync.
let adoptedUpdatedAt = 0
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

// Adopt a server queue into the local store without re-pushing it. Shared by
// the plain pull (cheap GET) and the recompute path (POST). bump=false so
// adopting the server's state doesn't look like a new local write.
//
// `items`/`playlistId` are server-authoritative in Auto/Playlist, so they're
// always taken from the server. `manual` is DIFFERENT: it's the client-authored
// hand-queued list in every mode. If we have a local manual edit that hasn't
// been pushed+stored yet (local updatedAt is ahead of what we last adopted), a
// racing pull/recompute must NOT overwrite it with the server's older manual -
// that's the bug where a book you just added in the tray vanishes because a
// recompute adopts a manual list computed before the add landed. Keep the local
// manual in that case; the pending push will reconcile it to the server.
function adoptServerQueue(server: {
  items: QueueEntry[]
  manual: QueueEntry[]
  playlistId: string | null
}): void {
  hydratingQueue = true
  const hasPendingLocalEdit = getQueueState().updatedAt > adoptedUpdatedAt
  setQueueItems(server.items, false)
  if (!hasPendingLocalEdit) setQueueManual(server.manual, false)
  setQueuePlaylistId(server.playlistId, false)
  // Only rebaseline the adopt marker when we fully took the server's state.
  // Keeping the old baseline while a local manual edit is pending ensures the
  // pushQueue guard still recognizes it as an un-pushed change.
  if (!hasPendingLocalEdit) adoptedUpdatedAt = getQueueState().updatedAt
  hydratingQueue = false
}

async function pullQueue(): Promise<void> {
  try {
    // Cheap read: GET returns the stored queue as-is (no server recompute). The
    // Auto rebuild happens on triggers - the play-cooldown, settings/manual/
    // dismissal edits, and the nightly job - not on this foreground/pull.
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
    adoptServerQueue(server)
  } catch {
    // Backend unreachable - keep the local queue as-is.
  } finally {
    hydratedQueue = true
  }
}

// Ask the server to rebuild the Auto queue now, then adopt it. Called on the
// triggers that should take effect immediately (settings mode/rules change,
// manual-queue edit, dismissal) rather than waiting for the play-cooldown or
// nightly job. Passes the now-playing item so finish-series seeds correctly.
async function recomputeQueue(): Promise<void> {
  if (getSettingsState().queueMode !== 'auto') return
  try {
    const currentItemId = getPlayerState().nowPlaying?.itemId ?? undefined
    const server = await recomputeServerQueue(currentItemId)
    if (getSettingsState().queueMode === 'manual' && hasActiveSession()) return
    adoptServerQueue(server)
  } catch {
    // Best-effort; the local queue stays usable.
  }
}

/** Public trigger: recompute the Auto queue now (e.g. after a dismissal). */
export function requestQueueRecompute(): void {
  void recomputeQueue()
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
  // Nothing changed locally since we adopted the server's queue - don't echo it
  // back (see adoptedUpdatedAt). A real edit bumps updatedAt past this.
  if (getQueueState().updatedAt === adoptedUpdatedAt) return
  if (queueTimer) clearTimeout(queueTimer)
  queueTimer = setTimeout(() => {
    const { items, manual, playlistId, updatedAt } = getQueueState()
    putServerQueue(items, manual, playlistId, updatedAt)
      .then((res) => {
        if (res.applied === false && !hasActiveSession()) {
          hydratingQueue = true
          setQueueItems(res.items, false)
          setQueueManual(res.manual, false)
          setQueuePlaylistId(res.playlistId, false)
          adoptedUpdatedAt = getQueueState().updatedAt
          hydratingQueue = false
        } else if (res.applied !== false) {
          // Our write landed. Rebaseline the adopt marker to the pushed
          // updatedAt so a following adopt (from the recompute below, or a
          // racing pull) is no longer seen as racing a pending local edit - the
          // edit is now the server's truth. Without this the manual-preserve
          // guard in adoptServerQueue would keep re-firing pushQueue forever.
          adoptedUpdatedAt = updatedAt
          if (getSettingsState().queueMode === 'auto') {
            // In Auto mode the server stores manual separately and only splices
            // it into the computed `items` on a recompute. Trigger one so the
            // merged up-next list shows the change now instead of on the next
            // play-cooldown / foreground.
            void recomputeQueue()
          }
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
    // If the queue mode or auto-rules changed, ask the server to rebuild the
    // Auto queue now (a plain GET no longer recomputes) so the sheet reflects
    // the change immediately, not just on the next foreground or play-cooldown.
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
        if (queueSettingsChanged) void recomputeQueue()
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
  adoptedUpdatedAt = 0
  if (queueTimer) clearTimeout(queueTimer)
  if (settingsTimer) clearTimeout(settingsTimer)
  unsubQueue?.()
  unsubSettings?.()
  appStateSub?.remove()
  unsubQueue = null
  unsubSettings = null
  appStateSub = null
}
