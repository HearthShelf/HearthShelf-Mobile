/**
 * Cross-device user preferences (queue mode + auto-rules, plus the settings
 * screens' Appearance/Playback/Sleep/Haptics prefs). Plain subscribe/snapshot
 * store, matching player/store.ts's convention - no Zustand in this app.
 *
 * Values sync server-side per-key via /hs/settings (see queueSync.ts), keyed by
 * ABS user id, so switching between web and mobile keeps the same choices. Each
 * setting carries its own updatedAt in `meta`, so sync merges at the setting
 * level (per-key last-writer-wins) - a change on one device never clobbers an
 * unrelated change on another. The @hearthshelf/core catalog is the shared
 * definition of every setting's scope + default. Local state here is the fast
 * in-memory cache; sync is best-effort (offline keeps defaults). player/store.ts
 * reads the playback defaults (rate, skip amounts, sleep behavior) from here when
 * a fresh session starts, so the settings screens and the in-player sheets share
 * one source of truth.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Crypto from 'expo-crypto'
import type { QueueMode, AutoRulePref, SettingValue } from '@hearthshelf/core'
import { DEFAULT_AUTO_RULES, SETTINGS_CATALOG, normalizeAutoRules } from '@hearthshelf/core'

export type ThemePref = 'auto' | 'dark' | 'light' | 'flat' | 'oled'
export type AccentMode = 'dynamic' | 'manual'
export type GlowMode = 'gradient' | 'image'
/** Full-player background: blurred cover art, a breathing hue gradient, or the
 *  sitting-by-the-hearth artwork. */
export type PlayerBg = 'blurred' | 'gradient' | 'hearth'
export type ScrubberScope = 'chapter' | 'book'
/** Remembered default for the note composer's Public/Personal choice (device). */
export type NoteDefaultVisibility = 'public' | 'personal'
export type CoverAspect = 'square' | 'portrait'
/** Layout of the floating nav pill (device). Horizontal = centered bottom pill;
 *  vertical = a column hugging the bottom-right, freeing the mini player to drop. */
export type FloatingNavOrientation = 'horizontal' | 'vertical'
/** How much haptic feedback to fire. See src/ui/haptics.ts for what each covers. */
export type HapticLevel = 'off' | 'minimal' | 'all'
export type HapticIntensity = 'light' | 'medium'
export type CarMode = 'auto' | 'on' | 'off'
/** The tone played as a sleep-timer warning beep. See src/player/sleepBeep.ts. */
export type BeepSound = 'chime' | 'marimba' | 'beep' | 'bell'
/** What shake-to-extend does when too many shakes fire in a row (likely a phone
 *  jostling on a walk, not a deliberate wake-up). See addSleepMinutes in
 *  src/player/store.ts. off = never cut off; limit = stop honoring shakes but keep
 *  the timer; disable = cancel the timer so playback isn't silenced. */
export type ShakeExcessive = 'off' | 'limit' | 'disable'
/** Aspect ratio (width/height) for cover tiles, per the CoverAspect setting. */
export const COVER_ASPECT_RATIO: Record<CoverAspect, number> = { square: 1, portrait: 2 / 3 }

/** The default hearth ember accent (matches the web palette / tokens). */
export const EMBER = '#e0654a'

/**
 * The player's customizable action buttons. The user arranges these across three
 * placements (on the player, in the More tray, hidden) and reorders within each -
 * see PLAYER_ACTIONS in src/player/actions.tsx for the icon/label/handler of each.
 */
export type PlayerActionKey =
  | 'chapters'
  | 'speed'
  | 'sleep'
  | 'recent'
  | 'bookmarks'
  | 'details'
  | 'cast'
  | 'carMode'
  | 'download'
  | 'notes'
  | 'addList'

export type ActionPlacement = 'onscreen' | 'tray' | 'hidden'

/** One action's placement + position, ordered within its placement group. */
export interface PlayerActionPref {
  key: PlayerActionKey
  placement: ActionPlacement
}

