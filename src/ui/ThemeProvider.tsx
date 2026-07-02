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
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { buildPalette, buildShadow, EMBER, type Palette, type ThemeName } from './theme'

export interface ActiveTheme {
  colors: Palette
  shadow: ReturnType<typeof buildShadow>
  name: ThemeName
}

const ThemeCtx = createContext<ActiveTheme | null>(null)

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const s = useSyncExternalStore(subscribeSettings, getSettingsState)
  const name = s.theme as ThemeName
  // accentMode 'dynamic' means "follow the cover art"; until that's wired we use
  // the chosen accentHex (or ember). 'manual' always uses accentHex.
  const accent = s.accentMode === 'manual' ? s.accentHex || EMBER : s.accentHex || EMBER

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
