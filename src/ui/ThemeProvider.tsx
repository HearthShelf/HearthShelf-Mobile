/**
 * Reactive theme context. Reads the user's theme + accent from the settings store
 * and exposes the derived palette/shadow through useTheme(), so every screen
 * re-renders when the user changes theme or accent colour. Mount once near the
 * app root (app/_layout.tsx), inside the providers that give it the settings
 * store subscription.
 *
 * Code outside the React tree (the headless car service) can't use the hook; it
 * falls back to the static dark+ember `colors` export in theme.ts.
 */
import { createContext, useContext, useMemo } from 'react'
import { useSyncExternalStore } from 'react'
import { useColorScheme } from 'react-native'
import { coverHue } from '@hearthshelf/core'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { getTrackId, subscribe as subscribePlayer } from '@/player/store'
import { buildPalette, buildShadow, EMBER, type Palette, type ThemeName } from './theme'

export interface ActiveTheme {
  colors: Palette
  shadow: ReturnType<typeof buildShadow>
  name: ThemeName
}

const ThemeCtx = createContext<ActiveTheme | null>(null)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)
  // 'auto' follows the OS appearance (system dark -> our Dark palette, system
  // light -> Light); every other value is a concrete palette. useColorScheme()
  // re-renders on OS light/dark changes, so Auto flips live.
  const scheme = useColorScheme()
  const name: ThemeName = s.theme === 'auto' ? (scheme === 'light' ? 'light' : 'dark') : s.theme
  // accentMode 'dynamic' follows the playing book's cover hue; 'manual' pins the
  // accent to the user's chosen hex. Both are account-scoped settings shared with
  // the web app, so the mode a user picks on either surface applies on both
  // (DESIGN.shared.md, "Accent").
  //
  // getTrackId() is stable across position ticks, so subscribing here re-themes
  // on a book change rather than at 1Hz. With nothing playing, dynamic falls back
  // to the chosen hex so the app never loses its accent between books.
  const trackId = useSyncExternalStore(subscribePlayer, getTrackId)
  const chosen = s.accentHex || EMBER
  const accent = s.accentMode === 'dynamic' && trackId ? coverHue(trackId) : chosen

  const value = useMemo<ActiveTheme>(() => {
    const colors = buildPalette(name, accent)
    return { colors, shadow: buildShadow(colors), name }
  }, [name, accent])

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>
}

/** The active palette + shadow. Falls back to dark+ember outside a provider. */
export function useTheme(): ActiveTheme {
  const v = useContext(ThemeCtx)
  if (v) return v
  const colors = buildPalette('dark', EMBER)
  return { colors, shadow: buildShadow(colors), name: 'dark' }
}

/** Convenience: just the palette (the common case). */
export function useColors(): Palette {
  return useTheme().colors
}