/** Most on-screen buttons we allow before the row gets too cramped to read. */
export const MAX_ONSCREEN_ACTIONS = 6

/** Default arrangement: the four that shipped as the toolbar stay on-screen; the
 *  rest go to the tray, in the order the DS listed them. */
export const DEFAULT_PLAYER_ACTIONS: PlayerActionPref[] = [
  { key: 'chapters', placement: 'onscreen' },
  { key: 'speed', placement: 'onscreen' },
  { key: 'sleep', placement: 'onscreen' },
  { key: 'recent', placement: 'onscreen' },
  { key: 'bookmarks', placement: 'tray' },
  { key: 'details', placement: 'tray' },
  { key: 'notes', placement: 'tray' },
  { key: 'addList', placement: 'tray' },
  { key: 'download', placement: 'tray' },
  { key: 'cast', placement: 'tray' },
  { key: 'carMode', placement: 'tray' },
]

export interface SettingsState {
  queueMode: QueueMode
  queueAutoRules: AutoRulePref[]

  // Reading goal (account). Books the user aims to finish this calendar year;
  // 0 = no goal. The Stats screen shows progress against booksThisYear.
  yearlyBookGoal: number

  // Search (account). When on, Search also looks up titles you don't own via the
  // Audible catalog and shows them in a "Not in your library" section.
  searchExternalSources: boolean
  // Per-provider toggles for the search-link icons on a book's detail page.
  externalLinkGoodreads: boolean
  externalLinkAudible: boolean
  externalLinkHardcover: boolean

  // Appearance
  theme: ThemePref
  accentMode: AccentMode
  accentHex: string
  glow: number
  glowMode: GlowMode
  coverAspect: CoverAspect
  // Device-scoped (mobile only, not in the core catalog so it never syncs to web):
  // swap the full-width bottom tab bar for a floating glass icon pill
  // (Home / Now / Library / More). An in-app A/B of the nav treatment.
  floatingNav: boolean
  // Orientation of the floating pill (only meaningful when floatingNav is on):
  // horizontal centers it along the bottom; vertical stacks it bottom-right and
  // lets the mini player drop down beside it.
  floatingNavOrientation: FloatingNavOrientation

  // Playback
  scrubber: ScrubberScope
  defaultSpeed: number
  skipForward: number
  skipForwardCustom: number
  skipBack: number
  skipBackCustom: number
  playerBg: PlayerBg
  tapArtworkTogglesPlay: boolean
  skipHotspots: boolean
  // Delete a book's local download automatically once you finish it, to free up
  // space. Applies to any download (manual or auto). Account-scoped.
  removeDownloadOnFinish: boolean
  haptics: HapticLevel
  hapticIntensity: HapticIntensity
  carMode: CarMode

  // Sleep timer defaults (seed player/store.ts's sleepBehavior on a fresh session)
  sleepRewindSec: number
  chapterBarrier: boolean
  sleepFade: boolean
  sleepFadeLen: number
  sleepShakeExtend: boolean
  sleepShakeMinutes: number
  sleepShakeExcessive: ShakeExcessive
  // Beep before the timer ends: sleepChime is the master on/off; the three cue
  // toggles pick which warnings fire (2 min / 1 min / right as it stops).
  sleepChime: boolean
  sleepBeepAt2min: boolean
  sleepBeepAt1min: boolean
  sleepBeepFinal: boolean
  sleepBeepSound: BeepSound
  sleepBeepVolume: number
  autoSleep: boolean
  autoSleepStart: string
  autoSleepEnd: string
  autoSleepDur: number

  // Player action buttons: arrangement across on-screen/tray/hidden, and whether
  // on-screen buttons drop their labels to fit more per row.
  playerActions: PlayerActionPref[]
  playerActionsIconOnly: boolean

  // Social / community (account). Tri-state presence sharing: null = never chose
  // (follow the server's community default, which ships OFF for presence).
  useGravatar: boolean
  shareReadBooks: boolean | null
  shareCurrentlyListening: boolean | null

