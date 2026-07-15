/**
 * Design tokens. The colour palette is now REACTIVE: it derives from the user's
 * theme (`dark` | `light` | `flat`/OLED) and their chosen accent colour, resolved
 * through useTheme() (see ThemeProvider). The dark+ember palette is also exported
 * as the static `colors` default so code paths outside the React tree (the
 * headless car service) and any not-yet-migrated screen keep working.
 *
 * `color-mix(in oklab, ...)` expressions from the web CSS are resolved here to
 * concrete rgba so React Native can consume them.
 */

// --- accent helpers ---------------------------------------------------------

/** Parse a #rrggbb hex to [r,g,b] (0-255). Falls back to ember on bad input. */
function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim())
  const h = m ? m[1] : 'e0654a'
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** rgba() string for a #rrggbb hex at a given alpha (washes, scrims, glows). */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgba(${r},${g},${b},${alpha})`
}

const accentAlpha = withAlpha

/** Blend two #rrggbb hexes: t=0 -> a, t=1 -> b (approximates CSS color-mix). */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a)
  const [br, bg, bb] = hexToRgb(b)
  const c = (x: number, y: number) => Math.round(x + (y - x) * t)
  return `rgb(${c(ar, br)},${c(ag, bg)},${c(ab, bb)})`
}

// --- palettes ---------------------------------------------------------------

export interface Palette {
  scaffold: string
  lowest: string
  low: string
  base: string
  high: string
  highest: string
  sheet: string
  card: string
  popover: string
  elevated: string
  text: string
  textMuted: string
  textFaint: string
  onAccent: string
  mutedForeground: string
  accent: string
  brandHearth: string
  brandShelf: string
  brandCream: string
  border: string
  hairline: string
  fill: string
  fillStrong: string
  rowNow: string
  accentWash: string
  accentTile: string
  scrim: string
  destructive: string
  success: string
}

export type ThemeName = 'dark' | 'light' | 'flat' | 'oled'

// Base surface/text ramps per theme. The accent-derived tokens (accent, rowNow,
// accentWash, accentTile, onAccent) are layered on top by buildPalette so the
// user's accent colour flows everywhere.
interface BasePalette {
  scaffold: string
  lowest: string
  low: string
  base: string
  high: string
  highest: string
  sheet: string
  text: string
  textMuted: string
  textFaint: string
  border: string
  hairline: string
  fill: string
  fillStrong: string
}

const DARK_BASE: BasePalette = {
  scaffold: '#1b1a18',
  lowest: '#131211',
  low: '#201e1c',
  base: '#242220',
  high: '#2a2825',
  highest: '#322f2b',
  sheet: '#222120',
  text: '#f4f1ea',
  textMuted: '#aba498',
  textFaint: '#756f64',
  border: '#383530',
  hairline: 'rgba(255,255,255,0.08)',
  fill: 'rgba(255,255,255,0.06)',
  fillStrong: 'rgba(255,255,255,0.10)',
}

// OLED / flat: pure-black scaffold, slightly brighter text, same warm ramp above.
const OLED_BASE: BasePalette = {
  ...DARK_BASE,
  scaffold: '#000000',
  lowest: '#000000',
  low: '#0d0c0b',
  base: '#141312',
  high: '#1a1917',
  highest: '#242220',
  sheet: '#141312',
  text: '#f7f4ee',
}

const LIGHT_BASE: BasePalette = {
  scaffold: '#f7f6f3',
  lowest: '#efece6',
  low: '#f0ede7',
  base: '#ffffff',
  high: '#e7e5df',
  highest: '#dcd9d1',
  sheet: '#f2efe9',
  text: '#1b1916',
  textMuted: '#6c665d',
  textFaint: '#948d81',
  border: '#d8d4cc',
  hairline: 'rgba(0,0,0,0.10)',
  fill: 'rgba(0,0,0,0.05)',
  fillStrong: 'rgba(0,0,0,0.09)',
}

const BASES: Record<ThemeName, BasePalette> = {
  dark: DARK_BASE,
  oled: OLED_BASE,
  flat: OLED_BASE, // flat aliases OLED for now (pure black, no bloom)
  light: LIGHT_BASE,
}

/** The hearth ember accent - the default when accentMode is dynamic/unset. */
export const EMBER = '#e0654a'

/** Readable ink/cream over an accent hex, chosen by relative luminance. */
export function onColor(hex: string): string {
  const [r8, g8, b8] = hexToRgb(hex)
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const L = 0.2126 * lin(r8) + 0.7152 * lin(g8) + 0.0722 * lin(b8)
  return L > 0.42 ? '#1a1509' : '#fff'
}

