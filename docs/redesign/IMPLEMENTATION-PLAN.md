# HearthShelf Mobile Redesign — Implementation Plan

> **Who this is for:** whoever implements the redesign in `docs/redesign/`. It assumes
> you can edit React Native / Expo Router code and run the app, but it does **not**
> assume you already understand the codebase. Every task names the exact file(s),
> tells you what to change, and how to know it worked.
>
> **Golden rules — read before touching anything:**
> 1. **Do the mockup, not your own idea — and the `-Final` pages are the mockup.** The
>    suite went through two external reviews (v2/v3) and a reconciliation; the
>    authoritative spec per screen is: `index-Final.html` (overview + every adopt/reject
>    verdict), `01-home-Final.html`, `02-library.html` (no -Final; the v1 page stands),
>    `03-player-Final.html`, `04-book-Final.html`, `05-stats-clubs-Final.html`,
>    `06-settings-Final.html`, `07-system-Final.html`. Ignore the plain v1 pages where a
>    -Final exists, and ignore the `-v2`/`-v3` review suites entirely (kept for history).
>    The numbered annotations and legend rows ARE the spec. If the plan and the mockup
>    ever disagree, the mockup wins — stop and ask.
> 2. **Never edit `packages/core`.** It's a git submodule (a separate checkout). Changes
>    there break CI. Any shared-logic change belongs in `C:\code\HearthShelf-Core`. See
>    `CLAUDE.local.md`. If a task seems to need a core change, STOP and flag it.
> 3. **One task = one commit.** Each task below ends with a commit line. Use it verbatim.
>    Commit prefixes matter (they build the changelog): `fixes:` / `improved:` / `new:`.
> 4. **Do NOT `git push`.** Commit locally only. Pushing triggers releases.
> 5. **Test on a real build after each phase.** JS-only changes: reload Metro. Native/dep
>    changes (new packages): rebuild. The plan marks which is which.
> 6. **Work top-to-bottom.** Phases are ordered so later work builds on earlier work.
>    Don't skip ahead.

---

## How to view the mockups while you work

The in-app browser can't open `file://`. From a terminal:

```sh
cd C:\code\HearthShelf-Mobile\docs\redesign
python -m http.server 8123
```

Then open `http://localhost:8123` in any browser. Keep it open on a second monitor.

---

## Design tokens you will use constantly

All live in `src/ui/theme.ts`. **Never hardcode a hex value** — use these via
`useColors()` / `useStyles()` (see `src/ui/primitives.tsx` for how existing screens do it).

| Need | Token |
| --- | --- |
| Page background | `colors.scaffold` |
| Card surface | `colors.card` (a.k.a. `high`) |
| Accent (buttons, progress, active) | `colors.accent` / text on it `colors.onAccent` |
| Brand gold ("Hearth") | `colors.brandHearth` |
| Brand cream ("Shelf") | `colors.brandShelf` |
| Muted text | `colors.textMuted` |
| Success / destructive | `colors.success` / `colors.destructive` |
| Radii | `radius.card` 16 · `radius.row` 12 · `radius.pill` 999 · `radius.sheet` 20 |
| Spacing | `spacing.xs..xxl` = 4/8/12/16/24/32 |
| Motion | `import { DUR, POP_SPRING, SpringPressable } from 'src/ui/motion'` |
| Haptics | `import { haptics } from 'src/ui/haptics'` — `haptics.select/transport/success/warn()` |

**The 9 doctrine rules** that every phase serves: D-NAV, D-SEARCH, D-PLAY, D-STATES,
D-ACTIONS, D-FINISH, D-THUMB, D-CONSIST (defined in `index.html`) + **D-A11Y** (the
accessibility floor adopted from the reviews — see `index-Final.html` and Phase 10).
`index-Final.html` also carries the full adopt/reject verdict table from the v2/v3
review reconciliation — read it once before starting.

---

# PHASE 0 — Foundations (do these FIRST; everything else depends on them)

These are small, high-leverage changes that unblock the rest. Nothing visual is
"finished" until later phases, but these primitives must exist first.

## Task 0.1 — Make the tab bar remember where you are (D-NAV) — COMPLETED

**Problem:** every pushed screen renders `<AppTabBar activeName={null} …/>`, so no tab
lights up once you leave a tab root.

**Files:**
- `app/item/[id].tsx` (line ~510), `app/series/[id].tsx` (~352), `app/group/[type]/[key].tsx` (~118), `app/search.tsx` (~198), `app/club/index.tsx` (~122), `app/club/[id].tsx` (~349, ~636)

**Do this:**
1. Decide the owning tab per screen. Rule: a screen "belongs to" the tab the user
   came from. Simplest correct implementation: pass the owning tab explicitly.
   - `item`, `series`, `group`, `search`, `club/*` → these are reached from multiple
     tabs. Add a route param `from` (e.g. `router.push({ pathname:'/item/[id]', params:{ id, from:'library' }})`) and read it: `const active = (params.from as string) ?? 'library'`.
   - Where a caller doesn't pass `from`, default to a sensible tab (`library` for
     item/series/group/search, `home` for club).
2. Replace `activeName={null}` with `activeName={active}`.
3. Update the callers that navigate to these routes to pass `from`. Search for
   `router.push('/item/` and `router.push({ pathname: '/item/` across `app/` and `src/`.
   For each, add `from` matching the current tab.

**Verify:** open a book from Library → Library tab stays lit. Open one from Home →
Home stays lit. Open a club from Home shelf → Home stays lit.

**Commit:** `improved: The tab bar now stays lit on the section you came from`

## Task 0.2 — Re-tap active tab scrolls to top (D-NAV) — COMPLETED

**Files:** `src/ui/AppTabBar.tsx`, plus each tab root that owns a scroll view
(`app/(tabs)/index.tsx`, `library.tsx`, `stats.tsx`, `more.tsx`).

**Do this:**
1. In `AppTabBar`, when a tab is pressed AND it's already `activeName`, emit a signal
   instead of no-op. Easiest: a tiny module-level event bus, or reuse the existing
   `tabPress` emission. Create `src/ui/tabReselect.ts`:
   ```ts
   type Fn = () => void
   const subs: Record<string, Set<Fn>> = {}
   export function onTabReselect(tab: string, fn: Fn) {
     (subs[tab] ??= new Set()).add(fn); return () => subs[tab]?.delete(fn)
   }
   export function emitTabReselect(tab: string) { subs[tab]?.forEach(f => f()) }
   ```
2. In `AppTabBar`, in the tab press handler: `if (meta.name === activeName) emitTabReselect(meta.name)`.
3. In each tab root, get a ref to its scroll/FlatList and subscribe:
   `useEffect(() => onTabReselect('home', () => listRef.current?.scrollToOffset({offset:0, animated:true})), [])`.

**Verify:** scroll Home down, tap Home tab → smooth scroll to top. Same for Library, Stats.

**Commit:** `improved: Tap the current tab again to jump back to the top`

## Task 0.3 — Toasts can carry an action + follow the theme (D-FINISH, D-CONSIST) — COMPLETED