  // Book clubs (account). clubsEnabled off hides every club surface;
  // clubPlayerButton hides just the player's open-club button.
  clubsEnabled: boolean
  clubPlayerButton: boolean

  // Release notifications (account). Follow an upcoming book/series and get a
  // push when it's available; countdownWindowDays drives the Home banner.
  notifyEnabled: boolean
  notifyAvailableInLibrary: boolean
  notifyOnReleaseDate: boolean
  notifyReminderDaysBefore: number
  notifyCountdownWindowDays: number

  // Social pops (device). Show a toast when playback crosses a club note; can be
  // silenced on one device without leaving the club.
  notePops: boolean

  // Remembers the note composer's last Public/Personal choice (device). Written
  // on each general (non-club) post so the composer defaults to it next time.
  noteDefaultVisibility: NoteDefaultVisibility

  // Device-scoped: when false, this device ignores account settings pulled from
  // the server and runs on its local values only (see queueSync.ts).
  useSharedSettings: boolean
}

let state: SettingsState = {
  queueMode: 'off',
  queueAutoRules: DEFAULT_AUTO_RULES,

  yearlyBookGoal: 0,

  searchExternalSources: true,
  externalLinkGoodreads: true,
  externalLinkAudible: true,
  externalLinkHardcover: true,

  theme: 'dark',
  accentMode: 'manual',
  accentHex: EMBER,
  glow: 60,
  glowMode: 'gradient',
  coverAspect: 'square',
  floatingNav: false,
  floatingNavOrientation: 'horizontal',

  scrubber: 'chapter',
  defaultSpeed: 1,
  skipForward: 30,
  skipForwardCustom: 45,
  skipBack: 15,
  skipBackCustom: 20,
  playerBg: 'blurred',
  tapArtworkTogglesPlay: false,
  skipHotspots: true,
  removeDownloadOnFinish: true,
  haptics: 'minimal',
  hapticIntensity: 'light',
  carMode: 'auto',

  sleepRewindSec: 30,
  chapterBarrier: true,
  sleepFade: true,
  sleepFadeLen: 20,
  sleepShakeExtend: false,
  sleepShakeMinutes: 5,
  sleepShakeExcessive: 'limit',
  sleepChime: false,
  sleepBeepAt2min: true,
  sleepBeepAt1min: true,
  sleepBeepFinal: false,
  sleepBeepSound: 'chime',
  sleepBeepVolume: 60,
  autoSleep: false,
  autoSleepStart: '22:00',
  autoSleepEnd: '06:00',
  autoSleepDur: 30,

  playerActions: DEFAULT_PLAYER_ACTIONS,
  playerActionsIconOnly: false,

  useGravatar: false,
  shareReadBooks: null,
  shareCurrentlyListening: null,
  clubsEnabled: true,
  clubPlayerButton: true,
  notifyEnabled: true,
  notifyAvailableInLibrary: true,
  notifyOnReleaseDate: true,
  notifyReminderDaysBefore: 3,
  notifyCountdownWindowDays: 14,
  notePops: true,
  noteDefaultVisibility: 'public',

  useSharedSettings: true,
}

// Per-key updatedAt (ms) for sync conflict resolution. Not user settings; parallel
// to `state` so components never see it. set() stamps it for catalogued keys.
let meta: Record<string, number> = {}

const listeners = new Set<() => void>()

export function getSettingsState(): SettingsState {
  return state
}

