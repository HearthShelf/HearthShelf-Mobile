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
/** Aspect ratio (width/height) for cover tiles, per the CoverAspect setting. */
export const COVER_ASPECT_RATIO: Record<CoverAspect, number> = { square: 1, portrait: 2 / 3 }

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

  // Sleep timer defaults (seed player/store.ts's sleepBehavior on a fresh session)
  sleepRewindSec: number
  sleepChapterBarrier: boolean
  sleepFade: boolean
  sleepFadeLen: number
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

  sleepRewindSec: 30,
  sleepChapterBarrier: true,
  sleepFade: true,
  sleepFadeLen: 20,
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
    sleepRewindSec: s.sleepRewindSec,
    sleepChapterBarrier: s.sleepChapterBarrier,
    sleepFade: s.sleepFade,
    sleepFadeLen: s.sleepFadeLen,
  }
}
