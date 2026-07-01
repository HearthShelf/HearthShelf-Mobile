/**
 * Design tokens ported from the web app's dark palette
 * (HearthShelf-WebApp/src/styles/tokens.css, `.dark` block).
 *
 * The web theme system supports light/oled/flat variants; the native app ships
 * the dark palette only for v1. `color-mix(in oklab, ...)` expressions from the
 * CSS are resolved here to concrete rgba so React Native can consume them.
 */

export const colors = {
  // Surface ramp (scaffold -> highest), darkest to lightest.
  scaffold: '#1b1a18',
  lowest: '#131211',
  low: '#201e1c',
  base: '#242220',
  high: '#2a2825',
  highest: '#322f2b',
  sheet: '#222120',

  // Design-system role aliases (colors_and_type.css .dark). The prototype +
  // shared DS name surfaces by shadcn role; these map onto the ramp above so
  // components can match the mock without renaming the existing tokens.
  //   --background #1b1a18 = scaffold   --card #2a2825 = high
  //   --popover #242220    = base       --elevated #322f2b = highest
  card: '#2a2825',
  popover: '#242220',
  elevated: '#322f2b',
  // --muted-foreground #aba498 = textMuted (aliased in the text ramp below).

  // Text ramp.
  text: '#f4f1ea',
  textMuted: '#aba498',
  textFaint: '#756f64',
  onAccent: '#ffffff',
  // DS role alias: --muted-foreground = textMuted.
  mutedForeground: '#aba498',

  // Accent / brand. The web "accent" used for active states + CTAs is the warm
  // coral ring/destructive color; brand-hearth is the amber used in the wordmark.
  accent: '#e0654a',
  brandHearth: '#bd863f',
  brandShelf: '#f0e6d6',
  // Warm cream used for the scrubber leading line / fill highlights (DS 2f).
  brandCream: '#ffe6cf',

  // Lines + fills (semi-transparent over the surface).
  border: '#383530',
  hairline: 'rgba(255,255,255,0.08)',
  fill: 'rgba(255,255,255,0.06)',
  fillStrong: 'rgba(255,255,255,0.10)',

  // Derived: --row-now = color-mix(in oklab, accent 22%, transparent).
  rowNow: 'rgba(224,101,74,0.22)',
  // Accent washes used for chips / icon tiles (accent @ 12% / 22%).
  accentWash: 'rgba(224,101,74,0.12)',
  accentTile: 'rgba(224,101,74,0.22)',

  // Scrim behind sheets / modals.
  scrim: 'rgba(0,0,0,0.55)',

  destructive: '#e0654a',
  // Warm sage green (WebApp --chart-3) for finished/completed affordances.
  success: '#7fa86b',
} as const

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
 * brand = Libre Baskerville (wordmark, eyebrows, editorial). Libre Baskerville
 * is NOT the UI body face - it stays in the brand role only.
 */
export const fonts = {
  sans: 'Inter',
  mono: 'GeistMono',
  brand: 'LibreBaskerville',
} as const

/**
 * Type scale (size + weight pairs) matching the web mobile hierarchy. `hero` and
 * `title` are the page/section titles (Inter, bold); `mono` carries numerals and
 * time; `eyebrow` is the tracked-uppercase kicker (brand face); `quote` is the
 * editorial italic used for book blurbs (brand face).
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
  quote: { fontSize: 16, fontWeight: '400' as const, fontFamily: fonts.brand, fontStyle: 'italic' as const },
} as const

/** Elevation - --shadow-lift: 0 18px 48px rgba(0,0,0,0.55). */
export const shadow = {
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
} as const

export const theme = { colors, radius, spacing, type, shadow } as const
export type Theme = typeof theme
