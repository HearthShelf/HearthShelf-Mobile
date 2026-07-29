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
 * definition of every setting's scope + default. player/store.ts reads the
 * playback defaults (rate, skip amounts, sleep behavior) from here when a fresh
 * session starts, so the settings screens and the in-player sheets share one
 * source of truth.
 *
 * PERSISTENCE. Every setting is mirrored to AsyncStorage along with its `meta`
 * (when it changed here) and `pushed` (the updatedAt the server has confirmed
 * storing). The server is still the cross-device truth, but the local copy is
 * what makes the store honest offline:
 *   - a launch with no network shows the user's real settings, not defaults;
 *   - a change made while the backend is unreachable survives the app being
 *     killed and is pushed on a later launch, instead of vanishing (`meta`
 *     ahead of `pushed` is precisely "not yet on the server").
 * Before this, only three keys were persisted and everything else was rebuilt
 * from the server pull, so any change that never landed was silently gone at the
 * next launch.
 */
import { AppState } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Crypto from 'expo-crypto'
import type {
  QueueMode,
  AutoRulePref,
  HomeSectionPref,
  SettingChange,
  SettingValue,
} from '@hearthshelf/core'
import {
  DEFAULT_AUTO_RULES,
  DEFAULT_HOME_SECTIONS,
  DEFAULT_REC_SHELF_COUNT,
  SETTINGS_CATALOG,
  normalizeAutoRules,
  normalizeHomeSections,
  validateSetting,
  READER_DEFAULTS,
} from '@hearthshelf/core'
import type {
  ReaderTheme,
  ReaderFont,
  ReaderLh,
  ReaderWidth,
  ReaderAlign,
  ReaderLayout,
} from '@hearthshelf/core'

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
  // Home screen layout (account). homeSections is the arrangement of every band
  // below the hero - array order is display order, `on` is visibility - edited
  // from Home's own edit mode. homeRecShelfCount caps how many taste-derived
  // rows ("Because you love Fantasy", "More from <author>") the "More picks for
  // you" block may spawn.
  homeSections: HomeSectionPref[]
  homeRecShelfCount: number
  // Device-scoped (mobile only - other platforms simply ignore the key): swap the
  // full-width bottom tab bar for a floating glass icon pill (Home / Now /
  // Library / More). An in-app A/B of the nav treatment.
  floatingNav: boolean
  // Orientation of the floating pill (only meaningful when floatingNav is on):
  // horizontal centers it along the bottom; vertical stacks it bottom-right and
  // lets the mini player drop down beside it.
  floatingNavOrientation: FloatingNavOrientation

  // Playback
  scrubber: ScrubberScope
  defaultSpeed: number
  /** Rewind on resume, scaled to how long you were paused (see autoRewind.ts). */
  autoRewind: boolean
  skipForward: number
  skipForwardCustom: number
  skipBack: number
  skipBackCustom: number
  playerBg: PlayerBg
  tapArtworkTogglesPlay: boolean
  skipHotspots: boolean
  // Full-player cover is a swipeable deck of the live book + the up-next queue.
  // Off = the classic single cover.
  carouselPlayer: boolean
  // Hide the docked mini player app-wide. The full player stays reachable from
  // the Now Playing tab and a book's Play button. Off (default) keeps the bar.
  hideMiniPlayer: boolean
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

  // Device-scoped: share anonymous install stats (app version, device model/type,
  // OS) with the public HearthShelf community dashboard. On by default; no account,
  // user, or listening data is ever sent - only this install's coarse facts, keyed
  // by the random per-install deviceId. See lib/heartbeat.ts.
  shareInstallStats: boolean

  // Ebook reader typography (device). Catalogued under READER_SETTING_KEYS
  // (readerTheme, readerFont, ...) so it backs up and restores like every other
  // setting; src/reader/readerPrefs.ts is the reader-shaped view of these.
  readerTheme: ReaderTheme
  readerFont: ReaderFont
  readerSize: number
  readerLh: ReaderLh
  readerWidth: ReaderWidth
  readerAlign: ReaderAlign
  readerBrightness: number
  readerLayout: ReaderLayout
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
  homeSections: DEFAULT_HOME_SECTIONS,
  homeRecShelfCount: DEFAULT_REC_SHELF_COUNT,
  floatingNav: false,
  floatingNavOrientation: 'horizontal',

  scrubber: 'chapter',
  defaultSpeed: 1,
  autoRewind: true,
  skipForward: 30,
  skipForwardCustom: 45,
  skipBack: 15,
  skipBackCustom: 20,
  playerBg: 'blurred',
  tapArtworkTogglesPlay: false,
  skipHotspots: true,
  carouselPlayer: true,
  hideMiniPlayer: false,
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
  autoSleep: true,
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
  shareInstallStats: true,

  readerTheme: READER_DEFAULTS.theme,
  readerFont: READER_DEFAULTS.font,
  readerSize: READER_DEFAULTS.size,
  readerLh: READER_DEFAULTS.lh,
  readerWidth: READER_DEFAULTS.width,
  readerAlign: READER_DEFAULTS.align,
  readerBrightness: READER_DEFAULTS.brightness,
  readerLayout: READER_DEFAULTS.layout,
}

