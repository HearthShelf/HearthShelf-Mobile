## Context

The tab bar has three presentations (`ClassicTabBar`, `FloatingPillNav`,
`VerticalPillNav` in `src/ui/AppTabBar.tsx`), all driven by one
`onPressTab(name)` callback from `app/(tabs)/_layout.tsx`. `TABS` carries six
entries, `PILL_TABS` four - More is in both. That single callback is where the
More press gets intercepted, so the menu works in every nav mode without
touching the three renderers.

`app/(tabs)/more.tsx` is a settings list: grouped `SettingsRow`s, a search box,
an account header, and an admin-gated Server Admin row. It is a screen worth
keeping - it just should not be what the More *tab* does.

Admin state comes from `useConnection().activeRole`, already used by
`more.tsx:144`. Android back is handled by `useBackHandler` (no-op on iOS,
focus-scoped).

An interactive mockup of the target behaviour lives at
`docs/redesign/more-menu.html`.

## Goals / Non-Goals

**Goals:**
- One tap from anywhere to the app's secondary destinations.
- A popup that reads as unfolding out of the More tab.
- Works identically across all three nav modes.
- Discover gets a single, obvious home.

**Non-Goals:**
- Building QuestGiver, History, Collections or Playlists. This change makes room
  for them.
- Disabled / "coming soon" presentation for unbuilt destinations - spec'd
  separately in a later change.
- Reorganising the settings screen itself.
- Changing what the other five tabs do.

## Decisions

### Intercept at `onPressTab`, don't add a route

`app/(tabs)/more.tsx` could stay a route that renders a transparent modal, but
that means a real navigation - a screen transition, a back-stack entry, and the
previous screen unmounting behind it. The menu is meant to feel like it costs
nothing. Intercepting the press in `_layout.tsx` and rendering the bubble as an
overlay keeps the current screen mounted and leaves the back stack untouched.

Consequence: `more` stays registered as a `Tabs.Screen` (the tab bar iterates
route names), but its component is never reached. Moving the settings list to
`app/settings/index.tsx` and leaving `more.tsx` as a stub redirect keeps the tab
list honest.

### One easing curve, not keyframed stages

The first mockup drove the growth through intermediate keyframes to make width
lead height. CSS/Reanimated both apply easing *between each pair* of stops, so
the curve restarted mid-growth: measured, it raced to 86% of full size in the
first fifth, then crawled 0.037 over the next 40%, then lurched to full. That
stall reads as a stutter.

The growth is therefore a single interpolation from start to rest, with the
settle expressed in the curve itself rather than as a waypoint. In Reanimated
this is one `withSpring` per axis with matching configs.

Trade-off: width can no longer lead height without reintroducing the two-timing
setup. Reanimated can drive two springs cleanly (unlike CSS), so this is
recoverable later if the uniform growth reads flat on device - but it starts
uniform.

### Start scale near zero

Starting at `scale(0.2, 0.14)` put a ~46x55px rectangle on screen before any
motion, which reads as the menu being half-open already. Start scale is
therefore ~0.04, small enough to read as a point at the corner.

### Omit unbuilt entries rather than showing them disabled

The mockup draws all eight entries enabled, which is right for evaluating
layout. Shipping that would mean four rows that do nothing.

Until those screens exist, their entries are omitted. A menu that lists only
what works is honest; a menu of mostly-dead rows teaches people to distrust it.
The alternative - visible-but-disabled, with some "coming soon" affordance - is
a real design question about how the app advertises unfinished features, and is
being spec'd on its own.

Entries are declared as a single ordered list with an `available` predicate, so
adding a screen later is a one-line change and the grouping survives omissions.

### Server Settings is hidden, not disabled

Consistent with `more.tsx`, which already renders the admin group conditionally.
A disabled admin entry advertises an admin surface to people who cannot use it.

## Risks / Trade-offs

- **A near-empty menu.** With four of eight entries omitted, a non-admin sees
  five rows, two of which are Settings. It is still better than today (Discover
  is currently only reachable from a crowded Home header), but the menu will not
  feel complete until the missing screens land.
- **Three nav modes, one overlay.** All three navs sit at the bottom of the
  screen and `VerticalPillNav` hugs the bottom-right corner, so corner-anchored
  growth is right in every mode. What differs is the offset: the bubble clears
  the bar upward in the two horizontal modes, and sits *left* of the rail in the
  vertical one (which reserves `VNAV_WIDTH` along the right edge). One anchor
  rule, three offsets - not three layouts.
- **Losing the Home sparkle button.** Anyone who found Discover there has to
  relearn it. Accepted: two entry points for one screen is the worse outcome.
- **Motion on low-end Android.** The growth is a transform-only animation on the
  UI thread via Reanimated, so it should hold 60fps, but this is unverified on
  real hardware and the mockup's timings are browser-derived approximations.
  Expect to tune the spring config on device.
