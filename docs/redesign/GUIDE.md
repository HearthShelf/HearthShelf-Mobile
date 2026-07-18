# Redesign Mockup Suite — Authoring Guide

Static, annotated phone-frame HTML mockups. One HTML file per surface area,
all linking `hearth.css`. Open locally in a browser. No JS needed (pure CSS).

## File head template (copy exactly)

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HearthShelf Redesign — {PAGE TITLE}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300..800&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Geist+Mono:wght@400..700&display=swap">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200">
<link rel="stylesheet" href="hearth.css">
</head>
<body>
<div class="wrap">
  <div class="masthead">
    <div class="wordmark"><span class="lt">Hearth</span><span class="bd">Shelf</span><span class="sub"> · Mobile Redesign — {PAGE TITLE}</span></div>
    <div class="tagline">{one-line scope of this page}</div>
  </div>
  <div class="pagenav">
    <a href="index.html">Overview</a>
    <a href="01-home.html">Home</a>
    <a href="02-library.html">Library & Search</a>
    <a href="03-player.html">Player</a>
    <a href="04-book.html">Book & Reader</a>
    <a href="05-stats-clubs.html">Stats & Clubs</a>
    <a href="06-settings.html">Settings</a>
    <a href="07-system.html">Sign-in & System</a>
  </div>
  <!-- sections... -->
  <div class="footnav"><a href="{prev}.html">← {Prev}</a><a href="{next}.html">{Next} →</a></div>
</div>
</body>
</html>
```
Mark the current page's pagenav link with `class="on"`.

## Section anatomy (per screen/panel)

```html
<div class="section" id="anchor-name">
  <div class="eyebrow">Screen 04 · Player</div>
  <h2>Sleep timer</h2>
  <p class="sub">One-paragraph statement of what this surface is for and the core redesign idea.</p>

  <div class="audit">
    <div class="crit"><h3>Teardown — what's wrong today</h3><ul>
      <li><b>Preset taps don't arm the timer</b> — tapping "30 m" still requires Start; users walk away thinking it's running.</li>
      ...
    </ul></div>
    <div class="moves"><h3>Redesign moves</h3><ul>
      <li><b>Presets arm instantly</b> — tap "30 m" starts the timer, sheet flips to running mode, toast confirms.</li>
      ...
    </ul></div>
  </div>

  <div class="frames">
    <div class="frameunit">
      <div class="framecap"><div class="t">Sleep sheet — setup <span class="chip">redesigned</span></div>
        <div class="d">Caption explaining the state shown.</div></div>
      <div class="phone"><div class="screen"> ...static mock... 
        <span class="n" style="top:410px; left:330px">1</span>
      </div></div>
      <div class="legend">
        <div class="li"><span class="no">1</span><span class="tx"><b>Preset pill · tap</b> — arms timer immediately, flips sheet to running mode.
          <span class="anim">sheet content cross-fade 180ms · haptic success · toast "Sleeping in 30 min"</span></span></div>
      </div>
    </div>
    ...more frameunits...
  </div>

  <div class="motionspec"><h4>Motion & haptics</h4><table>
    <tr><td>sheet present</td><td>spring slide-up, scrim fade 180ms</td></tr>
    <tr><td>preset arm</td><td>content cross-fade 180ms; countdown numeral counts up from 0 spring</td></tr>
  </table></div>
</div>
```

## Rules

1. **Every interactive element gets a numbered annotation** (`.n` dot on the frame,
   matching `.li` legend row). Legend rows: `<b>Element · gesture</b> — behavior.`
   plus an `<span class="anim">` line with animation + haptic spec when it moves.
2. **Every screen shows its states**: default, and where relevant loading (use
   `.skel` shimmer blocks), empty (icon + one-liner + CTA), error (retry), offline.
   States can be smaller frames (`.screen.short`) or share one frame with callouts.
3. **No features lost.** Everything in the current app appears somewhere in the
   redesign, plus the additions. If a feature moves, the teardown says from where.
4. Sheets can be drawn standalone: `.phone > .screen.short` containing just
   `.scrim` + `.sheetview` (position it `position:relative` in short screens by
   overriding inline: `style="position:relative"`), or full-height screen with
   sheet overlaid — prefer full-height with scrim for realism.
5. Phone content is **static HTML** with inline styles for layout; reuse the
   primitives in hearth.css (.cov .c1-.c8, .chip, .btn, .setrow, .track,
   .tabbar, .mini, .toast, .secthead, .iconbtn, .seg, .toggle).
6. Wordmark rule (brand-critical): "Hearth" gold #bd863f regular + "Shelf" cream
   #f0e6d6 bold, Libre Baskerville, always together, never re-colored. Flame logo
   only referenced as 🔥 placeholder box (`.ic` with local_fire_department icon).
7. Tab bar: 5 tabs Home(home) Library(auto_stories) Now(play_circle) Stats(insights)
   More(menu). The tab owning the current screen is `.on` — including pushed
   detail screens (redesign decision D-NAV).
8. Cover placeholders: `.cov .c1..c8` + `<span class="init">K</span>` +
   `<span class="ct">Title</span>`; sizes via inline style (e.g. `style="width:104px; aspect-ratio:2/3"`).
9. Type floor 11px. Touch targets in mocks ≥44px visual.
10. Keep captions honest: chip `redesigned` for changed surfaces, `new` for added
    ones, `states` for state boards, `kept` where the current design was good.

## Redesign doctrine (applies everywhere — cite IDs in teardowns)

- **D-NAV** — One tab bar, owning tab stays lit on pushed routes. Re-tap active
  tab scrolls to top. Tab labels 11px. "Now" tab remains the flagship player.
- **D-SEARCH** — ONE search surface (was two divergent ones): pushed /search with
  scope chips (Everything · Books · Series · Authors · Narrators) + a
  "Beyond your library" section (Audible), gear for search settings inline.
- **D-PLAY** — Quick-play chip on any in-progress/continue tile (1 tap to audio).
  Tiles show progress bar + finished badge. Long-press anywhere = BookActionsSheet.
- **D-STATES** — Every screen designs loading (skeleton), empty (icon + line +
  CTA), error (retry), offline (cached + chip) states.
- **D-ACTIONS** — One action grammar: the same BookActionsSheet everywhere;
  detail-page overflow carries the full set (share, add-to-list, reset progress,
  hide, recent listens, bookmarks — bookmarks entry always visible).
- **D-FINISH** — Mark-finished is one tap + actionable toast "Finished · Edit date /
  Undo". Date prompt appears only from toast action or bulk flows.
- **D-THUMB** — Frequent controls live in the bottom half. Player: queue + sync
  move from header to the transport zone.
- **D-CONSIST** — One boolean control (toggle), one cover aspect everywhere
  (user setting), segments for enums, chips for presets; reactive theme on every
  surface (sign-in, toasts, splash accents).
