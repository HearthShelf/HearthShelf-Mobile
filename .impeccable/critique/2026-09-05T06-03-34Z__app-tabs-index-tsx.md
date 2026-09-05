---
target: Home screen
total_score: 31
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:C:\\code\\HearthShelf-Mobile\\app\\(tabs)\\index.tsx"
target_fingerprint: "sha256:78e5fe4e780ffc38e6e571d04a99be07d83245744cbfb2af1303a58ca62347d1"
target_path: "C:\\code\\HearthShelf-Mobile\\app\\(tabs)\\index.tsx"
timestamp: 2026-09-05T06-03-34Z
slug: app-tabs-index-tsx
---
Method: dual-agent (A: design review · B: detector + deterministic evidence)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 4 | Offline chip with retry, skeleton mirrors real layout, live progress |
| 2 | Match System / Real World | 3 | 11 near-synonymous section labels |
| 3 | User Control and Freedom | 4 | Drag-to-reorder + hide every band; back exits edit before app |
| 4 | Consistency and Standards | 3 | Edit mode replaces whole screen instead of native nav bar |
| 5 | Error Prevention | 3 | Hiding all sections has no warning |
| 6 | Recognition Rather Than Recall | 3 | 26pt queue-peek covers unrecognizable; hero title single-line |
| 7 | Flexibility and Efficiency | 4 | Quick-play chip skips detail screen; tab-reselect scrolls to top |
| 8 | Aesthetic and Minimalist Design | 3 | Ordering, not quantity: Continue Listening sits below Coming soon / Book clubs |
| 9 | Error Recovery | 4 | Names actual server, Retry + downloads escape hatch |
| 10 | Help and Documentation | 2 | Nothing explains QuestGiver or why a book was recommended |
| Total | | 33/40 | Good. REVISED after author review - see Corrections |

## Corrections (author review, 2026-09-05)

TWO FINDINGS WITHDRAWN. Both rested on a premise the author corrected.

1. "The user curated this library so they know what is in it" is FALSE. The
   author has 715 audiobooks and has listened to ~300-400. This is a CATALOG,
   not a reading list. The product frame is "Plex for audiobooks", and
   multi-server users compound it. Recommendation shelves earn their place;
   the original P1 ("cut the default Home") is void. Heuristic 8 rescored 1 -> 3.
   What survives is ORDERING, not quantity: Continue Listening should sit
   directly under the hero, since a wrong hero guess is likelier at 715 books.

2. "The streak card is dead weight" is FALSE. It was judged only in the car
   (where nothing visual works) and at bedtime (its worst moment), never in the
   scene where it operates - opening the app during the day. It is a deliberate
   retention mechanic, the same pattern as messaging streaks and game
   achievements. Withdrawn as a priority issue. Only the degraded rendering
   survives, as a minor: it shows an en-dash offline and on first run.

3. Hero is deliberately ONE book - "resume the last book you were on". The
   "three-book hero" question is withdrawn: a hero showing three things is a
   shelf, not a resume affordance.

SURVIVING ISSUES: font-scale ceiling (P1), header targets (P2), first-run
state (P2). None depended on the withdrawn premises.

## Design Specificity Verdict

Authored above the fold, category-interchangeable below it. The hero forks on live-player vs saved-progress, changing the interaction contract (transport vs single Resume pill). Offline chip sits above the greeting, naming offline as a mode with retry.

Below the hero it becomes Netflix: 11 sections default-on, 7 of them recommendation surfaces, for a product where the user personally acquired every book. The streak card ("streak on the line - listen today to keep it") occupies half the most valuable band; nothing in the brief asks for engagement mechanics.

DETECTOR: unavailable, not clean. Returned [] / exit 0, but only .html/.htm route to the DOM engine; .tsx falls through to a CSS-in-JS scanner and this file uses StyleSheet.create object literals. Verified independently: same detector returns 193 findings on docs/redesign/01-home-Final.html, [] on every RN file tested. Step 1 is non-evidence.

BROWSER: skipped, native RN target, no viewable URL. No overlay exists.

## Priority Issues

[WITHDRAWN] Default Home shelf count - premise invalid, see Corrections.

[P1] MAX_FONT_SCALE = 1.25 caps the named accessibility need (theme.ts:325). Caption maxes at 13.75pt; hero title numberOfLines={1} truncates. Comment admits it exists because containers use fixed pixel sizes. Fix: raise to >=1.6 AND fix hero (minHeight not height, numberOfLines 2, move bottom:56/76 offsets into flex). -> /impeccable adapt

[WITHDRAWN] Streak card - premise invalid, see Corrections. Residual minor:
renders en-dash offline and on first run; show "Start your streak" instead.

[P2] Header targets 38pt, up to five (headerBtn width/height 38, under a comment claiming "44px icon targets"). No hitSlop at 4 call sites. Greeting lacks accessibilityLabel. Fix: 44x44, cut to Search + Arrange. -> /impeccable harden

[P2] Designed first-run empty state never fires. Condition requires shelves.length === 0, but the taste engine "always produces rows - content on first run" (:342). Real first launch: no hero, dashboard of en-dashes. Fix: split condition, add hero-slot first-run card. -> /impeccable onboard

## Persona Red Flags

Dana (car): quick-play chip only when 0 < progress < 1, so a fresh book costs 3 taps not 1.
Sam (dark room, one-handed): five 38pt targets at hardest thumb reach. Continue Listening sits below Coming soon / Book clubs in the default order, so a wrong hero guess costs a scroll.
Ravi (low-vision, max text): 1.25x cap; hero title truncates; progress track 22% white at 4pt over arbitrary art.

## Minor Observations

- Hero Pressable has no grouped accessibilityLabel; VoiceOver reads four fragments.
- "See all" is 11pt muted caption x14; title row already tappable, chevron redundant.
- Offline forces all shelves into recommended-picks, so hiding that section online = shelf-less offline Home.
- getHSStats fire-and-forget: values pop in after paint.
- getLibrarySeries called twice per load; 5 awaits serialized, not Promise.all.
- Vertical axis not virtualized: .map() into ScrollView, every shelf mounts on first render.
- delayLongPress inconsistent: 350 hero / 300 BookTile / 150 editor rows.

## Questions to Consider

- [WITHDRAWN - 715 books, ~300-400 listened. Recommendations earn their place.]
- What would Home look like designed for the car first, then given a screen?
- [WITHDRAWN - the single-book hero is deliberate: "resume the last book you
  were on". Open question is instead whether Continue Listening should sit
  directly under it in the default order.]
- Is MAX_FONT_SCALE 1.25 a typography decision or layout debt? What is the hero that is correct at 2.0x first?
