---
name: HearthShelf Mobile
description: A shelf of books in a warm, dark room — an audiobook client that stays legible at 2am and in the car.
colors:
  ember: "#e0654a"
  brand-hearth: "#bd863f"
  brand-shelf: "#f0e6d6"
  brand-cream: "#ffe6cf"
  scaffold: "#1b1a18"
  surface-lowest: "#131211"
  surface-low: "#201e1c"
  surface-base: "#242220"
  surface-high: "#2a2825"
  surface-highest: "#322f2b"
  sheet: "#222120"
  text: "#f4f1ea"
  text-muted: "#aba498"
  text-faint: "#756f64"
  border: "#383530"
  hairline: "rgba(255,255,255,0.08)"
  fill: "rgba(255,255,255,0.06)"
  fill-strong: "rgba(255,255,255,0.10)"
  scrim: "rgba(0,0,0,0.55)"
  success: "#5a9c52"
  destructive: "#c4463a"
  oled-scaffold: "#000000"
  light-scaffold: "#f7f6f3"
  light-text: "#1b1916"
typography:
  hero:
    fontFamily: "Inter 18pt"
    fontSize: "22px"
    fontWeight: 700
  title:
    fontFamily: "Inter 18pt"
    fontSize: "18px"
    fontWeight: 700
  body:
    fontFamily: "Inter 18pt"
    fontSize: "16px"
    fontWeight: 500
  label:
    fontFamily: "Inter 18pt"
    fontSize: "14px"
    fontWeight: 600
  meta:
    fontFamily: "Inter 18pt"
    fontSize: "13px"
    fontWeight: 500
  caption:
    fontFamily: "Inter 18pt"
    fontSize: "11px"
    fontWeight: 500
  mono:
    fontFamily: "Geist Mono"
    fontSize: "13px"
    fontWeight: 500
  eyebrow:
    fontFamily: "Libre Baskerville"
    fontSize: "11px"
    fontWeight: 400
    letterSpacing: "1.6px"
  quote:
    fontFamily: "Libre Baskerville"
    fontSize: "16px"
    fontWeight: 400
rounded:
  tile: "10px"
  row: "12px"
  card: "16px"
  sheet: "20px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  xxl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ember}"
    textColor: "#ffffff"
    typography: "{typography.label}"
    rounded: "{rounded.card}"
    padding: "12px 24px"
  chip:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.text-muted}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
  chip-active:
    backgroundColor: "rgba(224,101,74,0.22)"
    textColor: "{colors.text}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "8px 16px"
  card:
    backgroundColor: "{colors.surface-high}"
    textColor: "{colors.text}"
    rounded: "{rounded.card}"
    padding: "16px"
  row:
    backgroundColor: "{colors.surface-high}"
    textColor: "{colors.text}"
    rounded: "{rounded.row}"
    padding: "12px 16px"
  sheet:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.text}"
    rounded: "{rounded.sheet}"
    padding: "0 16px 24px"
---

# Design System: HearthShelf Mobile

> **Inherits [`DESIGN.shared.md`](packages/core/DESIGN.shared.md) in
> `@hearthshelf/core`** — the cross-surface contract covering the palette, the
> three type voices, the radius ladder, the cover glow, themes, and the accent.
> Those live there because theme, `accentHex` and `glow` are account-scoped
> settings that sync between this app and the web app: drift is a bug, not a
> dialect.
>
> This file owns the **mobile platform layer** — the type scale, gesture grammar,
> motion, navigation, and the native constraints (safe areas, font-scale ceiling,
> car glanceability) that the web surface neither has nor should inherit. Values
> repeated from the shared contract are noted as such; when they disagree, the
> shared file wins.

## Overview

**Creative North Star: "The Hearthside Shelf"**

