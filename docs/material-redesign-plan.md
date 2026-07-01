# HearthShelf Mobile — "Material, warmed" redesign plan

Source of truth: `C:\code\HearthShelf-DesignSystem\hearthshelf-mobile\project\HearthShelf Android - Material.dc.html`
(the handoff prototype the user had open), backed by the design system tokens in
`_ds/.../colors_and_type.css` and the README brand/voice guide.

**Scope guidance from the user:** the **Home**, **Library**, and **bottom nav** are considered
settled — build them to match. The **Now Playing** screen in the prototype is a work in progress;
treat it as directional, not final, and flag decisions rather than hard-coding its details.

This plan is organized as: (1) foundations, (2) screen-by-screen, each screen with a **validation
pass** (what "done" looks like + how to check it). It maps every prototype state to a real file in
this repo so nothing is described in the abstract.

---

## 0. Foundations (do these first — every screen depends on them)

The prototype is a self-contained HTML mock driving all state from one React `Component`. Our app is
Expo Router + a small `@/ui` primitive set. The gap is mostly **visual density and missing screens**,
not architecture. Ground truth today:

| Concern | Prototype | This repo today |
| --- | --- | --- |
| Tokens | `colors_and_type.css` (shadcn `.dark`) | [src/ui/theme.ts](src/ui/theme.ts) — already ported from the same dark palette |
| Nav | 5 tabs (Home, Library, Now Playing, Stats, More) | 3 tabs (Home, Library, More) — [app/(tabs)/_layout.tsx](app/(tabs)/_layout.tsx) |
| Covers | typeset duotone from a single hue `cv` | real ABS artwork via `coverUrl()` |
| Cover-glow | radial bloom from now-playing hue | not implemented |
| Primitives | inline styles | `@/ui/primitives`, `@/ui/BookTile`, `@/ui/AzRail` |

### 0.1 Token reconciliation
- `theme.ts` already matches the `.dark` block (`#1b1a18` scaffold, `#e0654a` accent, `#bd863f`
  hearth gold, `#f0e6d6` shelf cream). **Verify** each value against
  `colors_and_type.css` `.dark` and fix drift. Notably add the surfaces the prototype leans on:
  `--card #2a2825` (have `high`), `--popover #242220` (have `base`/`sheet` — reconcile naming),
  `--elevated #322f2b` (have `highest`), `--muted-foreground #aba498` (have `textMuted`).
- Add a **glow** helper: a radial-gradient bloom of a book's hue. RN has no `radial-gradient`, so
  use `expo-linear-gradient` layered, or a pre-blurred `RadialGlow` view. Decision needed (see 0.4).