/** The per-key sync metadata (updatedAt per catalogued key). */
export function getSettingsMeta(): Record<string, number> {
  return meta
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Apply a state patch and, for any catalogued key in the patch, stamp its
// updatedAt so the sync layer knows it changed locally. `stampMeta` is false when
// adopting server values (they carry their own updatedAt, applied via meta arg).
// `persistDevice` is false only while hydrating device settings (we just read
// them - re-writing would be redundant).
function set(patch: Partial<SettingsState>, stampMeta = true, persistDevice = true): void {
  state = { ...state, ...patch }
  if (stampMeta) {
    const now = Date.now()
    const next = { ...meta }
    for (const key of Object.keys(patch)) {
      if (key in SETTINGS_CATALOG) next[key] = now
    }
    meta = next
  }
  if (persistDevice && patchTouchesDeviceKeys(patch)) persistDeviceSettings()
  listeners.forEach((l) => l())
}

/**
 * Reconcile a possibly-partial/stale action list against the known action set:
 * keep valid entries in their saved order, drop unknown keys, and append any
 * actions the saved list is missing (new actions added in an app update) using
 * their default placement. Guarantees every action appears exactly once.
 */
export function normalizePlayerActions(saved: PlayerActionPref[] | undefined): PlayerActionPref[] {
  const valid = new Set(DEFAULT_PLAYER_ACTIONS.map((a) => a.key))
  const seen = new Set<PlayerActionKey>()
  const kept: PlayerActionPref[] = []
  for (const a of saved ?? []) {
    if (valid.has(a.key) && !seen.has(a.key)) {
      seen.add(a.key)
      kept.push({ key: a.key, placement: a.placement })
    }
  }
  for (const d of DEFAULT_PLAYER_ACTIONS) {
    if (!seen.has(d.key)) kept.push(d)
  }
  return kept
}

/**
 * Adopt per-key values pulled from the server, resolving each against the local
 * value via last-writer-wins (server's updatedAt >= local wins). Only catalogued
 * keys apply; unknown keys are ignored. Does NOT re-stamp meta as a local change -
 * it records the server's updatedAt so a later local edit can still win.
 */
export function applyServerKeys(
  rows: Record<string, { value: SettingValue; updatedAt: number }>,
): void {
  const patch: Record<string, unknown> = {}
  const nextMeta = { ...meta }
  let changed = false
  for (const key of Object.keys(rows)) {
    if (!(key in SETTINGS_CATALOG)) continue
    const remote = rows[key]
    const localAt = meta[key] ?? -1
    if (remote.updatedAt >= localAt) {
      let value: unknown = remote.value
      if (key === 'playerActions') value = normalizePlayerActions(value as PlayerActionPref[])
      if (key === 'queueAutoRules') value = normalizeAutoRules(value)
      patch[key] = value
      nextMeta[key] = remote.updatedAt
      changed = true
    }
  }
  if (changed) {
    meta = nextMeta
    set(patch as Partial<SettingsState>, false)
  }
}

/** Replace the player action arrangement (from the reorder editor). */
export function setPlayerActions(playerActions: PlayerActionPref[]): void {
  set({ playerActions })
}

export function setQueueMode(queueMode: QueueMode): void {
  set({ queueMode })
}

export function toggleAutoRule(id: AutoRulePref['id']): void {
  set({
    queueAutoRules: state.queueAutoRules.map((r) => (r.id === id ? { ...r, on: !r.on } : r)),
  })
}

/** Generic setter for the settings screens' rows. */
export function setSetting<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void {
  set({ [key]: value } as Partial<SettingsState>)
}

/**
 * Reset a set of settings keys to their catalog defaults in one write. Returns
 * the prior values (only for keys that actually changed) so a caller can offer
 * an Undo. Keys with no catalog default, or already at their default, are left
 * untouched.
 */
export function resetSettings(keys: (keyof SettingsState)[]): Partial<SettingsState> {
  const prev: Record<string, unknown> = {}
  const next: Record<string, unknown> = {}
  const s = state as unknown as Record<string, unknown>
  for (const key of keys) {
    const k = key as string
    const def = SETTINGS_CATALOG[k]
    if (!def) continue
    const dflt = def.default as unknown
    if (s[k] === dflt) continue
    prev[k] = s[k]
    next[k] = dflt
  }
  if (Object.keys(next).length) set(next as Partial<SettingsState>)
  return prev as Partial<SettingsState>
}

/** Restore a snapshot of prior values (the Undo companion to resetSettings). */
export function restoreSettings(snapshot: Partial<SettingsState>): void {
  if (Object.keys(snapshot).length) set(snapshot)
}

/** Current value + updatedAt for every catalogued setting the store holds, for
 *  the per-key sync push to diff against its last-pushed snapshot. */
export function storedSettings(): Record<string, { value: SettingValue; updatedAt: number }> {
  const out: Record<string, { value: SettingValue; updatedAt: number }> = {}
  const s = state as unknown as Record<string, unknown>
  for (const key of Object.keys(SETTINGS_CATALOG)) {
    if (!(key in s)) continue // catalog key this platform doesn't render
    out[key] = { value: s[key] as SettingValue, updatedAt: meta[key] ?? 0 }
  }
  return out
}

// --- device-scoped settings persistence ------------------------------------
// Keys NOT in SETTINGS_CATALOG never sync to the server and so had no persistence
// at all - they reset to defaults on every launch. These are device-local prefs,
// so we persist them to AsyncStorage here: written on change, hydrated at boot.

const DEVICE_SETTINGS_KEY = 'hs.deviceSettings'

function patchTouchesDeviceKeys(patch: Partial<SettingsState>): boolean {
  return 'floatingNav' in patch || 'floatingNavOrientation' in patch
}

/** Persist the current device-scoped slice. Best-effort, fire-and-forget. */
function persistDeviceSettings(): void {
  const slice = {
    floatingNav: state.floatingNav,
    floatingNavOrientation: state.floatingNavOrientation,
  }
  void AsyncStorage.setItem(DEVICE_SETTINGS_KEY, JSON.stringify(slice)).catch(() => {})
}

let deviceSettingsReady: Promise<void> | null = null

/** Load persisted device-scoped settings into state. Idempotent; call once at
 *  boot (before the first render that reads them, ideally). Safe to await. */
export function hydrateDeviceSettings(): Promise<void> {
  if (!deviceSettingsReady) {
    deviceSettingsReady = (async () => {
      try {
        const raw = await AsyncStorage.getItem(DEVICE_SETTINGS_KEY)
        if (!raw) return
        const saved = JSON.parse(raw) as Record<string, unknown>
        const patch: Partial<SettingsState> = {}
        if (typeof saved.floatingNav === 'boolean') patch.floatingNav = saved.floatingNav
        if (
          saved.floatingNavOrientation === 'horizontal' ||
          saved.floatingNavOrientation === 'vertical'
        ) {
          patch.floatingNavOrientation = saved.floatingNavOrientation
        }
        // Adopt without stamping sync meta (these keys aren't catalogued anyway)
        // and without re-persisting (we just read them).
        if (Object.keys(patch).length) set(patch, false, false)
      } catch {
        // Storage unavailable or corrupt - keep in-code defaults.
      }
    })()
  }
  return deviceSettingsReady
}

// --- deviceId (per-install id for device-scoped settings) ------------------
// Not a secret, so AsyncStorage (not SecureStore). Generated once, persisted,
// and awaited before the first settings pull so device-scoped keys round-trip.

const DEVICE_ID_KEY = 'hs.deviceId'
let deviceId = ''
let deviceIdReady: Promise<string> | null = null

export function getDeviceId(): string {
  return deviceId
}

export function ensureDeviceId(): Promise<string> {
  if (!deviceIdReady) {
    deviceIdReady = (async () => {
      try {
        const existing = await AsyncStorage.getItem(DEVICE_ID_KEY)
        if (existing) {
          deviceId = existing
          return existing
        }
        const id = Crypto.randomUUID()
        await AsyncStorage.setItem(DEVICE_ID_KEY, id)
        deviceId = id
        return id
      } catch {
        // Storage unavailable - fall back to a session-only id so sync still works.
        if (!deviceId) deviceId = `dev-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
        return deviceId
      }
    })()
  }
  return deviceIdReady
}

// Hydrate behind the launch splash so the saved navigation mode is ready early.
void hydrateDeviceSettings()