A shelf of books in a warm, dark room with a fire going. Two things are true at
once, and every visual decision serves one of them. The *hearth* is the light and
the ground: a warm-neutral brown-black (#1b1a18, never blue-black), a single ember
accent that glows rather than shouts, and shadows tinted by that ember so lifted
things feel lit instead of merely raised. The *shelf* is the subject: cover
artwork is the content, and the chrome's job is to hold it and then get out of the
way.

The system is dense but unhurried. Surfaces stack through a five-step warm ramp
rather than a border-per-box, radii are generous but never soft-toy round, and
motion has one vocabulary — a tuned pop for press feedback, a slower bubble for
large entrances, and a "Shelf Lift" fade-and-settle on every navigation. Nothing
bounces for its own sake. The app is used by people in a dark room holding a phone
one-handed and by people in a moving vehicle who cannot look at it, so legibility
at low light and at a glance outranks expression everywhere they conflict.

The palette is not fixed. Theme (dark / light / OLED-flat) and accent color are
user settings resolved at runtime through `ThemeProvider`, and every token below
is the *default* dark+ember resolution of a reactive system. A surface that only
looks right in one palette is unfinished. The one thing that never varies is the
metaphor: this is a hearth and a shelf, and it stays a metaphor. It is never
rendered literally.

**Key Characteristics:**

- Warm-neutral ground (#1b1a18) — brown-black, deliberately not blue-black
- Ember accent (#e0654a) as the room's warmth, user-changeable
- Five-step tonal surface ramp doing the everyday depth work
- Covers lead; chrome recedes to hold them
- One motion vocabulary, sourced from `src/ui/motion.tsx`, never reinvented per screen
- Reactive: dark, light, and OLED-flat are all first-class

## Colors

**The palette is shared** — surface ramp, text colors, brand marks, state colors,
and fill/hairline alphas all live in `DESIGN.shared.md` and must match the web
app exactly. See it for the values and for The Warm Grey, Two Warms,
Cover-Supplies-Colour, Destructive-Is-Not-Ember, and Live Accent rules.

What is mobile-specific:

- **Accent washes.** `accentWash` at 12%, `accentTile` and `rowNow` at 22% of the
  live accent (`withAlpha` in `theme.ts`).
- **Brand Cream** (`#ffe6cf`): a warm highlight cream used in mobile brand
  moments beyond the wordmark.
- **State colors darken on light.** The shared hexes are tuned for the dark room,
  so `buildPalette` swaps them in the light theme: destructive
  `#c4463a` → `#b03f34`, success `#5a9c52` → `#47803f`. Both are icon colors, so
  3:1 is the floor they must clear; the light variants keep them above 4.3:1
  rather than at the line.

### Named Rules

**The Reactive Palette Rule.** No hardcoded hex in screens. Colors come from
`useTheme()` / `useColors()`. The static `colors` export exists only for code
outside the React tree (the headless car service) and is not a license to bypass
the hook.

## Typography

**Display Font:** Libre Baskerville (serif)
**Body Font:** Inter — shipped as `Inter 18pt`, its optical-size variant
**Label/Mono Font:** Geist Mono

**Character:** Plain-spoken, with a literary aside. Inter does the work and never
performs — it carries every label, row, button, and body string invisibly. Libre
Baskerville is a guest, not the host: it appears in the wordmark, in tracked-out
uppercase eyebrows, and in quotes, and nowhere else. Geist Mono exists for one
reason — numerals that don't shift width as time ticks.

### Hierarchy

- **Hero** (700, 22px): Screen-leading titles. The largest type in the app; there
  is no display tier above it, because a phone screen held at arm's length in the
  dark does not need one.
- **Title** (700, 18px): Section headers, sheet titles, card headings.
- **Body** (500, 16px): Primary reading copy. Note the weight — 500, not 400.
  Body text at 400 on a warm dark ground goes soft; 500 holds.
- **Label** (600, 14px): Buttons, chips, controls. Anything you press.
- **Meta** (500, 13px): Author names, durations, counts, secondary rows.
- **Caption** (500, 11px): The floor. Timestamps, sheet kickers, tab labels.
- **Mono** (Geist Mono, 500, 13px): Elapsed and remaining time, position readouts,
  anything that counts.
- **Eyebrow** (Libre Baskerville, 400, 11px, +1.6px tracking, uppercase): Section
  kickers above a title. The serif's main structural appearance.
- **Quote** (Libre Baskerville, 400, 16px, italic): Pulled text and editorial
  moments.

### Named Rules

**The 11px Floor Rule.** Nothing renders below 11px. There is no smaller tier and
none may be added — this app is read in the dark and, at a glance, from a driver's
seat.

*(The three type voices and their roles — including the serif's scarcity and the
mono-numerals rule — are shared; see `DESIGN.shared.md`. The scale below is
mobile's own: web's display tier is ~76px and must not be borrowed here.)*

**The 1.25× Scale Ceiling Rule.** OS font scaling is capped at `MAX_FONT_SCALE`
(1.25). The type scale and most containers use fixed pixel sizes, so unbounded
scaling overflows pills, rows, and tiles until text overlaps. React 19 dropped
`Text.defaultProps`, so **a raw `<Text>` without `maxFontSizeMultiplier` scales
unbounded** — use `AppText`, or pass the prop explicitly in fixed-height
containers.

**The Mono Numerals Rule.** Any number that changes in place — elapsed time,
remaining, position — is Geist Mono. Proportional numerals jitter the layout on
every tick.

## Layout

Three window classes, measured on width: **compact** (<600px), **medium**
(600–839px), **expanded** (≥840px). Compact is the design target; the others are
adaptations, not separate designs.

Horizontal padding is 16px (`lg`) on compact and 24px (`xl`) above it. Content max
width is unbounded on compact and clamps to 640px on medium and expanded, so a
tablet or a foldable reads as a comfortable column rather than a stretched phone.
Grids are computed, not fixed: `adaptiveGridColumns` derives the column count from
a minimum tile width and the available space, so cover grids reflow honestly
across sizes instead of snapping between hardcoded breakpoint layouts.

The spacing scale is 4 / 8 / 12 / 16 / 24 / 32. Rhythm inside a row is 12px
(`md`); between sections it is 16–24px. Gutters in cover grids default to 16px.

Both platforms lay out inside safe-area insets, with the Android build running
edge-to-edge and applying window insets explicitly — including the IME inset,
where `KeyboardAvoidingView` must use `behavior="padding"` on Android as well as
iOS.

### Named Rules

**The Thumb Zone Rule.** Frequent controls live in the bottom half of the screen.
The player's queue and sync controls sit in the transport zone, not the header.

**The Computed Grid Rule.** Never hardcode a column count. Derive it from
`adaptiveGridColumns` so tile width stays honest at every window size.

## Elevation & Depth

Hybrid, and honestly so. The **warm tonal ramp does the everyday work**: scaffold →
lowest → low → base → high → highest is how nearly everything separates from
everything else, with a hairline rim for definition. Cards and rows are tonal
surfaces with a whisper of shadow, not floating objects.

**Real shadow and blur are reserved for things that genuinely float above
content**: the tab bar's glass pill, bottom sheets, and lifted cards. The tab bar
is a true backdrop blur — whatever scrolls behind it is frosted, with an ember
tint over the blurred result and a hairline rim so the edge reads crisply against
the blur-through. That is the one place in the app where material, not tone, does
the separating.

Accent-tinted shadows are a third, distinct thing: they mean **lit**, not raised.
An `accentGlow` under a playing element says the ember is behind it.

### Shadow Vocabulary

- **card** (`0 2px 6px rgba(0,0,0,0.25)`, elevation 3): The whisper under cards
  and rows. Present so a surface isn't paper-flat; never enough to read as lifted.
- **lift** (`0 12px 24px rgba(0,0,0,0.5)`, elevation 12): Genuine elevation —
  sheets, the tab bar pill, dragged or raised cards.
- **accentLift** (`0 2px 16px accent @50%`, elevation 12): A lifted element that
  is also live.
- **accentGlow** (`0 8px 12px accent @34%`, elevation 8): The hearth glow. Playing
  state, active emphasis. Not an elevation cue.

### Named Rules

**The Tone-First Rule.** Reach for the next surface step before reaching for a
shadow. If two surfaces can be separated tonally, they must be — shadow is spent
only on things that actually float.

**The Glow Means Alive Rule.** Accent-tinted shadow means *lit*, never *raised*.
If an element is elevated but not live, it takes `lift`, not `accentLift`.

## Shapes

The radius ladder is shared (`DESIGN.shared.md`): tile 10px, row 12px, card 16px,
pill 999px. Mobile's sheet radius is **20px** where web's is 24px — a phone sheet
spans the full width, so the smaller radius keeps its corners from reading as a
floating card. Anything that reads as a control rather than a container takes
pill — chips, the tab bar's glass band and its indicator, badges.

Borders are hairline-width by default (`StyleSheet.hairlineWidth` at 8% white),
not 1px solid. On a warm dark ground a full-weight border draws a box; a hairline
draws an edge. Solid `border` is reserved for edges that must survive against
cover artwork.

Cover aspect ratio is a **user setting**, applied consistently — one aspect
everywhere, never mixed within a screen.

### Named Rules

**The Hairline Default Rule.** Rims are hairline at 8% white. A 1px solid border
anywhere in the ordinary UI is a mistake unless it is fighting artwork.

## Components

### Buttons

- **Shape:** Card radius (16px), matching the containers they sit in.
- **Primary:** Live accent ground with `onAccent` text — an ink or cream chosen by
  the accent's relative luminance, so a user's custom accent never produces
  unreadable label text. Padding 12px vertical / 24px horizontal, icon at 18px,
  8px gap.
- **Pressed:** Opacity to 0.6. Every tappable surface acknowledges the touch
  immediately.
- **Icon buttons:** Bare icon at 24px in `text`, with 10px `hitSlop` so the target
  clears the platform minimum even when the glyph doesn't. **Always carry an
  `accessibilityLabel`** — an icon alone announces as "button".
- **Touchable:** The general-purpose pressable adds an Android ripple plus a
  pressed dim, so a tap never feels unregistered while the action catches up.

### Chips

- **Style:** Pill radius, neutral `fill` ground, muted label text at Label size.
- **Active:** Accent tile wash (22% of the live accent) with full-strength text.
- **Behavior:** Chips never shrink below their label in a horizontal row.

### Cards / Containers

- **Corner Style:** Card radius (16px).
- **Background:** Surface High (`#2a2825`).
- **Border:** Hairline rim at 8% white.
- **Shadow:** `card` only — a whisper, per the Tone-First Rule.
- **Internal Padding:** 16px (`lg`).

### Rows

- **Style:** Surface High ground, row radius (12px), hairline rim, 12px vertical /
  16px horizontal padding, 12px gap between elements.
- **Now-playing:** Tinted with `rowNow` (22% of the live accent).

### Sheets

Bottom sheets are the app's primary sub-task surface. Sheet ground (`#222120`),
sheet radius (20px), a `textFaint` grab handle, and a scrim at 55%. Body padding
is 16px horizontal / 24px bottom. Sheets size dynamically to their content unless
given explicit snap points; a fixed-height sheet fills so a scrolling child gets a
bounded height. An optional header carries an uppercase caption kicker, a Title,
and a muted caption subtitle.

### Navigation

**The glass tab bar is this app's signature component.** Five destinations in a
floating pill band with a genuine backdrop blur: content scrolling behind it is
frosted, an ember tint overlays the blurred result, both clip to the pill, and a
hairline rim keeps the edge crisp against the blur-through. The active indicator
is a pill that animates its position and height between items rather than
cross-fading. Labels are Caption (11px). The tab owning the current screen stays
lit on pushed detail routes.

### Covers

Cover art is the content, so its failure states are designed rather than
defaulted. Real artwork sits on a Surface Highest well. When artwork is missing or
fails, a typeset fallback renders — a hue-derived ground with the title's initial
and a kicker. Remote loads retry on a backoff ramp (2s → 5s → 12s → 30s, then
repeating), so artwork fills in whenever the network recovers.

The hue comes from `coverHue(item.id)` in `@hearthshelf/core` — **the same
function and seed the web app uses**, so a book is the same color on every
surface (`DESIGN.shared.md`, The One Cover Palette Rule). Never seed on the title
and never introduce a local tint list.

`<CoverGlow>` follows the account-scoped `glow` setting by default; pass an
explicit `strength` only to hold a surface deliberately dimmer than the user's
pick, as the Following hero does behind dense text.

### Motion

One vocabulary, in `src/ui/motion.tsx`. New animation work draws from these rather
than inventing curves:

- **POP_SPRING** (damping 13, stiffness 380, mass 0.5): Press feedback. Snaps in
  ~200ms.
- **BUBBLE_SPRING** (damping 26, stiffness 190, mass 1): Large-surface entrances —
  ~520ms to rest with ~2% overshoot. Deliberately *not* POP, which reads as a
  flash at this size.
- **DUR** (fast 120 / base 180 / slow 220ms): Fades and layout transitions.
- **LIFT** (micro 8px/200ms, standard 18px/240ms, zero 0px/120ms): The "Shelf
  Lift" navigation grammar — every entrance is a fade plus an upward settle, every
  exit sinks. Tab swaps whisper (micro); pushes and the player speak (standard).
- **PULSE_MS** (2600): The hearth's breathing period, for anything that should
  feel live rather than statically tinted.

### Named Rules

**The One Vocabulary Rule.** Springs and durations come from `motion.tsx`. A
bespoke curve in a screen file is a defect, not a flourish.

**The Reduce Motion Rule.** `useReducedMotion()` is a single shared import for
exactly this reason. Under Reduce Motion, loops go static and large entrances
become cross-fades — LIFT drops to `zero`, opacity only.

**The One Spring Rule.** Drive a growth as one spring per axis from start to rest.
Intermediate waypoints restart the easing mid-growth and read as a stutter.

## Do's and Don'ts

### Do:

- **Do** read every color from `useTheme()` / `useColors()`. The documented values
  are the dark+ember resolution of a reactive system, not constants.
- **Do** keep neutrals warm. If a grey reads cool next to `#1b1a18`, it's wrong.
- **Do** derive accent-tinted surfaces with `withAlpha` on the live accent, so a
  user's chosen color flows everywhere.
- **Do** separate surfaces tonally first; spend shadow only on things that
  genuinely float.
- **Do** use `AppText`, or pass `maxFontSizeMultiplier={MAX_FONT_SCALE}` on any
  raw `<Text>` in a fixed-height container.
- **Do** give every icon-only control an `accessibilityLabel`.
- **Do** design the loading, empty, error, and offline state of every surface.
  Offline is a first-class mode here, not a failure.
- **Do** source motion from `motion.tsx` and gate it on `useReducedMotion()`.
- **Do** verify every surface in dark, light, and OLED-flat before calling it
  finished.

### Don't:

- **Don't** render the metaphor literally. No wood grain, leather, paper
  textures, or bookshelf illustrations — the hearth and the shelf are a palette
  and a hierarchy, never scenery.
- **Don't** use pure white text or blue-black grounds. Both break the room.
- **Don't** set UI in Libre Baskerville. It's the wordmark, eyebrows, and quotes —
  never a button, row, label, or body string.
- **Don't** re-color or split the wordmark: "Hearth" gold (#bd863f) + "Shelf"
  cream (#f0e6d6), always together.
- **Don't** render type below 11px, or add a tier beneath Caption.
- **Don't** use proportional numerals for anything that counts in place — that's
  Geist Mono's job.
- **Don't** hardcode grid column counts; derive them from `adaptiveGridColumns`.
- **Don't** introduce a saturated color beyond the accent and the two shared
  state colors. Color that carries meaning is accent, destructive, or success.
- **Don't** tint a destructive action with the accent. It is user-changeable, so
  a borrowed accent can make delete the same color as the progress bar.
- **Don't** invent a spring or duration in a screen file.
- **Don't** seed a cover color on the title or from a local palette; use
  `coverHue(item.id)` so books match across surfaces.