- Type (§0.4 #4, locked): ship **Inter** (UI/`--font-sans`), **Geist Mono** (numerals/time/`--font-mono`),
  and **Libre Baskerville** (wordmark, eyebrows, editorial italic/`--font-brand`) as app fonts via
  `expo-font`. Extend `theme.ts` `type` roles to carry `fontFamily`: body/label/meta → Inter; a
  `mono`/numeric role → Geist Mono; wordmark + `eyebrow` + editorial-quote → Libre Baskerville. LB must
  **not** be the default body face.

### 0.2 The typeset cover fallback
Central motif. When artwork is missing, the prototype renders a duotone tile from one hue with a
faint oversized initial + kicker/title. Our `BookTile`/`Cover` use real artwork. **Build** a
`TypesetCover` fallback (hue → `linear-gradient(155deg, mix(cv,#000), mix(cv,#07060a))` + initial)
that `Cover` falls back to on missing/failed artwork. The book's hue also feeds the glow.

- **Resolved (§0.4 #1):** real artwork is primary; the typeset duotone is a fallback only. The book's
  hue (from artwork or the fallback) still drives the glow, so the "warm" look survives via glow +
  surfaces + type, not by typesetting every cover.

### 0.3 Cover-glow system
A `heroGlow`/`playerGlow`/`detailGlow` radial bloom tinted by the active book's hue appears on Home
hero, Detail, Player, and behind the mini-player. Build one `<CoverGlow hue={} strength={} mode={} />`
component; reuse everywhere. `--glow-strength` is 60 (dark). Per §0.4 #3, `mode` is `'gradient'`
(default, layered `expo-linear-gradient`) or `'image'` (pre-blurred PNG), driven by a stored appearance
preference — so build both renderers behind the one component.

### 0.4 Decisions — all confirmed (locked)

1. **Covers: real artwork primary.** Use real ABS artwork everywhere; the typeset duotone (§0.2) is a
   **fallback only** (missing/failed artwork). Its hue still feeds the glow. The "warm" look comes from
   surfaces + glow + type, not from typesetting every cover.
2. **5 tabs.** Home · Library · Now Playing · Stats · More. (Now Playing = center of gravity; Stats
   backed by real listening-stats — §6.4/§6.5.)
3. **Glow: both, as an appearance option.** Ship layered `expo-linear-gradient` glow **and** a
   pre-blurred PNG variant, selectable in appearance settings (a quality/perf toggle). Gradient is the
   default; PNG is the lighter-weight option. `<CoverGlow>` takes a `mode` prop; the choice is a stored
   preference read alongside theme (see §7 My settings).
4. **Fonts: ship Libre Baskerville + Geist Mono, keep design-system roles.** LB is used where the DS
   uses it — wordmark, tracked uppercase eyebrows, and editorial/pull-quote italic (book blurbs) — **not**
   as the UI body face. UI text stays **Inter** (`--font-sans`); numerals/time/durations stay **Geist
   Mono** (`--font-mono`). Load all three as app fonts (expo-font); update `theme.ts` `type` to carry
   `fontFamily` per role. Do not let LB leak into dense UI copy — that contradicts the DS ("the UI
   itself stays in Geist").
5. **More: build what exists, stub the rest (first pass).** Build now (real data/logic already here):
   the More hub, My settings (theme + glow-mode toggle; playback rows; sign out), Server settings
   (existing switch logic), About (static). **Stub** (visible "coming soon", no dead links) anything
   needing endpoints we don't have yet: Collections, Playlists, Listening history, admin Server stats.
   Stats tab itself is **not** a stub — it's backed by §6.4.

---

## 1. Bottom navigation + persistent chrome  *(settled — match the prototype)*

**Prototype:** `showNav` bar with 5 pill tabs; active tab gets an ember-wash pill behind a filled
icon + ember label. Above it: **mini-player** (`showMini`) with cover, title, current chapter, a
play/pause, and a 2px progress hairline. A **FAB** exists in code but is disabled (`showFab:false`).

**This repo:** [app/(tabs)/_layout.tsx](app/(tabs)/_layout.tsx) custom `TabBar` + `MiniPlayer`
already docks above the bar. 3 tabs, no active-pill treatment, no filled-icon swap.

**Build:**
- Add **Now Playing** tab (route `now`) and **Stats** tab (route `stats`). Order:
  Home · Library · Now Playing · Stats · More.
- Active state: ember-wash rounded pill (`60×30`, `radius 999`, bg `accent @ 22%`) behind a **filled**
  Material icon, ember label; inactive = outlined icon + `textMuted`. Our `Icon` set must expose a
  filled variant per glyph (`home`/`auto_stories`/`play_circle`/`insights`/`more_horiz`).
- Mini-player: match prototype — `popover` bg, hairline border, hue glow at 35% behind it, 44px cover,
  title + `chapterShort`, play/pause, bottom progress hairline. Tapping opens the player; the
  play/pause `stopPropagation`s.

**Validation pass — Nav:**
- [ ] 5 (or 4) tabs render; active tab shows filled icon + ember pill + ember label; others muted.
- [ ] Switching tabs clears any pushed stack (matches `setTab` → `stack:[]`).
- [ ] Mini-player hidden when the full player is open and when the Now-Playing tab is active
      (`showMini: view!=='player' && !(onTab && tab==='now')`).
- [ ] Mini-player progress hairline tracks position; play/pause toggles without navigating.
- [ ] Safe-area bottom inset respected (already handled); nav sits above gesture pill.

---

## 2. Sign in

**Prototype (`isSignin`):** centered flame mark (88px rounded tile, hearth-gold glow), `HearthShelf`
wordmark (Libre Baskerville, gold "Hearth" + cream "Shelf"), a calm subtitle, a white **Continue with
Google** button (Google "G" svg), a bordered **Sign in with email**, and a Terms line.

**This repo:** [app/sign-in.tsx](app/sign-in.tsx) exists (Clerk). Verify it visually against the mock.

**Build:** Reskin sign-in to the mock: flame tile + wordmark + subtitle stack, white Google button,
bordered secondary. Keep the real Clerk `startSSOFlow`/native Google logic — this is a **visual** pass.

**Validation pass — Sign in:**
- [ ] Flame mark + wordmark render with correct gold/cream and glow.
- [ ] Google button is white with the multi-color G; email button is bordered/ghost.
- [ ] Real Clerk sign-in still works (native Google + email). This is the known non-locally-verifiable
      boundary — test on a device build, don't claim it works from a screenshot.
- [ ] Terms line present, muted, centered.

---

## 3. Home  *(settled — match the prototype)*

**Prototype (`isHome`):** the richest screen. Top-to-bottom:
1. **Spotlight hero** (~300px): the now-playing book's hue fills the top as a duotone with a giant
   faint initial and a gradient fade into the page; overlaid: eyebrow greeting ("Good evening,
   Jordan"), "Continue · {kicker}", big title, author · chapter, a thin progress bar + `%`, and a
   filled **Resume** button tinted by the hue.
2. **Stats strip:** two cards — day streak (flame) + this week (clock), mono numerals.
3. **Horizontal shelves**, each a header (title + chevron) over a horizontally-scrolling row of
   112px 2:3 tiles: **Continue** (with per-tile progress hairline), **Recently added**, **Discover**,
   **Listen again** (finished, gold check badge), **Downloads** (download icon in header).

**This repo:** [app/(tabs)/index.tsx](app/(tabs)/index.tsx) has a *calm* hero (small cover row) + a
`Shelf` FlatList per ABS personalized shelf. Data plumbing (in-progress, personalized shelves) is
already here and real. The gap is purely the **hero spotlight**, **stats strip**, and **tile styling
+ progress**.

**Build:**
- **Hero:** replace `CalmHero` with a `SpotlightHero` driven by `inProgress[0]`: hue-tinted backdrop
  (from artwork-derived color or a fallback hue), giant initial, greeting eyebrow, kicker/title/
  author/chapter, progress bar + `%`, hue-tinted Resume. Tapping the hero opens the player; Resume
  plays. Greeting is time-derived ("Good evening, {name}") — needs the user's name (Clerk) + clock.
- **Stats strip:** two cards, matching the prototype exactly — **Day streak** (flame) + **This week**
  (clock) — both **real** from `/api/me/listening-stats` (see §6.5). Day streak = the backward-walk
  computation from `byDay`; this-week = sum of the last 7 `byDay` values. The prototype's literal
  values ("23", "9h 14m") are placeholders, but the *fields* are real, so ship the real numbers.
  Tapping the strip opens the Stats tab. Home and Stats must share one `dayKey` + streak helper.
- **Shelves:** keep the real personalized shelves; restyle tiles to the 112px duotone treatment with
  progress hairline (Continue) and finished check badge (Listen again). Map ABS shelf labels →
  prototype sections where they line up ("Continue listening" → Continue, "Recently added" → Recent).

**Validation pass — Home:**
- [ ] Hero shows the in-progress book with correct hue backdrop, initial, progress %, and Resume tint.
- [ ] Empty state: no in-progress book → hero hidden or a "Nothing playing" calm state (prototype
      always has one; ours must handle the empty server gracefully).
- [ ] Each shelf scrolls horizontally; tiles are 112px 2:3; Continue tiles show a progress hairline;
      Listen-again tiles show the gold check.
- [ ] Tapping a tile → item detail; tapping hero → player; Resume → playback starts.
- [ ] Greeting reflects time of day + real user name.
- [ ] Server name still reachable (prototype folds it away; ours shows it in the top bar — decide
      whether to keep or move to a header eyebrow).
- [ ] Real data: connect flow, in-progress, and personalized shelves still load (logic already exists —
      regression-check after restyle).

---

## 4. Library  *(settled — match the prototype)*

**Prototype (`isLibrary`):** a single rich screen (not our two-level Libraries→Browse):
- Title "Library", pill **search bar** (live filter), a **view selector** (Books · Series · Narrators
  · Authors).
- **Books view:** quick-filter chips (All · In progress · Finished · Downloaded), a controls row
  (count + a quick sort chip + a `tune` button opening the **View options** sheet), then either a
  **grid** (3 or 4 cols by size) or a **list**. An **A–Z rail** appears when sorted by name.
- **Series/Narrators/Authors view:** grouped rows with a 3-cover stack, name, and "N books · Xh",
  tapping into a **Group drilldown** (`isGroup`).
- **Search results** override the browse body: 50px thumb rows with a play button, or a "No matches"
  empty state.
- **View options sheet** (`sheetView`): tabbed Display / Sort / Filter (layout list/grid, cover size
  comfortable/compact, sort name/added/author/duration, filter chips).

**This repo:** split across [app/(tabs)/library.tsx](app/(tabs)/library.tsx) (list of libraries) →
[app/library/[id].tsx](app/library/[id].tsx) (paginated 3-col grid + `AzRail`, already built) and a
separate [app/search.tsx](app/search.tsx). We already have `BookTile`, `AzRail`, pagination, and
`scrollToIndex` letter jump — good bones.

**Build (largest screen — stage it):**
1. **Merge** the library-picker and browse into one screen when there's a single book library
   (common case). Keep a library switcher for multi-library servers (chip or header control).
2. **Search bar** inline (port `app/search.tsx` logic into the header; keep the route for deep-link).
3. **View selector** (Books/Series/Narrators/Authors). Books maps to the existing grid. Series uses
   ABS series endpoints; Narrators/Authors use ABS authors endpoints. **Data gap:** confirm ABS
   endpoints for series/narrator/author grouping exist in `@/api/abs` (Series likely; Narrators may
   need derivation). Stub views that lack endpoints.
4. **Quick-filter chips** + **sort** + **View options sheet**. Grid/list toggle + comfortable/compact
   (3 vs 4 cols — we already compute tile width from `COLS`; parameterize it).
5. **A–Z rail** already exists — gate it to name-sort + Books view like the prototype.
6. **Group drilldown** (`isGroup`) — a 2-col grid of a series/author/narrator's titles with a back
   header. New route (e.g. `app/group/[type]/[name].tsx`).

**Validation pass — Library:**
- [ ] Search filters live; clear button works; "No matches for X" empty state shows.
- [ ] View selector switches Books/Series/Narrators/Authors; each shows real grouped data or an
      explicit stub (never a silent empty grid).
- [ ] Filter chips (All/In progress/Finished/Downloaded) filter the grid; count updates.
- [ ] Sort chip + View sheet change order; A–Z rail appears only on name-sort Books, and letter jump
      scrolls correctly (existing `onScrollToIndexFailed` path holds).
- [ ] Grid ↔ list toggle and comfortable ↔ compact (3↔4 cols) both re-layout without clipping.
- [ ] Pagination still loads on scroll (existing `onEndReached`); large libraries don't jank.
- [ ] Group drilldown opens from a group row, shows that group's books, back returns to the group list.

---

## 5. Item / Book detail

**Prototype (`isDetail`):** hue glow header; back + share/bookmark/more; centered typeset cover;
title, author · star rating, a "readers" avatar stack; optional **series link** card; a progress /
finished / not-started status card; primary CTA (Resume/Start/Listen again) + playlist-add + download;
a 4-button secondary row (Finished/Share/Bookmarks/Details); **Chapters** preview (4 rows) → "View all"
opening the chapters sheet; a length/chapters/published stat strip; an editorial italic **About**
blurb + narrator.

**This repo:** [app/item/[id].tsx](app/item/[id].tsx) exists — verify current contents and gaps.

**Build:** Reskin/extend the item screen to the mock. Real data from ABS (title/author/duration/
chapters/progress). **Data gaps / decisions:** ratings and "readers" avatars aren't standard ABS —
stub or hide (recommend hide ratings unless the server provides them; drop the social "readers" stack
for v1). Series link uses the same grouping as Library. Bookmarks/playlist-add need ABS endpoints
(stub buttons that no-op with a toast, or hide).

**Validation pass — Detail:**
- [ ] Cover, title, author, duration, chapter count, published year all reflect real ABS data.
- [ ] Status card is correct for each case: not-started / in-progress (% + chapters left + remaining) /
      finished, matching `detailInProgress|Finished|NotStarted` logic.
- [ ] CTA label switches Start/Resume/Listen again and starts playback at the right position.
- [ ] Chapters preview shows first 4; "View all" opens the chapters sheet with the full list; seeking
      from a chapter starts/loads playback at that timestamp.
- [ ] Series link (when present) opens the series group; absent when the book has no series.
- [ ] Stubbed/hidden affordances (ratings, readers, bookmarks) are intentionally hidden — no dead UI.
- [ ] Glow header uses the book's hue.

---

## 6. Now Playing  *(WIP — directional, confirm before finalizing)*

The user flagged this as a work in progress. The prototype actually has **two** now-playing surfaces:

- **`isNowPlaying`** (docked tab): "Now playing" header, a **208px** cover you can **swipe up** to
  expand, title/author/chapter, a **draggable scrubber** with thumb + pos/remaining, and a compact
  3-button transport (replay30 / play / forward30).
- **`isPlayer`** (full route, `mxRise` in): `expand_more` to dismiss, **248px** cover, chapter pill
  opening the chapters sheet, a bigger scrubber, a **5-button** transport (prev-chapter / replay30 /
  play / forward30 / next-chapter), and a bottom row of **speed / sleep / chapters** pills. Player
  glow tinted by hue.

**This repo:** [app/player.tsx](app/player.tsx) is already close to `isPlayer`: cover, scrubber
(PanResponder), 5-button transport (chapter skips shown only when chapters exist), and a toolbar
(Chapters/Speed/Sleep/Car). It also has a **swipe-up "car mode"** the prototype lacks, and reuses
`ChaptersSheet`/`SpeedSheet`/`SleepSheet`. The mini-player + store are real.

**Because this is WIP, the plan is to reconcile, not blindly rebuild:**
- **Confirm the two-surface model.** Do we want the docked `isNowPlaying` **tab** (208px + swipe-to-
  expand) *and* the full `isPlayer` route, or just the full player reached from the mini-bar? Our app
  currently only has the full route + car mode. Recommend: keep the full player route as the primary;
  add a Now-Playing **tab** only if 0.4 #2 keeps it (it can render the same player component).
- **Scrubber: DONE.** Ported the WebApp's shipped `Scrubber.tsx` + design-system variant **2f** (the
  final Hearth Pill) into [src/player/Scrubber.tsx](../src/player/Scrubber.tsx): a Gesture-pan bar that
  drags with a local ratio, seeks **once on release** (so crossing a chapter boundary doesn't reload
  audio mid-drag), taps-to-seek, and fires an `onDrag` preview so labels track the pointer without
  committing. Visual: 30px pill, gold→ember `expo-linear-gradient` fill, interior elapsed/chapter/remain
  chips, full-height cream leading line (thickens while dragging), shimmer while playing. Wired into
  [app/player.tsx](../app/player.tsx) (replaced the old PanResponder track; labels follow the drag
  preview). Source: `HearthShelf-DesignSystem` commit `5ccdc71`. **Follow-up:** reuse the same
  component in the MiniPlayer (thin, knob-hidden) and Now-Playing tab; label chips pick up Geist Mono
  once fonts land (§0.4 #4).
- **Speed:** prototype cycles `[0.8,1,1.2,1.4,1.6,2.0]`; ours has a SpeedSheet. Keep the sheet (richer).
- **Sleep:** prototype's SleepSheet is far richer (Duration/Chapter/Time modes, "when it stops"
  toggles: rewind/keep-within-chapter/fade). Ours has a `SleepSheet` — compare and decide how much of
  the richer model to adopt (this is a good incremental follow-up, not v1-blocking).
- **Car mode:** ours has it; the prototype doesn't. Keep it (truck-verified per repo notes) — it's a
  HearthShelf differentiator, don't drop it to match the mock.
- **Glow:** add the hue-tinted `playerGlow` behind the player (currently absent).

**Validation pass — Now Playing (hold to a lighter bar since it's WIP):**
- [ ] Full player: cover, title, author, current chapter pill, scrubber with thumb, pos/remaining,
      5-button transport, speed/sleep/chapters pills all render and are wired to the store.
- [ ] Scrubbing seeks and does not fight the position clock (no jump-back while dragging).
- [ ] Chapter pill + Chapters toolbar both open the chapters sheet; seeking works.
- [ ] Speed sheet changes rate and the label reflects it; sleep sheet arms a timer and the label
      reflects remaining/EOC.
- [ ] Car mode still enters on swipe-up and exits on swipe-down (regression guard).
- [ ] Player glow uses the now-playing hue.
- [ ] **Explicitly deferred / to confirm:** docked Now-Playing tab, richer sleep model, thumb polish.
      Don't mark these done — mark them decided.

---

## 6.4 Computed stats belong on the HS server + in core  *(architecture — do before §6.5)*

**Decision:** anything that requires *compute* on top of raw ABS stats (day streak, this-week total,
active days, heatmap buckets, most-listened sort) should be computed **once, server-side, in the HS
self-hosted server**, exposed as a typed endpoint, so every surface — this app, the web app, absorb,
home-screen widgets — reads the same pre-computed values instead of each reimplementing the walk (and
drifting). The shared **response shape lives in `@hearthshelf/core`** so all TS clients consume one
contract.

This fits the existing server architecture exactly — no new infrastructure:

- **Server:** [HearthShelf/server](../../HearthShelf/server) is a thin dispatcher
  ([index.js](../../HearthShelf/server/index.js)) that calls `resolveContext(req)` → `ctx {serverId,
  userId, absUrl, absToken}` and hands off to per-user `/hs/*` handlers. The precedent to copy is
  [routes/finished-books.js](../../HearthShelf/server/routes/finished-books.js) +
  [lib/finishedBooks.js](../../HearthShelf/server/lib/finishedBooks.js): a `/hs/*` route that proxies
  ABS with the caller's `absToken` and computes on top. `/hs/social/*` already does cross-user
  leaderboards + per-book finished counts (relevant to the prototype's admin "Server stats").
- **New endpoint:** `GET /hs/stats` (per-user, no admin gate — the caller's own listening history,
  same posture as finished-books). It fetches ABS `/api/me/listening-stats` server-side and returns
  **computed** fields alongside the raw series.

**Proposed `HSListeningStats` (add to [HearthShelf-Core/src/types/abs.ts](../../HearthShelf-Core/src/types/abs.ts),
export via `src/index.ts`):**

```ts
// HearthShelf backend, GET /hs/stats. Computed server-side from ABS
// /api/me/listening-stats so every client shows identical numbers.
export interface HSListeningStats {
  totalTimeSec: number          // raw totalTime
  todaySec: number              // raw today
  weekSec: number               // computed: sum of last 7 local days
  dayStreak: number             // computed: consecutive days >0, today-not-yet-listened offset
  activeDays: number            // computed: byDay keys with >0
  byDay: Record<string, number> // raw days map (client draws week bars + heatmap)
  mostListened: Array<{ id: string; title: string; author: string; narrator: string; timeSec: number }>
}
```

Core already types the **raw** ABS response as `ABSListeningStats` (`totalTime`, `today`, `days`,
`items`) and already has HS-backend types like `HSLeaderboardEntry` — so `HSListeningStats` sits right
next to both.

**Put the pure compute in core, not just the server**, so the server route and any client that still
reads raw ABS can share it (single source of truth for the streak rule): add
`src/lib/stats.ts` (pure, no Node/DOM — matches core's constraint) exporting e.g.
`computeStreak(byDay, today)`, `weekSeconds(byDay, today)`, `dayKey(date)`. The server imports these to
build the `/hs/stats` response; core `export *`s them. The **streak rule** is the absorb algorithm
(§6.5): backward walk from today, offset to yesterday when today is still zero, cap 365 — encode it
once here.

**Migration / fallback (pre-release, but be explicit):** the mobile client should prefer `/hs/stats`
and fall back to computing from raw ABS `/api/me/listening-stats` (via the same core helpers) when the
server is older than this endpoint — so the app still works against a HS server that hasn't shipped
`/hs/stats` yet. `getRuntime`/version gating already exists server-side; the client can also just try
`/hs/stats` and fall back on 404.

**Cross-repo checklist for this slice — DONE:**
- [x] `HearthShelf-Core` (`packages/core` submodule + sibling repo, kept in sync): added
      `HSListeningStats`/`HSStatsItem` to `src/types/abs.ts` and pure `src/lib/stats.ts`
      (`dayKey`/`weekSeconds`/`computeStreak`/`activeDays`/`mostListened`/`computeListeningStats`),
      exported via `index.ts`. Verified: today-not-yet-listened offset, a gap correctly stops the
      streak, week sum, most-listened sort — all confirmed with a scripted check against a known
      `days` map (see commit `a4cea6a`).
- [x] `HearthShelf/server`: added `routes/stats.js` (`GET /hs/stats?tz=<offsetMinutes>`, per-user, no
      admin gate) + `lib/stats.js` (JS mirror of the core compute — the server is standalone ESM and
      doesn't bundle `@hearthshelf/core`, so keep the two in sync by hand). Registered `handleStats` in
      `index.js`. `tz` reconstructs the caller's local day boundaries since the server can't know the
      caller's timezone.
- [x] `HearthShelf-Mobile`: `getHSStats()` in `src/api/abs.ts` — hits `${serverUrl}/hs/stats?tz=...`
      with the ABS bearer token (same origin that already serves `/hs/hosted/connect`), falls back to
      raw ABS `/api/me/listening-stats` + the core compute on a 404 (older server).
- [ ] `HearthShelf-WebApp` / absorb: not yet adopted; they keep working via their current raw reads
      until migrated (that's the whole point of centralizing — no coupled rollout required).

---

## 6.5 Stats  *(promoted to a real tab — listening-stats data exists)*

**Prototype (`isStats`):** "Your listening / This year, so far"; two big stat cards (day streak /
hours listened); a **This week** bar chart (7 bars + a total); a **Finished this month** list with a
gold `verified` badge per book. The prototype's numbers are mock (invented streak, hardcoded 272h).

**Real data — consumed from `/hs/stats` (§6.4), which computes on top of the ABS
`GET /api/me/listening-stats` the web app already proves out.** The client reads the typed
`HSListeningStats` (computed server-side) and only *draws* — no client-side streak/week math except in
the fallback path. Reference for the raw shapes + week/heatmap drawing:
[HearthShelf-WebApp/src/api/absStats.ts](../../HearthShelf-WebApp/src/api/absStats.ts) and
[StatsPage.tsx](../../HearthShelf-WebApp/src/pages/StatsPage.tsx):

| Field (raw → typed) | What it drives |
| --- | --- |
| `totalTime` → `totalTimeSec` | Hero "Total listening time" (Hh Mm) |
| `today` → `todaySec` | "Today" tile (minutes) |
| `days` → `byDay` (`YYYY-MM-DD` → seconds) | **Day streak** (see below), **This week** 7-bar chart (last 7 local days), **Active days** (keys with >0), and a **26-week heatmap** |
| `items` → per-item `timeListeningSec` | **Most listened to** list (cover + title/author + hours, sorted desc) |

**Day streak is real and computable** from the `days` map — computed server-side in `/hs/stats` (§6.4),
with the pure rule living in core's `computeStreak`. Proven algorithm from the sibling Flutter client
[C:\code\absorb](../../absorb/lib/services/home_widget_service.dart) (`_currentStreak`): walk backwards
day-by-day from today counting consecutive days with >0 seconds; if *today* has no listening yet, start
from yesterday (offset 1) so an in-progress day doesn't reset the streak. Cap the walk at 365. Use a
local-time `YYYY-MM-DD` key that matches ABS's `days` keys (the shared core `dayKey`, used by streak +
week + heatmap alike). Note absorb also reads a `dayListeningMap` key as a fallback before `days`, and
its per-day value may be a number or a `{ timeListening }` object — handle both in the extractor.

**Local-time caveat:** the streak/week are computed in the *caller's* local time, but `/hs/stats` runs
on the server. Pass the client's timezone/day-offset to the endpoint (query param), or compute
day-boundary keys client-side and let the server bucket accordingly — otherwise a server in a different
TZ mis-buckets "today". Decide when building §6.4.

**Build:** New `app/(tabs)/stats.tsx`. Add `getHSStats()` to `@/api/abs.ts` hitting `/hs/stats` and
returning `HSListeningStats` (§6.4). Streak/week/active-days arrive **pre-computed**; the client draws
the week bars + 26-week heatmap from `byDay` using core's `dayKey` (so keys line up), and renders
`mostListened` directly. Fallback (older server): read raw ABS `/api/me/listening-stats` and compute
via the same core helpers. Map the prototype's visual sections onto the data:
- Prototype "day streak" → **real** consecutive-day streak computed from `byDay` (see the algorithm
  above, ported from absorb's `_currentStreak`). This is the primary hero-adjacent stat, matching the
  prototype's flame + "Day streak" card. Not a stub.
- Prototype "hours listened" → real `totalTimeSec`.
- "This week" bars → real last-7-day series (bar height ∝ that day's hours; highlight the busiest).
- "Finished this month" → the web app doesn't render this from stats; **use** the "Most listened to"
  per-item list instead (real), or derive finished-count if we already track finished items. Prefer
  Most-listened (directly available) for v1.

**Built:** `app/(tabs)/stats.tsx` — hero total (`formatDuration(totalTimeSec)`), day-streak + total-time
stat cards, a 7-bar this-week chart (from `byDay`, busiest day reads brightest via opacity), and a
most-listened list (covers via `coverHue`/`TypesetCover` fallback). Calm empty state when
`totalTimeSec === 0`; error state with Retry. `app/(tabs)/index.tsx` grew a `HomeStatsStrip` (day
streak + this week, tapping through to the Stats tab) that calls the same `getHSStats()` — loaded
best-effort alongside the connect flow so a stats hiccup never blocks the rest of Home.

**Validation pass — Stats:**
- [x] Hero total = real `totalTimeSec` via `formatDuration`; day-streak + this-week cards are real
      (`dayStreak`, `weekSec`), not hardcoded — no invented "23".
- [x] This-week chart shows the last 7 local days from `byDay` (`dayKey`-aligned), bar height + opacity
      scale with hours.
- [x] **Day streak** computed server-side via the backward-walk algorithm (today-not-yet-listened
      offset); verified with a scripted check against a known `days` map (see §6.4 commit `a4cea6a`).
- [x] Most-listened list shows real per-item time sorted desc, with title/author + typeset-fallback cover.
- [x] Empty state (new user, `totalTimeSec === 0`) renders calmly; error state offers Retry.
- [x] Numerals in mono (`AppText variant="mono"` / `fonts.mono`).
- [x] Home stats strip and the Stats tab call the identical `getHSStats()` — no divergent computation.
- [ ] **Not yet verified on-device**: visual spacing/contrast, bar-chart proportions at real data volumes,
      and the tap-through from Home strip to the Stats tab. Typecheck + Metro bundle pass; UI feel needs
      a real build per the verification-boundary memory.

---

## 7. More (hub) + sub-screens

**Prototype (`isMore`):** a hub: a profile card (avatar initial, name, email → My settings), then
grouped rows — **Shelves** (Collections, Playlists), **Insights** (Listening history, Server stats
[Admin badge]), **Account** (My settings, Server settings, About). Each pushes a sub-screen:

- **My settings (`isSettings`):** profile card; Playback rows (speed, skip back/forward, default sleep);
  Appearance theme segmented (Dark/Light/Auto); Sign out (destructive).
- **Server settings (`isServers`):** list of linked servers with active check + "Link another server".
- **About (`isAbout`):** flame mark, wordmark, version/build, rows (What's new/Acknowledgements/
  Privacy/Terms), copyright.
- **Collections (`isCollections`):** 2-col cards with 3-cover stacks.
- **Playlists (`isPlaylists`):** rows with icon + name + "N titles · Xh" + "New playlist".
- **Listening history (`isHistory`):** thumb rows with author · % + relative time.
- **Server stats (`isServerStats`, Admin):** 4 stat tiles + a top-listeners leaderboard.

**This repo:** [app/(tabs)/more.tsx](app/(tabs)/more.tsx) is minimal: Switch server, Sign out, version.
No profile card, no My settings screen, no theme toggle, no sub-screens.

**Build (§0.4 #5 — build what exists, stub the rest this pass):**
- **Now:** restyle More into the hub with the profile card + grouped rows. Build **My settings**:
  playback rows; **Appearance** with a **theme** segmented control (Dark works; Light/Auto are honest
  stubs — `theme.ts` ships dark-only today) **and a Glow style toggle** (Gradient / Image, per §0.4 #3,
  stored and read by `<CoverGlow>`); Sign out. Build **Server settings** (existing switch logic →
  linked-server list) and **About** (static).
- **Stub (visible "coming soon", never a dead link):** Collections, Playlists, Listening history, admin
  Server stats — all need endpoints we don't have yet.

**Validation pass — More:**
- [ ] Hub shows profile card (real name/email from Clerk) → My settings.
- [ ] My settings: playback rows reflect real store values; theme toggle works (Dark) with Light/Auto
      honestly disabled/noted; **Glow style toggle** switches `<CoverGlow>` between gradient and image
      and the choice persists; Sign out works (existing logic).
- [ ] Server settings lists linked servers, marks the active one, and switching works (regression of
      existing `switchServer`).
- [ ] About shows real version/build from `expo-constants`.
- [ ] Any not-yet-built row is visibly "coming soon", not a broken link.

---

## 8. Bottom sheets (shared)

**Prototype (`isSheet`):** one sheet host with a grab handle, title, Done; three contents:
- **View options** (Library) — covered in §4.
- **Chapters** — list with the current chapter marked (`graphic_eq` filled, ember), tap to seek.
- **Sleep timer** — Duration / Chapter / Time modes + "when it stops" toggles.

**This repo:** [src/player/sheets.tsx](src/player/sheets.tsx) already exports `ChaptersSheet`,
`SpeedSheet`, `SleepSheet` with a `SheetHandle`. Reuse this host; add a **View options** sheet for
Library, and reconcile the Sleep sheet against the richer prototype model (§6).

**Validation pass — Sheets:**
- [ ] Sheet animates up, scrim dims, Done/back-tap closes, grab handle present.
- [ ] Chapters: current chapter highlighted; tapping seeks (and loads the book if opened from detail).
- [ ] View options: Display/Sort/Filter tabs drive the library grid live.
- [ ] Sleep: chosen mode arms a real timer reflected in the player + mini labels.

---

## 9. Cross-cutting validation (run after each screen and at the end)

- [ ] **Theme parity:** every color used resolves to a `theme.ts` token that matches
      `colors_and_type.css` `.dark`. No stray hex.
- [ ] **Typography:** all three app fonts load (Inter, Geist Mono, Libre Baskerville). UI body/titles
      in Inter; numerals/time/durations in Geist Mono; wordmark + tracked-uppercase eyebrows + editorial
      blurb in Libre Baskerville. LB never appears in dense UI copy (§0.4 #4).
- [ ] **Icons:** Material Symbols Rounded only, filled variant for active/now-playing. No emoji.
- [ ] **Motion:** short entrance fades; sheets slide; no infinite decorative loops; reduced-motion safe.
- [ ] **Glow:** hero/detail/player/mini all tint by the active/relevant book hue.
- [ ] **Empty & error states:** every list has a calm empty state and surfaces real errors (the app
      already does this on Home/Library — keep it through the restyle).
- [ ] **Real-server regression:** connect → shelves → detail → play → scrub → sleep → sign out all
      still work against a live ABS server. Per the verification-boundary memory, auth/native/release
      paths can't be confirmed locally — test those on a device build and flag rather than claim.
- [ ] **Car mode preserved** (truck-verified) — not regressed by the player restyle.

---

## 10. Suggested build order (each is independently shippable)

1. Foundations **(DONE)**: token reconcile + DS aliases, app fonts (Inter/Geist Mono/Libre Baskerville
   via expo-font), `TypesetCover` fallback folded into `Cover`, `CoverGlow` (gradient mode), filled-icon
   layer (`iconFor`), 5-tab nav with ember pill + Now Playing/Stats placeholder screens (§0, §1).
   Fidelity notes carried forward: Material Symbols variable font is a later upgrade (MaterialIcons for
   now); `CoverGlow` image mode + the appearance toggle land with My settings; variable fonts load as
   single instances (synthetic bold).
2. **Cross-repo stats slice (§6.4) — DONE.** Core `HSListeningStats` + `lib/stats.ts`; server
   `/hs/stats`; mobile `getHSStats()` with raw-ABS fallback. Unblocks both Home strip and Stats tab;
   web app + absorb can adopt the same endpoint later.
3. Stats tab **(DONE)** (§6.5): hero total, day-streak + total-time cards, this-week bar chart,
   most-listened list. Calm empty/error states.
4. Home stats strip **(DONE)** (§3, partial): real day-streak + this-week cards wired via the same
   `getHSStats()`, tapping through to the Stats tab. **Still open in §3**: the full spotlight hero
   rebuild (hue-tinted backdrop, giant initial, Resume tint) — Home currently keeps its existing
   `CalmHero`; upgrading it to the prototype's spotlight treatment is separate follow-up work.
5. Library merge + search + filters/sort + view sheet + group drilldown (§4).
6. Item detail reskin (§5).
7. Player glow + scrubber thumb + reconcile (§6) — **confirm WIP decisions first**.
8. More hub + My settings + Server settings + About (§7); stub the still-data-gated sub-screens
   (Collections, Playlists, History, admin Server stats).
9. Sleep-sheet richness (follow-up).

Remaining open decisions in **§0.4** (real vs typeset covers #1, glow rendering #3, fonts #4) should be
answered before step 3. Tabs (#2) and listening-stats data (#5, now partly resolved) are decided.