**Problem:** `showToast(message: string)` (in `src/ui/Toast.tsx`) supports text only,
auto-dismisses at 1900ms, is `pointerEvents="none"` (untappable), and uses static
`colors` (ignores the user's accent/light theme).

**Files:** `src/ui/Toast.tsx`

**Do this:**
1. Extend the signature (keep it back-compat — string still works):
   ```ts
   type ToastAction = { label: string; onPress: () => void }
   export function showToast(message: string, opts?: { action?: ToastAction; actions?: ToastAction[]; durationMs?: number }): void
   ```
2. When an action is present, default duration to **4000ms** (not 1900).
3. In `ToastHost`, make the pill `pointerEvents="box-none"` on the wrap and
   `"auto"` on the pill so action buttons are tappable; render the action label(s) as
   accent-colored `Pressable`s that call `onPress` then dismiss.
4. Switch the host from the static `colors` import to reactive `useColors()` so the
   accent + pill background follow the theme.
5. Add a "progress" variant: if `opts.progress === true`, show a small
   `ActivityIndicator` before the text (used by bulk download toasts).

**Verify:** call `showToast('Marked finished', { action:{ label:'Undo', onPress:()=>{} } })`
from anywhere — pill shows "Undo", tapping it fires the callback and dismisses; it
uses your accent color; switch to light theme and confirm it adapts.

**Commit:** `new: Toasts can now offer an Undo or Edit action`

## Task 0.4 — Reusable state components: Skeleton, EmptyState, ErrorState (D-STATES) — COMPLETED

**Problem:** loading is a bare spinner everywhere; empty/error states are missing or
ad-hoc.

**Files:** new `src/ui/states.tsx`

**Do this:** create three exported components, all using `useColors()`:
1. `<Skeleton width height radius />` — a shimmering block. Reuse the shimmer approach;
   animate with Reanimated (translateX on a gradient) at ~1600ms loop.
   Also export `<SkeletonRow/>` and `<SkeletonTile/>` (2:3 cover placeholder) for reuse.
2. `<EmptyState icon title body cta />` — centered icon chip (accent-wash bg) + title +
   muted body + optional `PrimaryButton`. Matches the empty frames in the mockups.
3. `<ErrorState message onRetry secondaryLabel onSecondary />` — cloud-off style icon,
   message, a "Try again" `PrimaryButton`, optional secondary ghost button.

**Verify:** drop each into a scratch screen and eyeball against the state boards in
`01-home.html` (§States) — they should match.

**Commit:** `new: Shared loading, empty, and error state components`

## Task 0.5 — Reusable QuickPlayTile + progress/finished affordances (D-PLAY) — COMPLETED

**Problem:** `BookTile` (`src/ui/BookTile.tsx`) has no quick-play, no progress bar, no
finished badge. Playing anything but the Home hero costs 2–3 taps.

**Files:** `src/ui/BookTile.tsx`

**Do this:**
1. Add optional props: `progress?: number` (0–1), `finished?: boolean`,
   `onQuickPlay?: () => void`.
2. When `progress > 0 && progress < 1`, render a 3px `.track`-style progress bar under
   the cover (see the Continue shelf tiles in `01-home.html`).
3. When `onQuickPlay` is provided AND the book is in progress, render a small circular
   play chip bottom-right of the cover (the `.playchip` in `hearth.css`) that calls
   `onQuickPlay` (stopPropagation so it doesn't also open detail).
4. When `finished`, render the finished badge (accent circle + check) top-right.
5. Keep existing long-press → selection behavior untouched.

**How to wire quick-play:** callers pass `onQuickPlay={() => { playItemById(id); router.push('/player') }}`
(the same call the Home ContinueHero already uses — grep `playItemById`).

**Verify:** a Continue tile on Home shows its progress bar + a play chip; tapping the
chip starts audio and opens the player in ONE tap; tapping the tile body still opens detail.

**Commit:** `new: Play a book in one tap right from its cover`

## Task 0.6 — One cover aspect everywhere (D-CONSIST) — COMPLETED

**Problem:** `app/group/[type]/[key].tsx` forces square covers (`aspectRatio:1`); the
Series hero also fixes sizes, while the rest of the app uses the user's `coverAspect`
setting (2:3 default).

**Files:** `app/group/[type]/[key].tsx`

**Do this:** replace the hardcoded square aspect with the user setting (read it the same
way `BookTile`/`Cover` do — grep `coverAspect`). Use the shared `<Cover>` from
`primitives.tsx` instead of a bespoke tile.

**Verify:** open an author screen → covers are 2:3 (or whatever the user set), matching
Library.

**Commit:** `improved: Book covers are the same shape on every screen`

---

# PHASE 1 — Home (`01-home-Final.html`)

Now that the primitives exist, rebuild Home to the mockup.

## Task 1.1 — Compact hearth hero (~240px) — COMPLETED

**Files:** `app/(tabs)/index.tsx` (the hero variants live here / in `src/player/*` — grep
`PlayerHero`, `ContinueHero`).

**Do this:** shrink the hero band from ~340px to ~240px (playing) / ~190px (paused) per
`01-home-Final.html` §Home. Move title/chapter/progress/transport into the lower half of
the band (D-THUMB). Keep: tap-hero→player, long-press→BookActionsSheet, Resume pill,
CoverGlow breathe behind art.

**Header utility row (FINAL, adopted from the v3 review):** the greeting line carries the
active server/library context underneath it ("Shelfside · Audiobooks" — tap opens the
server switcher), and TWO 44px icon buttons ride the right edge: **Downloads** (with an
accent activity dot while anything is downloading; opens the downloads manager) and
**Search** (pushes the unified `/search` from Phase 2).

**Verify:** compare side-by-side with the "Home — playing" and "Home — nothing playing"
frames. Stats/clubs/shelves should now start visibly higher.

**Commit:** `improved: A more compact player spotlight on Home`

## Task 1.2 — Dashboard row (Up next + streak) — COMPLETED

**Files:** `app/(tabs)/index.tsx`

**Do this:** under the hero, add the two-card row from the mockup: an "Up next" card
(mini queue covers + count + mode) that opens the queue sheet directly, and the
streak/this-week card that taps to Stats. Reserve height so nothing shifts on load.

**Verify:** matches §Home frame; "Up next" opens the queue sheet in one tap.

**Commit:** `new: A quick dashboard on Home for your queue and streak`

## Task 1.3 — Shelves get quick-play tiles — COMPLETED

**Files:** `app/(tabs)/index.tsx`

**Do this:** render shelf tiles with the Phase-0 `BookTile` props: pass `progress`,
`finished`, and `onQuickPlay` for in-progress rows (Continue / Continue-series). Give
each shelf an explicit leading icon in its metadata instead of string-guessing (find
the `sectionIcon` label-matching and replace with a per-shelf `icon` field).

**Verify:** Continue tiles show progress + play chip; custom recommendation rows show
the right icon.

**Commit:** `improved: Home shelves show progress and a one-tap play button`

## Task 1.4 — "See all" becomes a pushed screen — COMPLETED

**Files:** new `app/shelf/[key].tsx`; `app/(tabs)/index.tsx` (the See-all handler).

**Do this:** replace the 85%-sheet See-all with a real pushed route that renders the
shelf's items in a grid (reuse the same tile). Header = shelf name + count + back. Keep
Home lit (pass `from:'home'`, per Task 0.1). See `01-home.html` §"See all becomes a screen".

**Verify:** tap "See all" → full screen, back gesture works, Home tab stays lit.

**Commit:** `improved: "See all" opens a full screen you can scroll and back out of`

## Task 1.5 — Home states (skeleton / first-run / error / offline) — COMPLETED

**Files:** `app/(tabs)/index.tsx`

**Do this:** using Phase-0 `states.tsx`, add: skeleton layout while loading (mirrors the
real layout), a first-run empty state, an error state (the `loadHome().catch` currently
swallows errors — set an error flag and render `<ErrorState onRetry={loadHome}/>`
instead), and the offline state (chip + downloaded shelves; the offline rebuild already
exists — just add the visible chip and ensure tiles show download badges). Match
`01-home.html` §States.

**Verify:** kill the server → error state with retry (not a blank greeting). Airplane
mode with downloads → offline chip + downloaded shelves.

**Commit:** `improved: Home now shows clear loading, empty, error, and offline states`

---

# PHASE 2 — Unified Search (`02-library.html` §Search) (D-SEARCH)

## Task 2.1 — Rebuild `/search` as the one search surface — COMPLETED

**Files:** `app/search.tsx`; delete reliance on Library's inline search (Task 2.2).

**Do this:** rebuild per the Search frames:
- Header: back + search pill **with a clear (X) button** + a gear icon.
- Scope chips: Everything · Books · Series · Authors · Narrators.
- Recent searches list (persist last ~8 queries in AsyncStorage).
- Results: when scope = Everything, section results by type; otherwise a single grid/list.
- "Beyond your library" section (Audible) with consistent row layout + Request/Audible
  actions → existing `NotOwnedSheet`.
- The gear opens a small sheet with the "Search beyond your library" toggle (moved here
  from the deleted settings screen — see Task 6.x). Read/write the existing
  `searchExternalSources` setting.
- States: typing skeleton, no-results (suggest "Search beyond your library?" if the
  toggle is off), error + retry, offline (owned/downloaded only + chip).

**Verify:** search from Home's new search button; scope chips filter; clear button works;
Audible section appears when the toggle is on.

**Commit:** `improved: One search screen with scopes and out-of-library results`

## Task 2.2 — Point Library's search at the unified surface — COMPLETED

**Files:** `app/(tabs)/library.tsx`

**Do this:** replace the inline library search box with a search affordance in the header
that pushes `/search` (pass `from:'library'`). Remove the divergent inline search logic.
Keep the Books/Series/Narrators/Authors **browse** chips (they're not search).

**Verify:** Library header search opens the same screen as Home's; there's no longer a
second, different search box.

**Commit:** `improved: Library search now uses the unified search screen`

---

# PHASE 3 — Library (`02-library.html`)

## Task 3.1 — Surface-level control bar (sort / filter / layout) — COMPLETED

**Files:** `app/(tabs)/library.tsx`

**Do this:** replace the single "Filter · Sort · View" button with a persistent control
bar under the browse chips: a sort chip ("Title ↑" — tap flips direction; chevron opens
the sort sheet), a filter chip with a count badge, and a grid/list layout toggle. Keep
the full options sheet (Display/Sort/Filter tabs, incl. Random + cover size) reachable
from the sort chip's chevron. Match §Library frame.

**Verify:** flip sort direction in one tap; switch list/grid in one tap; full sheet still
available.

**Commit:** `improved: Sort, filter, and layout are one tap on the Library screen`

## Task 3.2 — Library-picker sheet (kill the blind cycle) — COMPLETED

**Files:** `app/(tabs)/library.tsx` (the `LibrarySwitcher`).

**Do this:** replace the cycle-through chip with a proper picker sheet: a list of
libraries with a checkmark on the active one and book counts. Match §Library frame.

**Verify:** on a multi-library server, tap the library chip → sheet lists all; pick one.

**Commit:** `improved: Pick a library from a list instead of cycling through`

## Task 3.3 — Tiles + A-Z rail + states — COMPLETED

> **FINAL DECISION (revises the original task):** the A-Z rail is **list-view only**, on
> alphabetical sorts — it is REMOVED from grid view so covers get the full width
> (adopted from the v3 review; cleaner than reserving a dead 28px lane in the grid).

**Files:** `app/(tabs)/library.tsx`, `src/ui/AzRail.tsx`

**Do this:**
- Books/grid tiles use the Phase-0 `BookTile` (progress, finished, quick-play).
- **A-Z rail: alphabetical LIST views only** (Books list + Groups name-sort). Remove it
  from grid view entirely — grid covers span the full width. ScrollTop pill covers quick
  navigation in grid; it co-exists bottom-left when the rail is present in list view.
- Add a Books **empty state** ("No books in this library yet" + switch-library CTA),
  skeleton grid while loading, offline chip + downloaded-only note.
- Add a one-time dismissable "Pinch to resize" hint pill over the grid.

**Verify:** grid view has NO rail and full-width covers; alphabetical list views show the
rail; empty library shows the empty state; pinch still resizes and the hint appears once.

**Commit:** `improved: Full-width covers in the grid; A-Z rail lives in list view`

## Task 3.4 — Selection entry that's discoverable — COMPLETED

**Files:** `app/(tabs)/library.tsx`, `src/ui/BookSelectionToolbar.tsx`

**Do this:** add a "Select" affordance to the control bar (and/or in the sort sheet) so
multi-select isn't long-press-only. Give the toolbar an "N selected" label and an
overflow ⋯ for rarer bulk ops. Keep long-press working. Match §Library selection frame.

**Verify:** you can enter selection without knowing the long-press secret.

**Commit:** `improved: A visible way to select multiple books`

---

# PHASE 4 — Series & Group screens (`02-library.html`)

## Task 4.1 — Series detail refinements (keep the good bones) — COMPLETED

**Files:** `app/series/[id].tsx`

**Do this** (the mockup labels most of this "kept" — small surgical changes):
- Make the author line tappable → author group screen.
- Add a micro-legend under the SegmentTrack: `● finished · ◐ in progress · ⃠ not owned`.
- Demote "Mark series finished" from the big full-width secondary button to the header
  overflow (and keep it in the selection toolbar).
- Collapse missing/unowned books into their own "Not in your library (N)" expandable
  section (out of the main reading-order list).
- Ensure the per-row play button appears on **every owned row** (streaming), not only
  downloaded rows.
- Keep the tab bar lit on the owning tab (Task 0.1).

**Verify:** author is tappable; legend present; missing books are in their own section;
every owned row has a play button.

**Commit:** `improved: Clearer series screen with author links and a status legend`

## Task 4.2 — Author / Narrator group screen — COMPLETED

**Files:** `app/group/[type]/[key].tsx`

**Do this:** add a hero (avatar + name + "N books · M series"), a sort chip
(Title/Series/Year), and series-aware grouping (books under series subheads when the
author has series). Covers already fixed in Task 0.6. Add empty + skeleton states.

**Verify:** matches §Author frame; sorting works; series group together.

**Commit:** `improved: Richer author and narrator screens`

---

# PHASE 5 — Player (`03-player-Final.html`) (D-STATES)

> This is the highest-risk phase (secure-audio, gesture, and sheet code). Go task by
> task and test audio after each.

## Task 5.1 — Fix the disappearing skip buttons (real bug) — COMPLETED

**Files:** `app/player.tsx`

**Do this:** the rewind/skip-forward `SkipButton`s are rendered **inside** the
`hasChapters && !immersive` branch, so chapterless books lose them. Pull the skip
buttons OUT so they always render; only the chapter-prev/next buttons stay gated on
`hasChapters`. See `03-player.html` §Full player.

**Verify:** play a book with NO chapters → skip-back/forward still show and work.

**Commit:** `fixes: Skip buttons no longer disappear on books without chapters`

## Task 5.2 — Queue as a header chip; the one-row layout law — COMPLETED

> **FINAL DECISION (revised twice — this is current):** the player's layout law is
> **cover is king**: whole-book strip + carousel dots up top, big artwork, ONE compact
> title line, scrubber, transport, and exactly ONE action row below it. Nothing else
> stacks under the transport — no dedicated "Up next" line (an earlier draft had one;
> the user rejected it: it squished the artwork). See `03-player-Final.html` §Full player.

**Files:** `app/player.tsx`, `src/player/SyncStatusIcon.tsx`

**Do this:**
1. **Queue → compact header chip.** Remove the Queue button from wherever it lives and
   render a small chip on the header LEFT: queue icon + count + mode ("3 · Auto").
   Tap opens the Queue sheet. (annotation 1)
2. **Sync + Focus view stay header RIGHT** — sync is a passive status glyph (shape-coded,
   never color alone); Focus view is the explicit entry to the minimal layout. (2, 3)
3. **Title + author collapse to ONE line** under the cover (title bold + author muted);
   a long combination marquees horizontally (24px/s after a 1.2s hold, edge-faded)
   instead of wrapping. The freed height goes to the artwork (~336px square). (7)
4. **Long chapter names marquee inside the scrubber** the same way ("Ch 4 · Seriously,
   What's With the Ducks?" scrolls) — no truncation, no extra chapter row. (9)
5. **Carousel dots move up** to just under the whole-book strip; nothing renders below
   the action row.

6. **Action-row buttons stretch to fill the rail** — flex-width, ~52px-tall rounded
   rects with 9px gaps (matching live code's wide buttons), NOT small fixed circles
   centered with dead space around them. Fewer enabled slots = wider buttons.

**Verify:** below the transport there is exactly ONE row (the configurable action row)
whose buttons span the full width; the cover measures noticeably larger than before; a
long chapter title scrolls inside the scrubber; the queue chip shows a live count + mode
and opens the queue.

**Commit:** `improved: Bigger artwork — queue moves to a header chip, one action row`

## Task 5.3 — Buffering state — COMPLETED

**Files:** `app/player.tsx`

**Do this:** add a buffering state — a thin animated ring around the play button plus a
"Buffering…" micro-caption **directly under the play button** — shown when the track is
stalled (there is currently no buffering feedback at all). Appear only after a ~400ms
grace period so micro-stalls don't flash. Transport stays tappable while buffering.

**Do NOT add a separate chapter-name pill.** Current-chapter position already lives in the
Scrubber's interior label ("Ch 12 · 33:12"); a pill above it is redundant clutter. The
condensed scrubber is the position display. Chapters remain reachable from the action-row
chapters button (which, per Task 5.6a, opens pre-scrolled to the current chapter).

**Verify:** throttle the network → buffering ring + caption appear under the play button;
there is no extra chapter pill above the scrubber.

**Commit:** `new: Buffering indicator on the player`

## Task 5.4 — Cover tap = INSPECT by default (FINAL reversal) + hotspot hints — COMPLETED

> **FINAL DECISION (reverses the original task):** do NOT flip `tapArtworkTogglesPlay`
> to ON. The v2 review verified prod defaults it OFF (`settings.ts:222`), and making the
> largest tap target on the screen a play/pause hair-trigger is a regression. See
> `03-player-Final.html`.

**Files:** `app/player.tsx`, `src/store/settings.ts`

**Do this:** keep `tapArtworkTogglesPlay` default **OFF**. Single tap on the cover =
inspect (opens the lightbox). Play-on-cover remains an opt-in setting for those who want
it. Add subtle one-time hint arcs for the skip hotspots and a one-time "tap to inspect"
hint.

**Verify:** single-tap opens the lightbox; with the setting enabled, single-tap
plays/pauses instead; hints show once.

**Commit:** `improved: Tapping the cover inspects the art; play-on-cover is opt-in`

## Task 5.5 — Focus view rename + the car boundary (FINAL reversal) — COMPLETED

> **FINAL DECISION (reverses the original task):** immersive and Car mode are TWO
> DIFFERENT THINGS. Do NOT rename immersive to "Car mode". See `03-player-Final.html`
> §Focus view.

**Files:** `app/player.tsx`, `src/player/actions.tsx`, `src/player/immersive.ts`

**Do this:**
1. Rename the user-facing immersive mode to **"Focus view"** — a phone display
   preference (big artwork, hidden chrome), strictly opt-in, entered by swipe-up or the
   header Focus-view button, exited by swipe-down or the visible X. It is never
   auto-triggered.
2. The **car experience stays native** (Android Auto / CarPlay via `autoBridge.ts` + the
   native MediaLibraryService). The phone never becomes a driving UI. When a head unit is
   connected, show a small "Playing in your car" status chip on the player.
3. Remove the `carMode` "coming soon" action stub from `src/player/actions.tsx`
   (actions.tsx:108) — its action-row slot becomes the Focus-view entry.

**Verify:** the Focus-view button enters the big layout (no more fake toast); swipe-up
still works; X exits; connecting to Android Auto shows the status chip and does NOT
change the phone layout.

**Commit:** `improved: Focus view is a phone preference; the car experience stays native`

## Task 5.6 — Sheets: Chapters, Speed, Sleep, Queue, Recent — COMPLETED (5.6d auto-rules reorder deferred)

**Files:** `src/player/sheets.tsx`, `src/player/QueueSheet.tsx`, `src/player/QueueEditors.tsx`

Sub-tasks (commit each separately):

**5.6a [DONE] Chapters sheet** — auto-scroll to the current chapter (centered) on open; add a
search field when there are 50+ chapters. `fixes: Chapters open scrolled to where you are`

**5.6b [DONE] Sleep presets arm instantly (real bug/UX)** — tapping a preset pill (e.g. "30 m")
must START the timer and flip the sheet to running mode + toast "Sleeping in 30 min" +
success haptic. The Start button stays only for the slider/custom/chapter/time values.
Add an "End of chapter" pill to the presets row. `fixes: Sleep timer presets start the timer right away`

**5.6c [DONE] Speed** — add a "Reset 1×" ghost chip that appears only when rate ≠ 1.
`improved: Quick reset to 1x on the speed sheet`

**5.6d [DONE] Queue: add books + reorder rules** — add a "+ Add books" row in Manual/Auto modes
that opens a search/library picker to append to the queue (you currently can't add books
from the player at all). Give the Auto-rules sub-sheet drag-to-reorder priority (parity
with the settings editor). `new: Add books to your queue from the player`

**5.6e [DONE] Recent sheet declutter** — one clear primary tap per row (resume at end) + a small
⋯ for jump-to-start, instead of three crammed tap targets.
`improved: Simpler recent-listens rows`

**5.6f [DONE] More action tray → quick-action grid + in-context editor** (the sheet behind the
action row's More button — `MoreSheet` in `src/player/sheets.tsx`).

Structure it as TWO parts (match the "More action tray & button editor" frame in
`03-player.html`, Sheets II):
1. **A 3-across grid of square icon tiles** for the peer quick-actions — NOT full-width
   rows. These are one-tap launches; a grid reads by icon, packs into the thumb arc, and
   mirrors the on-screen action row's visual language. **Order by in-session frequency,
   not by leftover-placement order:** Bookmarks · Notes · Add to list · Details ·
   Downloaded · Cast. The grid is dynamic — it holds exactly the actions the user's
   placement leaves off the on-screen row. Put a small accent **badge** on a tile only
   when it has live state worth glancing at (Bookmarks = saved count, Notes = thread
   count). The **Downloaded** tile encodes its tri-state in color (green tint + done glyph
   = on device → tap removes with an Undo toast; plain = download; ring+percent =
   in-flight) — no sub-label needed.
2. **Below a divider, two pinned rows** (rows, not tiles — they carry a description and a
   chevron into a sub-sheet, a different category from the launch grid): **"Player
   settings"** (opens player settings as a sheet in-context, per Task 8.5) and **"Edit
   these buttons"** (opens the `/settings/player-buttons` drag-across-zones editor as a
   stacked sheet).

`improved: A clearer More menu on the player`

**Verify each** against the matching sheet frame in `03-player.html`.

## Task 5.7 — Mini player upgrades — COMPLETED

**Files:** `src/player/MiniPlayer.tsx`

**Do this:** add a thin progress ring around the cover; horizontal swipe on the mini
player = skip back/forward with the ± feedback bloom. Keep tap→player.

**Verify:** ring reflects position; swiping skips.

**Commit:** `new: Progress ring and swipe-to-skip on the mini player`

## Task 5.8 — Empty player state — COMPLETED

**Files:** `app/player.tsx`, `app/(tabs)/now.tsx`

**Do this:** when there is genuinely nothing in progress, show the designed empty state
(hearth flame area, "Nothing on the hearth", 3 continue-listening mini tiles, "Browse
library" CTA). **Keep** the Now-tab IdleResolver auto-load-paused behavior for the case
where a recent book exists.

**Verify:** brand-new account with nothing in progress shows the empty state, not a bare
"Nothing playing".

**Commit:** `improved: A helpful empty state when nothing is playing`

---

# PHASE 6 — Book detail, Reader, Upcoming (`04-book-Final.html`) (D-ACTIONS, D-FINISH)

## Task 6.1 — Stable section order — COMPLETED

**Files:** `app/item/[id].tsx`

**Do this:** the screen currently reorders sections by listening state (`sectionOrder`).
Replace with ONE fixed order: Hero → Status+CTA → Chapters → Series → About → Community
→ Notes → Club. Only the CTA label adapts (Resume/Start/Listen again). Match §Detail
frames (there are in-progress and not-started variants proving the order is stable).

**Verify:** open an in-progress book and a not-started book — sections are in the same
order, only the button label differs.

**Commit:** `improved: Book pages keep a consistent layout so you build muscle memory`

## Task 6.2 — CTA row: one-tap finish, download size, full grammar — COMPLETED

**Files:** `app/item/[id].tsx`

**Do this:**
- **Finish = one tap** (D-FINISH): mark finished immediately → EmberBurst + action toast
  "Finished · Edit date · Undo" (using the Phase-0 toast actions). The date prompt is
  reached only from the toast's "Edit date" action, no longer as a mandatory interstitial.
- Download square shows the **size** before download ("1.2 GB") and an explicit cancel
  affordance (X inside the ring) while downloading.
- Bookmarks header button is **always visible** (opens the sheet even when empty; give
  the empty sheet a proper empty state + "add from player" hint).
- Add **Reset progress** and **Hide this book/series** to the overflow so detail carries
  the full action grammar (D-ACTIONS). Keep Share, Add to list, Recent Listens, file info.

**Verify:** finishing is one tap with an Undo/Edit-date toast; download shows size;
bookmarks button always present; overflow has reset + hide.

**Commit:** `improved: One-tap finish and the full action menu on book pages`

## Task 6.3 — Book detail states — COMPLETED

**Files:** `app/item/[id].tsx`

**Do this:** skeleton loading, offline frame (downloaded book opens with cached data +
offline chip; server extras show a placeholder note). The offline fallback logic already
exists — add the visible chip + skeletons.

**Commit:** `improved: Loading and offline states on book pages`

## Task 6.4 — Ebook reader: position slider — COMPLETED

**Files:** `app/item/[id]/read.tsx`

**Do this:** add a position slider to the bottom bar (this was BOTH reviews' top pick —
prod's reader has only ±page chevrons + a percent, `read.tsx:217`): a draggable knob with
the ± page arrows kept on either side, a **Chapter↔Book scope pill** that flips whether
the slider spans the chapter or the whole book (same metaphor as the audio scrubber,
D-CONSIST), and a **"~N min left in chapter"** estimate derived from measured reading
pace. Knob scales 1.2 while held with a haptic tick per chapter crossed; releasing far
from the start offers a "Back to page" undo toast. Keep the settings + TOC panels.
Match `04-book-Final.html` §Reader frames.

**Verify:** you can scrub to an arbitrary position, not just ±1 page.

**Commit:** `new: Scrub to any position in the ebook reader`

## Task 6.5 — Upcoming/preorder screen — COMPLETED

**Files:** `app/upcoming/[asin].tsx`

**Do this:** add `CoverGlow` (consistency with detail); make the countdown **live** (it's
currently computed once and never ticks — add a `setInterval`/timer that updates the
label, cleaned up on unmount); add a series-context row linking to the series screen.
Keep Follow + Audible buttons.

**Verify:** the countdown ticks down while the screen is open; series row links out.

**Commit:** `fixes: The release countdown now ticks live on upcoming books`

## Task 6.6 — BookActionsSheet: grid of quick actions + pinned rows — COMPLETED

**Files:** `src/ui/BookActionsSheet.tsx`

This is the app's most-used action surface (long-press any tile — Home, Library,
See-all, Search, Author). Structure it exactly like the player's More tray (Task 5.6f) so
the two speak one language. Match the "BookActionsSheet" frame in `04-book.html`.

**Do this:**
1. Keep the header (cover + title + live progress; tap → detail).
2. **A 3-across grid of square icon tiles** for the six peer one-tap launches, in this
   frequency order: **Play · Play next · Add to queue · Add to list · Download · Finish.**
   Make **Play** the accent-filled tile (most-tapped). The **Download** tile encodes its
   tri-state in color (plain = download, ring+percent = in-flight, green tint = done → tap
   removes) with the size in small mono under the label — no separate row. Finish is one
   tap → the "Finished · Edit date / Undo" action toast (Task 6.2 / 0.3).
3. **Below a divider, pinned rows** (rows, not tiles) for the items that carry a context
   label, a chevron, or destructive weight: **View series** (chevron; hides for standalone
   books) · **Share** · **Reset progress** (destructive color) · **Not right now…** (hide
   book/series, destructive color, sub-label). Keeping these as rows below the fold is also
   a safety win — they're not one-tap-by-accident grid tiles. Every destructive/reversible
   one exits through an Undo toast (D-ACTIONS).
4. This same component powers the Home long-press, so the fix propagates there for free.

**Verify:** long-press a tile on Home AND Library → identical grid + rows; Play is one tap
to audio; the destructive items sit as rows below the divider; Download tile shows state.

**Commit:** `improved: A faster, consistent book actions menu (grid of quick actions)`

---

# PHASE 7 — Stats & Clubs (`05-stats-clubs-Final.html`) (D-STATES, D-CONSIST)

## Task 7.1 — Stats: refresh + jump chips + orphan tile — COMPLETED

**Files:** `app/(tabs)/stats.tsx`

**Do this:** add pull-to-refresh; add a sticky section-jump chip row (Overview · Goal ·
Charts · Compare · Leaderboard); fix the orphan tile (last odd tile spans full width with
a horizontal layout). Keep hero/tiles/bar chart/month card (mark "kept").

**Commit:** `improved: Pull to refresh and jump-to-section chips on Stats`

## Task 7.2 — Heatmap fixed + accessible (real bug + FINAL a11y) — COMPLETED

**Files:** `app/(tabs)/stats.tsx`

**Do this** (match `05-stats-clubs-Final.html` §"Heatmap — grid + week list"):
1. Render the month labels along the top axis (they're computed at `stats.tsx:948` but
   never drawn — real bug) and weekday letters (S M T W T F S) down the left.
2. **The tap target is the whole ~48px WEEK COLUMN, not a 12px cell** (FINAL, both
   reviews): tapping a week highlights the column and shows that week's detail in a card
   **below the grid** (not a bubble under the finger) — total time, active days,
   chapters, busiest day.
3. **"View as list" toggle** (Grid | List) on the heatmap card: List shows the selected
   week as seven DATED day rows ("Mon 09 — 42 min · 2 chapters"; empty days read "No
   listening") that VoiceOver/TalkBack reads linearly — the grid's non-visual equivalent
   (FINAL, both reviews).

**Verify:** month axis + weekday rail render; tapping anywhere in a week column selects
it and fills the detail card; the List view reads sensibly top-to-bottom with a screen
reader.

**Commit:** `fixes: The listening heatmap shows months, tappable weeks, and a list view`

## Task 7.3 — Goal ring + compare + partial-failure — COMPLETED

**Files:** `app/(tabs)/stats.tsx`

**Do this:** EmberBurst when the goal is reached; add a search icon on the Compare chip
row when >8 users (opens a picker sheet); when history fails, show an inline "Couldn't
load history · Retry" card instead of silently dropping the heatmap+month sections.

**Commit:** `improved: Goal celebration, compare search, and resilient Stats history`

## Task 7.4 — Stats states board — COMPLETED

**Files:** `app/(tabs)/stats.tsx`

**Do this:** skeleton / empty ("Nothing yet" + CTA) / error retry using Phase-0 `states.tsx`.

**Commit:** `improved: Loading, empty, and error states on Stats`

## Task 7.5 — Club list: unread badges + New club — COMPLETED

**Files:** `app/club/index.tsx`

**Do this:** show an unread-notes count badge (the server cursor already exists), member
count, and a last-activity line per row; add a "New club" header action. Keep the owning
tab lit (Task 0.1).

**Commit:** `improved: Club list shows unread counts and lets you start a club`

## Task 7.6 — Club room: timestamp chip, unread divider, recolored archive — COMPLETED

**Files:** `app/club/[id].tsx`, `src/social/*` (composer)

**Do this:**
- Add a timestamp chip above the composer input when you're playing this book
  ("⏱ Ch 12 · 4:32 ✕") so the currently-implicit stamping is explicit and removable.
- Add a "— new since last visit —" divider in the discussion (uses the existing server
  cursor).
- Recolor "Archive" to neutral (it's reversible) with a "can be restored" caption;
  "Delete" stays destructive (D-CONSIST).
- Race rows get a "listening now" caption, not just the tiny dot.

**Verify:** timestamp chip appears when playing the book and its X removes the stamp;
archive is no longer red.

**Commit:** `improved: Clearer club room — timestamps, unread marker, safer archive`

---

# PHASE 8 — Settings IA (`06-settings-Final.html`) (D-CONSIST, D-SEARCH)

## Task 8.1 — Rebuild the More-tab grouping — COMPLETED

**Files:** `app/(tabs)/more.tsx`

**Do this:** regroup per §More-tab frame:
- **You:** Appearance & feel (merge Appearance + Haptics), Notifications
- **Playback:** Player, Sleep timer, Queue (promote from depth-3), Downloads & storage
- **Reading:** Reading (make it real — Task 8.4)
- **Community:** Sharing & clubs, Integrations
- **Account:** My servers, Account
- **Admin** (conditional, honest "Coming soon" intro)
- **Advanced:** Sync settings (in a proper group, not a loose row), Diagnostics
- About row (version) kept.

**Commit:** `improved: Reorganized the Settings menu into clearer groups`

## Task 8.2 — Merge screens; delete the one-toggle Search screen — COMPLETED

**Files:** `app/settings/appearance.tsx` (+ absorb `haptics.tsx`), delete
`app/settings/search.tsx` and its route + More row (its toggle moved into the search
gear in Task 2.1), merge Community's booleans from `Seg` to `SettingsToggle`.

**FINAL note:** inside the merged Appearance & feel screen, the **Theme control
(System / Dark / Light / OLED) is the FIRST group** — it's the most-changed setting. It
does NOT go on the More hub (split of the v2/v3 review positions).

**Verify:** Haptics controls now live at the bottom of Appearance & feel; there's no
standalone Search settings screen; the search-external toggle lives in the search gear.

**Commit:** `improved: Fewer, fuller Settings screens`

## Task 8.3 — Single control per value; conflict warning — COMPLETED

**Files:** `app/settings/playback.tsx`, `app/settings/sleep.tsx`

**Do this:** collapse the dual chip+slider controls (skip forward/back, auto-timer
duration) into a single slider with preset tick labels (15/30/60…). Add an inline warning
row when both "Swipe between books" (carousel) and "Skip hotspots" are on, with a one-tap
resolve. Give Sleep's four identical untitled groups real subheads (Rewind, Fade, Warning
beeps, Shake, Auto timer).

**Commit:** `improved: One clear control per setting; sleep options grouped`

## Task 8.4 — Make Reading settings real — COMPLETED

**Files:** `app/settings/reading.tsx`

**Do this:** replace the 6 disabled placeholder rows with controls bound to the reader
prefs that ALREADY work (theme swatches, typeface, size, layout — grep `readerPrefs`).

**Verify:** changing a value here changes the ebook reader.

**Commit:** `new: Reading settings now actually control the ebook reader`

## Task 8.5 — Player settings in-context sheet — COMPLETED

**Files:** `app/player.tsx`, `app/settings/playback.tsx` (extract a shared body)

**Do this:** let the player's overflow open Player settings as a bottom sheet (not a
tab-away), mirroring the good in-context pattern the button editor already uses. Match
§"Player settings as sheet" frame.

**Commit:** `new: Adjust player settings without leaving the player`

## Task 8.6 — Servers: visible default + link a server — COMPLETED

**Files:** `app/settings/servers.tsx`

**Do this:** add a visible default-star button per card (retire the long-press-only
affordance) and a "Link a server" row. Keep tap = switch.

**Verify:** you can set a default without knowing the long-press secret.

**Commit:** `improved: Set a default server with a visible button; link new servers`

## Task 8.7 — Settings search (FINAL, adopted from the v2 review) — COMPLETED

**Files:** `app/(tabs)/more.tsx`

**Do this:** add a search field pinned directly under the "More" title (pill: search icon
+ "Search settings"). It fuzzy-matches setting row titles AND synonyms ("crossfade" →
Player fade, "dark mode" → Appearance theme), then deep-links to the owning screen and
briefly highlights the matched row (accent-wash flash). 17 settings routes is a long
enough list to warrant this; the v3 review argued against it and was overruled. Match
`06-settings-Final.html` §More tab (annotation 8).

**Verify:** typing "sleep beep" surfaces the Warning-beeps row; selecting it opens Sleep
timer with that row focused + highlighted.

**Commit:** `new: Search your settings`

## Task 8.8 — "Reset this section to defaults" (FINAL, both reviews) — COMPLETED

**Files:** `src/ui/settingsControls.tsx` (SettingsLabel gains an optional overflow),
each settings screen that opts in.

**Do this:** give settings group headers an optional ⋯ overflow with one item — "Reset
this section to defaults" — applied immediately with an **Undo toast** (Task 0.3), never
a blocking Alert. Wire it on the groups with real reset value (Player transport, Sleep
families, Appearance). Nothing in prod can reset a section today.

**Verify:** resetting the Sleep "Warning beeps" family restores defaults and the toast's
Undo restores the user's values.

**Commit:** `new: Reset a settings section to defaults with one tap`

## Task 8.9 — Integrations de-duplication — COMPLETED

**Files:** `app/settings/integrations.tsx`

**Do this:** put the external-link toggles (Goodreads/Audible/Hardcover) in their own
labeled subgroup so "Hardcover" no longer appears twice ambiguously (service connection
vs external link). Keep the Goodreads import sheet flow.

**Commit:** `improved: Clearer Integrations layout`

---

# PHASE 9 — Sign-in & System (`07-system-Final.html`) (D-CONSIST)

## Task 9.1 — Theme + bottom-align the sign-in screen — COMPLETED

**Files:** `app/sign-in.tsx`

**Do this:**
1. **Bottom-aligned layout over the hearth photo.** Keep the shipping "sitting by the
   hearth" image (`assets/images/hearth-centered.webp`, already used) as a full-bleed
   `ImageBackground`. Move the **wordmark hero to the upper third** (absolutely
   positioned) and anchor the **entire auth block (provider buttons + terms) to the
   bottom** of the screen (thumb zone) — not floating in the middle as today. Add a
   bottom-heavy scrim gradient over the photo so buttons and terms stay legible over the
   fire.
2. **Lift above the keyboard.** Wrap the auth block in `KeyboardAvoidingView` (or pad by
   keyboard height via `useAnimatedKeyboard`) so that when an email/password field
   focuses, the block slides up and nothing hides behind the keyboard. Verify on both
   platforms.
3. **Theme tokens, not hardcoded hex — but the screen STAYS DARK** (FINAL): the dark
   hearth-photo pre-auth screen is intentional brand identity; there is deliberately NO
   light-mode sign-in (the v2 review proposed one; rejected — user + v3 agree). The fix
   is only the wiring: links, spinners, and the wordmark read `brandHearth` /
   `brandShelf` / `accent` from the token system instead of literals. **Keep the
   wordmark hero locked**: "Hearth" gold regular + "Shelf" cream bold, Libre
   Baskerville — brand-critical, do not restyle. Do NOT draw a flame glyph here (the
   photo already has a real fire).
4. Keep the provider buttons (Google/Apple/Discord/email) with their platform notes. The
   email button reads well as a translucent "glass" button over the photo.

See `07-system.html` §Sign-in (default frame).

**Verify:** buttons sit at the bottom within thumb reach; focusing the email field lifts
the block above the keyboard; the wordmark is unchanged; no hardcoded hex remains.

**Commit:** `improved: Bottom-aligned sign-in over the hearth photo, themed`

## Task 9.2 — Email flow completion — COMPLETED

**Files:** `app/sign-in.tsx`

**Do this:** add show/hide password eye, a "Forgot password?" link (Clerk hosted flow),
an error banner (destructive-wash card, not tiny centered text), and a designed 2FA
code-entry step instead of the current dead-end "needs another step: {status}". Make
Terms & Privacy real tappable links.

**Verify:** password eye works; a 2FA-required account reaches the code screen, not a
dead-end.

**Commit:** `improved: Complete email sign-in with 2FA and forgot-password`

## Task 9.3 — Optimize the crackling-fire animation (keep the look) — COMPLETED

**Files:** `src/ui/SplashScreen.tsx` (and the reused ember field on `app/sign-in.tsx`).

**Why:** the ember field is 24 individually-animated `react-native-svg` `<Ellipse>` nodes
with radial-gradient fills, each on its own `withRepeat` clock, running at cold boot — the
worst time to drop frames on low-end Android. The motion is already worklet-driven; the
cost is SVG node count + per-node rasterization. Keep the exact look, cut the draw cost.
See `07-system.html` §Splash → "Optimizing the crackling fire" box (do these in order):

1. **One draw surface, textured quads.** Replace the live SVG `<Ellipse>` + radial
   gradient per ember with small **Reanimated views showing one pre-baked radial-glow
   PNG** (a single cached texture, tinted per-ember). One texture, N cheap transformed
   quads — no per-frame vector raster.
2. **Transform + opacity only.** Ensure each ember worklet animates ONLY `translateX/Y`,
   `scale`, `opacity` (GPU-composited). Never animate width/height/radius/gradient stops.
3. **Device-tier the count.** Drop to ~10–14 particles on low-RAM devices (gate on
   `Device.totalMemory` or a coarse tier), keep 24 on capable hardware. `log()` nothing
   user-facing; it reads the same.
4. **One shared clock.** Replace 24 `withRepeat` timelines with a single
   `useFrameCallback` (or one master `SharedValue` ramp) that a `useDerivedValue` reads
   per ember, offset by its seed. Cheaper, and makes pause-on-blur trivial.
5. **(Optional, only if 1–4 aren't enough)** move the whole field to a single
   `@shopify/react-native-skia` `<Canvas>` — NOT installed today, so this adds a
   dependency; only do it if profiling still shows jank or the fire gets richer. STOP and
   flag before adding the dep.
6. **Don't burn battery idle.** Pause the field's clock on `AppState` background; after
   ~4s of "connecting", drop to a slower tick. Stop entirely when the exit fade starts.

Leave the background gradient ramp + the two halos as-is (they're cheap).

**Verify:** record the Android GPU/Perf Monitor on a low-end device before and after —
frame time during cold boot should drop; the animation should look identical. The sign-in
screen's ember field reuses the same optimized system.

**Commit:** `improved: Smoother boot fire animation on low-end devices`

## Task 9.4 — Splash phases + offline banner + invite — COMPLETED

**Files:** `src/ui/SplashScreen.tsx`, `src/ui/OfflineBanner.tsx`, `app/invite.tsx`

**Do this:**
- **Reduce-motion / low-end static splash (FINAL, both reviews):** when the OS reports
  Reduce Motion — or the device is below a memory tier, regardless of the setting — swap
  the ember particle field for ONE static painted radial glow, and show a **determinate
  progress bar** + "Connecting to {server}…" text so progress is never conveyed by fire
  motion alone. (`grep reduceMotion` finds nothing in prod — this is a genuine gap.)
- Splash error phase: friendly copy + a collapsible "Show details" for the raw string
  (currently leaks raw server strings on the first-impression screen); add a "How to link
  a server" help link on the no-servers phase.
- Offline banner: an explicit bordered Retry **button** (today the whole pill is secretly
  the tap target). Add the reconnected moment (green "Back online — syncing…" then slides
  away).
- Invite landing: reveal the server name when known + a fallback error state ("Ask for a
  new link").

**Commit:** `improved: Friendlier splash, offline, and invite screens`

---

# PHASE 10 — Accessibility floor (D-A11Y) (FINAL, adopted from both reviews)

Prod's numbers: `accessibilityLabel`/`accessibilityRole` appear in only TWO `src/ui`
files, and `grep reduceMotion` finds nothing. This phase is a sweep, not a redesign —
layouts stay as the earlier phases built them.

## Task 10.1 — Labels, roles, and focus order

**Files:** every screen; start with `src/ui/primitives.tsx` (give `IconButton`,
`Chip`, `Touchable` required/derived `accessibilityLabel` + `accessibilityRole` props so
the sweep is mostly mechanical).

**Do this:** every icon-only control gets a VoiceOver/TalkBack label in a logical focus
order; toggles and segments announce their state; deep-linked controls (settings search,
notifications) take focus on arrival. The player transport gets explicit labels
("Play", "Skip back 30 seconds", …) and the play button a "play · pause" state.

**Verify:** with TalkBack/VoiceOver on, you can play a book, set a sleep timer, and
change a setting without sight.

**Commit:** `improved: Screen readers can drive the whole app`

## Task 10.2 — Reduce Motion fallbacks

**Files:** `src/ui/motion.tsx` (add a `useReducedMotion()` gate that all helpers
respect), `EmberBurst.tsx`, `CoverGlow.tsx`, carousel + splash call sites.

**Do this:** honoring the OS Reduce Motion setting — EmberBurst renders a single static
frame, CoverGlow stops breathing (static wash), the carousel drops parallax, shelf
staggers collapse to one 120ms fade, Focus view enters by cross-fade, the scrubber glow
is static, buffering is text not a spinning ring, and the splash uses the Task 9.4
static variant. Numbers and layouts identical — only motion is dropped.

**Verify:** flip Reduce Motion in OS settings → no looping animation anywhere; finish a
book and confirm the static "Finished" state still shows with its Undo toast.

**Commit:** `improved: The app respects Reduce Motion everywhere`

## Task 10.3 — Dynamic Type + color-never-alone

**Files:** screens with fixed-height text blocks (player title line, hero, tiles);
`SyncStatusIcon.tsx`, leaderboard/compare rows in `stats.tsx`.

**Do this:** text reflows up to the app's `MAX_FONT_SCALE` without clipping — the player
title line marquees, the Home hero clamps to 2 lines then truncates, tiles grow
vertically while art stays fixed, book-detail secondary actions wrap below the primary
CTA on compact widths. And color never carries meaning alone: sync uses distinct cloud
SHAPES (done / syncing / off), rank movement uses arrows, dispel/status chips keep their
icons.

**Verify:** at 200% font scale nothing clips or overlaps on Home, player, book detail,
and Stats; grayscale-filter screenshots still communicate sync + rank states.

**Commit:** `improved: Large text and color-blind friendly across the app`

---

# Wrap-up checklist (after all phases)

- [ ] Every screen visually matches its `docs/redesign/*-Final.html` frame (side-by-side
      pass; `02-library.html` for Library).
- [ ] No hardcoded hex anywhere new (search for `#` in your diffs; use tokens).
- [ ] No edits under `packages/core` (git status clean there).
- [ ] Loading/empty/error/offline states exist on every screen that fetches (D-STATES).
- [ ] Playing a book is one tap from Home, Library, Search, and See-all (D-PLAY).
- [ ] The owning tab stays lit on every pushed route (D-NAV).
- [ ] Finishing a book is one tap with an Undo/Edit-date toast (D-FINISH).
- [ ] The player shows exactly ONE row below the transport; cover ≥ ~336px equivalent.
- [ ] TalkBack/VoiceOver can drive playback; Reduce Motion kills every loop; 200% text
      doesn't clip (D-A11Y, Phase 10).
- [ ] Sign-in stays dark; Focus view ≠ Car mode (phone never becomes a driving UI).
- [ ] Run the app on both a real Android build and iOS (or simulator) — native changes
      (new deps, if any) require a rebuild, JS-only changes just reload Metro.
- [ ] Do NOT push. Leave the commits local for review.

## If you get stuck

- The mockup is the spec. Re-read the matching page's annotations and legend.
- The teardown cards on each page explain *why* each change exists — if a change feels
  pointless, the "Teardown" column tells you the problem it solves.
- If a task appears to need a change in `packages/core` / `@hearthshelf/core`, STOP and
  ask a human — that's a separate repo with its own release process.