/** Build the full palette for a theme + accent. */
export function buildPalette(themeName: ThemeName, accentHex: string): Palette {
  const b = BASES[themeName] ?? DARK_BASE
  const accent = /^#?[0-9a-fA-F]{6}$/.test(accentHex.trim()) ? accentHex : EMBER
  return {
    ...b,
    card: b.high,
    popover: b.base,
    elevated: b.highest,
    mutedForeground: b.textMuted,
    onAccent: onColor(accent),
    accent,
    brandHearth: '#bd863f',
    brandShelf: '#f0e6d6',
    brandCream: '#ffe6cf',
    rowNow: accentAlpha(accent, 0.22),
    accentWash: accentAlpha(accent, 0.12),
    accentTile: accentAlpha(accent, 0.22),
    scrim: themeName === 'light' ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.55)',
    destructive: '#e0654a',
    success: '#7fa86b',
  }
}

/** Elevation + accent-tinted shadows for a palette. */
export function buildShadow(p: Palette) {
  return {
    lift: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.5,
      shadowRadius: 24,
      elevation: 12,
    },
    card: {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.25,
      shadowRadius: 6,
      elevation: 3,
    },
    accentLift: {
      shadowColor: p.accent,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.5,
      shadowRadius: 16,
      elevation: 12,
    },
    accentGlow: {
      shadowColor: p.accent,
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.34,
      shadowRadius: 12,
      elevation: 8,
    },
  } as const
}

// --- static defaults (dark + ember) ----------------------------------------
// Kept for code outside the React tree (headless car service) and any screen not
// yet reading useTheme(). These are the dark palette; migrated screens use the
// reactive palette from useTheme() instead.

export const colors = buildPalette('dark', EMBER)

export const radius = {
  card: 16,
  row: 12,
  pill: 999,
  sheet: 20,
  tile: 10,
} as const

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const

/**
 * Font families, loaded via expo-font in app/_layout.tsx (keys must match).
 * Design-system roles: sans = Inter (UI), mono = Geist Mono (numerals/time),
 * brand = Libre Baskerville (wordmark, eyebrows, editorial).
 */
// These MUST match each font file's internal (PostScript) family name, because
// iOS resolves fontFamily against that name, not the filename. The static Inter
// set reports "Inter 18pt" (its optical-size variant); Geist Mono and Libre
// Baskerville carry a space. See app.config.js expo-font plugin.
export const fonts = {
  sans: 'Inter 18pt',
  mono: 'Geist Mono',
  brand: 'Libre Baskerville',
} as const

/**
 * Type scale (size + weight pairs) matching the web mobile hierarchy.
 */
export const type = {
  hero: { fontSize: 22, fontWeight: '700' as const, fontFamily: fonts.sans },
  title: { fontSize: 18, fontWeight: '700' as const, fontFamily: fonts.sans },
  body: { fontSize: 16, fontWeight: '500' as const, fontFamily: fonts.sans },
  label: { fontSize: 14, fontWeight: '600' as const, fontFamily: fonts.sans },
  meta: { fontSize: 13, fontWeight: '500' as const, fontFamily: fonts.sans },
  caption: { fontSize: 11, fontWeight: '500' as const, fontFamily: fonts.sans },
  mono: { fontSize: 13, fontWeight: '500' as const, fontFamily: fonts.mono },
  eyebrow: {
    fontSize: 11,
    fontWeight: '400' as const,
    fontFamily: fonts.brand,
    letterSpacing: 1.6,
    textTransform: 'uppercase' as const,
  },
  quote: {
    fontSize: 16,
    fontWeight: '400' as const,
    fontFamily: fonts.brand,
    fontStyle: 'italic' as const,
  },
} as const

/**
 * App-wide ceiling on OS font scaling. The type scale and most containers use
 * fixed pixel sizes, so unbounded scaling (a user cranking the phone's Display
 * Size / Text Size up) overflows pills, rows, and tiles and text starts to
 * overlap. Capping at 1.25x still gives large-text users noticeably bigger type
 * while keeping every layout intact on both platforms. AppText applies it to all
 * app copy; the few raw <Text> nodes in fixed-height containers (the scrubber
 * pill, tab bar, toast, and the shared button/chip primitives) pass it
 * explicitly. React 19 dropped Text.defaultProps, so there is no global default -
 * a raw <Text> without this prop scales unbounded.
 */
export const MAX_FONT_SCALE = 1.25

export const shadow = buildShadow(colors)

export const theme = { colors, radius, spacing, type, shadow } as const
export type Theme = typeof theme
