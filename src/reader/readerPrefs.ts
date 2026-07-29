/**
 * Mobile reader display preferences. The model (themes, sizes, defaults) is
 * shared across every HearthShelf surface via @hearthshelf/core; this is the
 * mobile binding - a reader-shaped view over the settings store.
 *
 * These used to be a separate AsyncStorage blob that never left the device, so a
 * reinstall or a new phone lost them. They now live in store/settings.ts under
 * the catalogued `reader*` keys (READER_SETTING_KEYS), which means they persist
 * and sync like every other setting. They stay DEVICE-scoped - a type size that
 * suits a phone rarely suits a desktop - but device scope is still stored
 * server-side and restored onto a reinstalled or brand-new device.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { READER_SETTING_KEYS, readerPrefsFrom } from '@hearthshelf/core'
import type { ReaderPrefs, ReaderFont } from '@hearthshelf/core'
import {
  getSettingsState,
  hydrateSettings,
  setSetting,
  subscribeSettings,
  type SettingsState,
} from '@/store/settings'

const LEGACY_STORAGE_KEY = 'hs.readerPrefs'

// Font-family names as registered in the WebView CSS. epub.js applies these via
// changeFontFamily; the stacks fall back to the platform serif/sans if a bundled
// face is missing. Keep the keys aligned with core's ReaderFont union.
export const READER_FONT_FAMILIES: Record<ReaderFont, string> = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: '-apple-system, "Helvetica Neue", Roboto, sans-serif',
  dyslexic: '"OpenDyslexic", "Comic Sans MS", sans-serif',
}

// Cached projection of the settings store so getReaderPrefs() returns a stable
// reference between changes - useSyncExternalStore loops on a fresh object every
// call. The settings store replaces its state object on every write, so identity
// is the cheap "did anything change" check.
let snapshotFrom: SettingsState = getSettingsState()
let snapshot: ReaderPrefs = readerPrefsFrom(snapshotFrom as unknown as Record<string, unknown>)

export function getReaderPrefs(): ReaderPrefs {
  const settings = getSettingsState()
  if (settings !== snapshotFrom) {
    snapshotFrom = settings
    snapshot = readerPrefsFrom(settings as unknown as Record<string, unknown>)
  }
  return snapshot
}

export function subscribeReaderPrefs(fn: () => void): () => void {
  return subscribeSettings(fn)
}

export function setReaderPref<K extends keyof ReaderPrefs>(key: K, value: ReaderPrefs[K]): void {
  // READER_SETTING_KEYS pairs each reader field with the catalog key holding the
  // same type (theme -> readerTheme), so the value always fits its target; the
  // cast is only needed because the mapping is a lookup, not a literal.
  setSetting(READER_SETTING_KEYS[key] as keyof SettingsState, value as never)
}

/** Load persisted prefs. The settings store owns them now, so this is its
 *  hydrate plus a one-time import of the pre-catalog reader blob. Idempotent. */
export async function hydrateReaderPrefs(): Promise<void> {
  await hydrateSettings()
  await importLegacyReaderPrefs()
}

let legacyImported: Promise<void> | null = null

// Carry a pre-catalog `hs.readerPrefs` blob into the settings store once, then
// drop it. Written through setSetting so the values are stamped and pushed to
// the server - that's how a reader setup chosen before this change gets backed
// up instead of being lost at the next reinstall.
function importLegacyReaderPrefs(): Promise<void> {
  if (!legacyImported) {
    legacyImported = (async () => {
      try {
        const raw = await AsyncStorage.getItem(LEGACY_STORAGE_KEY)
        if (!raw) return
        const saved = JSON.parse(raw) as Partial<ReaderPrefs>
        for (const field of Object.keys(READER_SETTING_KEYS) as (keyof ReaderPrefs)[]) {
          const value = saved[field]
          if (value === undefined) continue
          setReaderPref(field, value)
        }
        await AsyncStorage.removeItem(LEGACY_STORAGE_KEY)
      } catch {
        // Corrupt/unavailable storage - the catalog defaults stand.
      }
    })()
  }
  return legacyImported
}
