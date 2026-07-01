/**
 * Cross-device user preferences (queue mode + auto-rules, plus the My Settings
 * screen's Appearance/Playback/Sleep prefs). Plain subscribe/snapshot store,
 * matching player/store.ts's convention - no Zustand in this app.
 *
 * Values persist server-side via /hs/settings (see queueSync.ts), same blob
 * the WebApp reads/writes, keyed by ABS user id - so switching between web and
 * mobile keeps the same queue mode, auto-rule, and playback choices. Local
 * state here is just the fast in-memory cache; sync is best-effort (offline
 * keeps defaults). player/store.ts reads the playback defaults (rate, skip
 * amounts, sleep behavior) from here when a fresh session starts, so My
 * Settings and the in-player sheets share one source of truth.
 */
import type { QueueMode, AutoRulePref } from '@hearthshelf/core'
import { DEFAULT_AUTO_RULES } from '@hearthshelf/core'

export type ThemePref = 'dark' | 'oled'
export type GlowMode = 'gradient' | 'image'
export type ScrubberScope = 'chapter' | 'book'
export type CoverAspect = 'square' | 'portrait'
/** How much haptic feedback to fire. See src/ui/haptics.ts for what each covers. */
export type HapticLevel = 'off' | 'minimal' | 'all'
export type HapticIntensity = 'light' | 'medium'
/** Aspect ratio (width/height) for cover tiles, per the CoverAspect setting. */
export const COVER_ASPECT_RATIO: Record<CoverAspect, number> = { square: 1, portrait: 2 / 3 }

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

  // Appearance
  theme: ThemePref
  glowMode: GlowMode
  coverAspect: CoverAspect

  // Playback
  scrubber: ScrubberScope
  defaultSpeed: number
  skipForward: number
  skipBack: number
  hearthBgPlayer: boolean
  haptics: HapticLevel
  hapticIntensity: HapticIntensity

  // Sleep timer defaults (seed player/store.ts's sleepBehavior on a fresh session)
  sleepRewindSec: number
  sleepChapterBarrier: boolean
  sleepFade: boolean
  sleepFadeLen: number

  // Player action buttons: arrangement across on-screen/tray/hidden, and whether
  // on-screen buttons drop their labels to fit more per row.
  playerActions: PlayerActionPref[]
  playerActionsIconOnly: boolean
}

let state: SettingsState = {
  queueMode: 'off',
  queueAutoRules: DEFAULT_AUTO_RULES,

  theme: 'dark',
  glowMode: 'gradient',
  coverAspect: 'square',

  scrubber: 'chapter',
  defaultSpeed: 1,
  skipForward: 30,
  skipBack: 15,
  hearthBgPlayer: true,
  haptics: 'minimal',
  hapticIntensity: 'light',

  sleepRewindSec: 30,
  sleepChapterBarrier: true,
  sleepFade: true,
  sleepFadeLen: 20,

  playerActions: DEFAULT_PLAYER_ACTIONS,
  playerActionsIconOnly: false,
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

/** Bulk-replace with values pulled from the server (device sync). */
export function applyServerSettings(values: Partial<SettingsState>): void {
  const patch = { ...values }
  if ('playerActions' in patch) {
    patch.playerActions = normalizePlayerActions(patch.playerActions)
  }
  set(patch)
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

/** Generic setter for the My Settings screen's rows. */
export function setSetting<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void {
  set({ [key]: value } as Partial<SettingsState>)
}

/** Snapshot the syncable values for a /hs/settings PUT. */
export function settingsValues(s: SettingsState = state): Record<string, unknown> {
  return {
    queueMode: s.queueMode,
    queueAutoRules: s.queueAutoRules,
    theme: s.theme,
    glowMode: s.glowMode,
    coverAspect: s.coverAspect,
    scrubber: s.scrubber,
    defaultSpeed: s.defaultSpeed,
    skipForward: s.skipForward,
    skipBack: s.skipBack,
    hearthBgPlayer: s.hearthBgPlayer,
    haptics: s.haptics,
    hapticIntensity: s.hapticIntensity,
    sleepRewindSec: s.sleepRewindSec,
    sleepChapterBarrier: s.sleepChapterBarrier,
    sleepFade: s.sleepFade,
    sleepFadeLen: s.sleepFadeLen,
    playerActions: s.playerActions,
    playerActionsIconOnly: s.playerActionsIconOnly,
  }
}