// Per-key updatedAt (ms) for sync conflict resolution. Not user settings; parallel
// to `state` so components never see it. set() stamps it for catalogued keys.
let meta: Record<string, number> = {}

// Per-key updatedAt the SERVER has confirmed storing. A key whose `meta` differs
// from its `pushed` entry is a local change the server hasn't taken yet - that
// difference is the pending-push queue, and it is persisted so an edit made
// offline still reaches the server after a restart. Only a server response (or
// adopting a server value) may write this; a pull must never mark an unpushed
// local edit as pushed.
let pushed: Record<string, number> = {}

const listeners = new Set<() => void>()

export function getSettingsState(): SettingsState {
  return state
}

/** The per-key sync metadata (updatedAt per catalogued key). */
export function getSettingsMeta(): Record<string, number> {
  return meta
}

/**
 * Record that the server now holds `updatedAt` for these keys, so they drop out
 * of the pending set. Called with the keys a PUT applied, and with keys the
 * server refused as invalid (retrying those forever would never succeed and
 * would keep every other pending key company in each request).
 */
export function markPushed(entries: Record<string, number>): void {
  const next = { ...pushed }
  let changed = false
  for (const key of Object.keys(entries)) {
    if (next[key] === entries[key]) continue
    next[key] = entries[key]
    changed = true
  }
  if (!changed) return
  pushed = next
  persistSettings()
}

export function subscribeSettings(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Apply a state patch and, for any catalogued key in the patch, stamp its
// updatedAt so the sync layer knows it changed locally. `stampMeta` is false when
// adopting server values (they carry their own updatedAt, recorded by the
// caller). `persist` is false only while hydrating from storage (we just read
// those values - writing them straight back is redundant).
function set(patch: Partial<SettingsState>, stampMeta = true, persist = true): void {
  state = { ...state, ...patch }
  if (stampMeta) {
    const now = Date.now()
    const next = { ...meta }
    for (const key of Object.keys(patch)) {
      if (key in SETTINGS_CATALOG) next[key] = now
    }
    meta = next
  }
  if (persist) persistSettings()
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
 *
 * Every key the server sent is recorded in `pushed` at the server's updatedAt,
 * whether or not we adopted it: the row exists server-side either way, so a key
 * we kept (because our edit is newer) stays pending, and a key we adopted stops
 * being pending. Keys the server did NOT send are left alone - that's what keeps
 * an offline edit queued instead of being quietly forgotten.
 */
export function applyServerKeys(
  rows: Record<string, { value: SettingValue; updatedAt: number }>,
): void {
  const patch: Record<string, unknown> = {}
  const nextMeta = { ...meta }
  const seen: Record<string, number> = {}
  let changed = false
  for (const key of Object.keys(rows)) {
    if (!(key in SETTINGS_CATALOG)) continue
    const remote = rows[key]
    // The server holds this key at this updatedAt either way. When we keep our
    // own newer value below, meta stays ahead of pushed and the key remains
    // queued for the next push.
    seen[key] = remote.updatedAt
    const localAt = meta[key] ?? -1
    if (remote.updatedAt >= localAt) {
      let value: unknown = remote.value
      if (key === 'playerActions') value = normalizePlayerActions(value as PlayerActionPref[])
      if (key === 'queueAutoRules') value = normalizeAutoRules(value)
      if (key === 'homeSections') value = normalizeHomeSections(value)
      patch[key] = value
      nextMeta[key] = remote.updatedAt
      changed = true
    }
  }
  // Assign pushed before set() so the single persist write it triggers already
  // carries the new map.
  pushed = { ...pushed, ...seen }
  if (changed) {
    meta = nextMeta
    set(patch as Partial<SettingsState>, false)
  } else if (Object.keys(seen).length) {
    persistSettings()
  }
}

/** Replace the player action arrangement (from the reorder editor). */
export function setPlayerActions(playerActions: PlayerActionPref[]): void {
  set({ playerActions })
}

/** Replace the Home section arrangement (from Home's edit mode). */
export function setHomeSections(homeSections: HomeSectionPref[]): void {
  set({ homeSections })
}

/** Toggle one Home section's visibility, leaving its position alone. */
export function toggleHomeSection(id: HomeSectionPref['id']): void {
  set({ homeSections: state.homeSections.map((s) => (s.id === id ? { ...s, on: !s.on } : s)) })
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

/**
 * Every local change the server hasn't confirmed yet, ready to PUT: a catalogued
 * key the user has edited here (`meta` is stamped) whose stamp differs from what
 * the server acknowledged (`pushed`). Since both maps are persisted, this
 * includes edits made offline in an earlier app run - they simply push on the
 * next successful sync instead of being lost.
 *
 * Values are validated against the catalog first so we never spend a request on
 * something the server would only reject.
 */
export function pendingSettingChanges(): SettingChange[] {
  const out: SettingChange[] = []
  const s = state as unknown as Record<string, unknown>
  for (const key of Object.keys(SETTINGS_CATALOG)) {
    if (!(key in s)) continue // catalog key this platform doesn't render
    const at = meta[key]
    if (at == null) continue // never edited here - leave it at the catalog default
    if (pushed[key] === at) continue // already stored server-side
    const check = validateSetting(key, s[key] as SettingValue)
    if (!check.ok) continue
    out.push({ scope: SETTINGS_CATALOG[key].scope, key, value: check.value, updatedAt: at })
  }
  return out
}

// --- local persistence -----------------------------------------------------
// Every catalogued setting, plus its `meta` and `pushed` timestamps, is mirrored
// to AsyncStorage. The server stays the cross-device truth; this is the on-device
// copy that survives a relaunch, works offline, and keeps un-pushed edits alive
// until they can be sent (see the file header).

const SETTINGS_KEY = 'hs.settings'
// v1 of on-device persistence: three device-only keys, no timestamps. Read once
// on the first hydrate of a build that has this, then removed.
const LEGACY_DEVICE_SETTINGS_KEY = 'hs.deviceSettings'

interface PersistedSettings {
  v: 2
  values: Record<string, SettingValue>
  meta: Record<string, number>
  pushed: Record<string, number>
}

// Coalesce the writes: dragging a slider fires set() per frame, and each write
// serializes the whole map. A short debounce keeps that off the JS thread's back
// without risking a meaningful loss window.
const PERSIST_DEBOUNCE_MS = 250
let persistTimer: ReturnType<typeof setTimeout> | null = null

function writeSettings(): void {
  const s = state as unknown as Record<string, unknown>
  const values: Record<string, SettingValue> = {}
  for (const key of Object.keys(SETTINGS_CATALOG)) {
    if (key in s) values[key] = s[key] as SettingValue
  }
  const payload: PersistedSettings = { v: 2, values, meta, pushed }
  void AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(payload)).catch(() => {})
}

/** Queue a debounced write of the whole store. Best-effort, fire-and-forget. */
function persistSettings(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    writeSettings()
  }, PERSIST_DEBOUNCE_MS)
}

