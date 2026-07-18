# Shelf Lift motion contract — implementation plan (phase 1)

Signed spec: `docs/redesign/08-transitions-2.html` (acceptance record), built from
`08-transitions.html` (options + fold analysis) and `09-transitions-2.html` (dose recut).

## The contract

One grammar: every entrance is **fade + upward settle**, every exit **sinks + fades**.
Only the dose changes:

| Dose | Values | Applies to |
| --- | --- | --- |
| micro | 8px / 200ms | Tab swaps (Home/Library/Now/Stats/More) — was 160ms; retuned on device (read as a blink) |
| standard | 18px / 240ms | Stack pushes+pops (book, series, club, shelf, group, search, settings) and the pushed `/player` |
| zero | 0px / 120ms fade | OS Reduce Motion (and later: tabletop posture) |

Rules:
- **Dose follows the gesture, not the destination.** Now tab tap = micro (the tab renders
  `PlayerSurface embedded`); mini-dock tap = standard push of `/player`.
- **No sheet grammar anywhere.** `/player` loses `slide_from_bottom`.
- **Swipe rejection, no toast.** Downward drag on the player follows at ~0.1× to a 14px cap,
  springs back (~260ms). Never navigates. No toast, no alert.
- **Pop symmetry.** Parent restore = exact inverse of push dim (native stack handles this).
- **Native-first band.** Phase 1 uses native `fade_from_bottom`; 18/240 numbers are the
  design target for a later custom animator only if on-device review rejects the native feel.

## On-device tuning log

- 2026-07-16: tab swaps "blinked" - two causes fixed. (1) Both scenes faded
  simultaneously, so the dark scaffold bled through at the midpoint; the tab
  interpolators now hold opacity at 1 for |progress| <= 0.4 so one scene is
  always fully solid (crossfade through content, never through background).
  (2) micro duration raised 160ms -> 200ms. Stack pushes were checked and are
  not the blink: Android's native fade_from_bottom fades the incoming screen
  over a fully opaque outgoing one (210ms alpha / 350ms translate, fixed
  natively - not tunable from JS on Android).

## Shared constants (already added to `src/ui/motion.tsx` by the coordinator)

`LIFT` (dose table), `LIFT_REJECT` (followRatio/capPx), `LIFT_REJECT_SPRING`.
Workers import these; do not redeclare values inline.

## Work packages (non-overlapping files)

### A — Root stack grammar (`app/_layout.tsx` only)
- In `ThemedStack`, add `animation: 'fade_from_bottom'` to `Stack.screenOptions` so every
  pushed route is identical on iOS and Android.
- Reduced motion (`useReducedMotion()` from `@/ui/motion`): switch to `animation: 'fade'`.
- `/player` screen options: REMOVE `animation: 'slide_from_bottom'` (inherits the standard
  lift). KEEP `gestureEnabled: false`; additionally set `fullScreenGestureEnabled: false`
  if the installed expo-router/react-native-screens types expose it (check node_modules
  types — do not guess). Update the comment to reflect the new rationale (entry motion is
  a promise: no sheet grammar, no dismiss gesture; system back remains the sanctioned exit).

### B — Tab micro dose (`app/(tabs)/_layout.tsx` only)
- Goal: on tab change the incoming tab content fades in + lifts 8px→0 over 160ms; the tab
  bar and mini dock (root-mounted, outside the scenes) never move.
- Preferred: expo-router `js-tabs` wraps React Navigation bottom-tabs v7 — check the
  installed types for `animation` / `transitionSpec` / `sceneStyleInterpolator` screen
  options. If available, implement the lift with a `sceneStyleInterpolator` (opacity from
  `current.progress`, translateY interpolated 8→0) and a 160ms timing `transitionSpec`.
- If js-tabs does NOT pass those through, fall back to `animation: 'fade'` if available;
  if nothing is available, leave the file unchanged and report that — do not build a
  bespoke re-mount animation wrapper in phase 1.
- Reduced motion: zero displacement, 120ms opacity only (gate via `useReducedMotion`).

### C — Player swipe rejection (`app/player.tsx` only)
- On the full player, a downward pan drags the surface `translateY = min(capPx, dy * followRatio)`
  (constants from `LIFT_REJECT`), and on release springs back to 0 with `LIFT_REJECT_SPRING`.
  It NEVER navigates, collapses, or shows UI (no toast).
- Must not break existing gestures: swipe-UP on artwork = immersive mode, double-tap =
  lightbox, horizontal swipes = cover carousel, scrubber drags, sheet interactions. Read the
  existing artwork gesture wiring first and compose (e.g. extend the existing pan with a
  downward branch, or a screen-level pan that only activates on clearly-vertical downward
  movement with `activeOffsetY`/`failOffsetY(X)` guards).
- Apply the translate to the player surface root so the whole page nods, not just the cover.
- Works in both modes (pushed `/player` and embedded Now tab — same `PlayerSurface`).
- Reduced motion: no displacement (skip the follow entirely).
- Light haptic at the cap is optional; if added use the existing `haptics` util.

## Validation gates (coordinator)

1. `npx tsc --noEmit` clean.
2. Diff review against this plan (no scope creep, constants imported not inlined).
3. On-device QA script (docs/redesign/08-transitions-2.html §Implementation) — flagged as
   not verifiable locally; run on next device session.
