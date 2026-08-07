## 1. Move the settings screen off the More tab

- [x] 1.1 Move `app/(tabs)/more.tsx` to `app/settings/index.tsx`, keeping its
      content unchanged. Swap its tab-root behaviour for pushed-route behaviour:
      it needs a back affordance, and its `goToTab`/`onTabReselect` wiring no
      longer applies.
- [x] 1.2 Reduce `app/(tabs)/more.tsx` to a stub that renders nothing - the tab
      stays registered (the tab bars iterate route names) but its press is
      intercepted before the route is reached.
- [x] 1.3 Repoint every existing `/(tabs)/more` link. Check `app/settings/*`
      back-navigation and any `from=more` params.

## 2. The menu component

- [x] 2.1 Add `src/ui/MoreMenu.tsx`: a scrim plus an anchored bubble, driven by
      an `open` prop and an `onClose` callback.
- [x] 2.2 Declare entries as one ordered list of
      `{ id, label, icon, href, group, available }`, with dividers derived from
      `group` changes so omitted entries can't leave a stray divider.
- [x] 2.3 Set `available` per entry: Discover, Downloads, Settings always;
      Server Settings when `useConnection().activeRole === 'admin'`; QuestGiver,
      History, Collections and Playlists `false` until their screens exist.
- [x] 2.4 Add the five feedback-free glyphs the menu needs to `src/ui/icons.ts`
      if absent (Discover reuses `sparkle`; Downloads reuses `download`).
- [x] 2.5 Style from `theme.ts` tokens - `sheet` ground, `hairline` border,
      `radius.sheet`, `accentWash` for the leading Discover entry. No new
      colour literals.

## 3. Growth animation

- [x] 3.1 Add a bubble spring config to `src/ui/motion.tsx`. Target the mockup's
      feel: ~520ms to rest, ~2% overshoot, settling back. Do not reuse
      `POP_SPRING` (tuned for press feedback, far too tight for this).
- [x] 3.2 Animate `scale` from ~0.04 with `transformOrigin` at the bubble's
      bottom-right corner, as ONE spring per axis - no intermediate waypoints
      (see design.md: waypoints reintroduce the mid-growth stall).
- [x] 3.3 Stagger the entries fading in from the growth corner outward, so the
      last row appears as the box finishes.
- [x] 3.4 Honour reduced motion: no growth, no stagger, everything immediately
      visible and interactive.

## 4. Wire it to the tab bar

- [x] 4.1 In `app/(tabs)/_layout.tsx`, hold the menu's open state and intercept
      `name === 'more'` in `onPressTab` - open the menu instead of navigating.
      Toggle if already open.
- [x] 4.2 Render `<MoreMenu>` in the tabs layout, outside the scene container so
      it overlays every tab and survives tab switches.
- [x] 4.3 Pass an open flag into `AppTabBar` so the More tab renders active
      while the menu is up, and set `accessibilityState={{ expanded }}`.
- [x] 4.4 Anchor per nav mode: above the bar for `classic` and
      `floating-horizontal`; left of the rail for `floating-vertical`, which
      reserves `VNAV_WIDTH` on the right edge.
- [x] 4.5 Dismiss on scrim tap, on entry tap (then navigate), and on Android
      back via `useBackHandler` returning `true` while open.

## 5. Remove the Discover sparkle button

- [x] 5.1 Drop the Discover button from `HomeHeader` in `app/(tabs)/index.tsx`,
      leaving arrange, downloads and search.
- [x] 5.2 Confirm `/discover` is still reachable and that its `from` param
      lights the right tab when opened from the menu.

## 6. Verify

- [x] 6.1 `npx tsc --noEmit` and `npx prettier --check` on changed files.
- [ ] 6.2 On device: open and dismiss the menu in all three nav modes; confirm
      the growth reads as unfolding from the corner with no mid-growth stall,
      and tune the spring if it feels off - the mockup timings are
      browser-derived approximations.
- [ ] 6.3 Confirm the menu overlays every tab, that the screen behind stays
      mounted, and that the back stack is untouched by opening/dismissing.
- [ ] 6.4 Check both roles: Server Settings present for an admin, absent for a
      non-admin, and correct after switching servers without a restart.
- [ ] 6.5 Check reduced motion, and both light and dark themes.