/** Flush any debounced write immediately. */
export function flushSettingsToStorage(): void {
  if (!persistTimer) return
  clearTimeout(persistTimer)
  persistTimer = null
  writeSettings()
}

// Leaving the foreground is the last reliable moment before the OS may kill the
// process, so land any debounced write then. Registered here rather than in the
// sync layer: durability must not depend on being connected.
AppState.addEventListener('change', (next) => {
  if (next !== 'active') flushSettingsToStorage()
})

let settingsReady: Promise<void> | null = null

/**
 * Load persisted settings into state. Idempotent; kicked off at import and
 * awaited by the connect flow before sync starts, so a pull can never resolve
 * against an empty `meta` and adopt a server value over a newer local edit.
 *
 * Stored values are re-validated against the catalog: a value from an older
 * build (or a corrupt entry) falls back to the in-code default rather than
 * poisoning the store.
 */
export function hydrateSettings(): Promise<void> {
  if (!settingsReady) {
    settingsReady = (async () => {
      try {
        const raw = await AsyncStorage.getItem(SETTINGS_KEY)
        if (raw) {
          const saved = JSON.parse(raw) as Partial<PersistedSettings>
          const patch: Record<string, unknown> = {}
          for (const [key, value] of Object.entries(saved.values ?? {})) {
            if (!(key in SETTINGS_CATALOG) || !(key in state)) continue
            const check = validateSetting(key, value)
            if (!check.ok) continue
            let next: unknown = check.value
            if (key === 'playerActions') next = normalizePlayerActions(next as PlayerActionPref[])
            if (key === 'queueAutoRules') next = normalizeAutoRules(next)
            if (key === 'homeSections') next = normalizeHomeSections(next)
            patch[key] = next
          }
          meta = sanitizeTimestamps(saved.meta)
          pushed = sanitizeTimestamps(saved.pushed)
          // Adopt without stamping (these carry their own meta) and without
          // re-persisting (we just read them).
          if (Object.keys(patch).length) set(patch as Partial<SettingsState>, false, false)
        } else {
          await migrateLegacyDeviceSettings()
        }
      } catch {
        // Storage unavailable or corrupt - keep in-code defaults.
      }
    })()
  }
  return settingsReady
}

function sanitizeTimestamps(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key in SETTINGS_CATALOG && typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value
    }
  }
  return out
}

// Carry the three keys the old device-only slice held into the new store. They
// are catalogued now, so they also become syncable - but with no recorded
// timestamp, so they read as "never edited here" and defer to whatever the
// server holds rather than racing it.
async function migrateLegacyDeviceSettings(): Promise<void> {
  const raw = await AsyncStorage.getItem(LEGACY_DEVICE_SETTINGS_KEY)
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
  if (typeof saved.shareInstallStats === 'boolean') {
    patch.shareInstallStats = saved.shareInstallStats
  }
  if (Object.keys(patch).length) set(patch, false, false)
  await AsyncStorage.removeItem(LEGACY_DEVICE_SETTINGS_KEY).catch(() => {})
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

// Hydrate behind the launch splash so saved settings (navigation mode, theme,
// player layout) are ready before the first render that reads them.
void hydrateSettings()
