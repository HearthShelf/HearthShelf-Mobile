/**
 * Mobile reader display preferences. The model (themes, sizes, defaults) is
 * shared across every HearthShelf surface via @hearthshelf/core; this is the
 * mobile binding - a plain subscribe/snapshot store (matching the app's
 * store/settings.ts convention, no Zustand) persisted to AsyncStorage.
 *
 * Device-local and NOT synced: the reader is a HearthShelf feature ABS knows
 * nothing about, and the web apps likewise keep these client-only. Cross-device
 * reader-pref sync (via the core SETTINGS_CATALOG) is a deliberate follow-up.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { READER_DEFAULTS, type ReaderPrefs, type ReaderFont } from '@hearthshelf/core'

const STORAGE_KEY = 'hs.readerPrefs'

// Font-family names as registered in the WebView CSS. epub.js applies these via
// changeFontFamily; the stacks fall back to the platform serif/sans if a bundled
// face is missing. Keep the keys aligned with core's ReaderFont union.
export const READER_FONT_FAMILIES: Record<ReaderFont, string> = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: '-apple-system, "Helvetica Neue", Roboto, sans-serif',
  dyslexic: '"OpenDyslexic", "Comic Sans MS", sans-serif',
}

let state: ReaderPrefs = { ...READER_DEFAULTS }
const listeners = new Set<() => void>()
let hydrated = false

export function getReaderPrefs(): ReaderPrefs {
  return state
}

export function subscribeReaderPrefs(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function setReaderPref<K extends keyof ReaderPrefs>(key: K, value: ReaderPrefs[K]): void {
  state = { ...state, [key]: value }
  listeners.forEach((l) => l())
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(state)).catch(() => {})
}

/** Load persisted prefs once at reader mount. Merges over defaults so a stored
 *  object missing a newly-added key still gets that key's default. */
export async function hydrateReaderPrefs(): Promise<void> {
  if (hydrated) return
  hydrated = true
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<ReaderPrefs>
      state = { ...READER_DEFAULTS, ...saved }
      listeners.forEach((l) => l())
    }
  } catch {
    // Corrupt/unavailable storage - defaults stand.
  }
}
