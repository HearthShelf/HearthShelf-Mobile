---
target: Library
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 2
target_identity: "file:C:\\code\\HearthShelf-Mobile\\app\\(tabs)\\library.tsx"
target_fingerprint: "sha256:a4f81ffa125274887671892c82cc3925bc3223bdd8db8af4f3eedfa037fb6a29"
target_path: "C:\\code\\HearthShelf-Mobile\\app\\(tabs)\\library.tsx"
timestamp: 2026-09-06T03-46-27Z
slug: app-tabs-library-tsx
---
Method: dual-agent (A: design review · B: detector + deterministic evidence)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | No result count in Books; Groups shows one, Books doesn't |
| 2 | Match System / Real World | 2 | "Random" is a fixed-seed shuffle; raw enums capitalized; "Select books" under Sort |
| 3 | User Control and Freedom | 4 | Removable chips + Clear all, tap-to-flip, back cancels selection, sheet-back precedence |
| 4 | Consistency and Standards | 2 | Two sort taxonomies; deep-link validator accepts unrenderable sorts |
| 5 | Error Prevention | 3 | Offline fallbacks strong; grid onScrollToIndexFailed hardcodes 2:3 cover aspect |
| 6 | Recognition Rather Than Recall | 2 | Filter values: hundreds of unsearchable rows in a 380px scroller |
| 7 | Flexibility and Efficiency | 4 | Deep-link presets, pinch-resize, tab-reselect-to-top, drag-scrub A-Z |
| 8 | Aesthetic and Minimalist Design | 2 | Five chrome bands (~240px) before first cover, identical visual weight |
| 9 | Error Recovery | 4 | Fixed well - human title, demoted raw message, retry re-arms focus effect |
| 10 | Help and Documentation | 3 | Pinch hint good; the A-Z rail gets no introduction |
| **Total** | | **29/40** | **Good - taxonomy and chrome weight are what's left** |

Up from 27. Error recovery 2 -> 4, user control 3 -> 4. Structure unmoved.

## Design Specificity Verdict

Authored data layer, off-the-shelf control layer. Offline is three distinct
product judgments deep (library resolution :159-168, Books :537-541, Groups
:1393-1396), each surfacing an error only when the fallback is genuinely empty,
with a standing offline chip :813-820. The A-Z rail's every constant traces to a
real device failure (AzRail.tsx:33-45, 167-169, 8-13), and the consumer
compensates via railReserve :659-665. Series rows say something only HearthShelf
can say (:1569-1589).

But the chrome is a Material list-header (:739-776), a generic three-tab settings
tray (:938-958), and textTransform capitalize on raw enum tokens (:1135-1141).
The serif - DESIGN.md's "main structural appearance" - appears twice in 1,912
lines (:1004, :1125). The shelf is set entirely in Inter.

Deterministic scan: detector returns 0 findings on the target file (exit 0). A
src/ui sweep gave 10 design-system-color findings, ALL false positives here -
one is theme.ts:134 (the palette definition file itself), nine are in
GoalCelebration/WhatsNew, neither on this screen's render path. Independently
verified clean: 0 hardcoded colors in 1,911 lines (all via useColors at 11
sites), 0 raw Text (100% AppText), 0 console.*, 0 dead imports of 24 symbols, no
hardcoded grid columns, all four states present with real retry.

Browser overlays: not available (React Native, no web target, no emulator). No
live server started. Deterministic source evidence substituted.

## Priority Issues

[P0] Filter value list unusable at this library's size - and the fix is in this
file. FilterValues :1176-1229 renders every value unbounded, unsearchable,
unindexed in a maxHeight 380 scroller (:1895). 300-500 rows for authors on 715
books. Sheet closes on every pick (:1034) so three filters = three round-trips.
At 1.6x scale the fixed cap halves visible rows. Fix: TextInput above the list;
stop dismissing on pick; pass counts through; or reuse AzRail inside it.
-> /impeccable shape

[P0] Two sort taxonomies, deep-link validator trusts the wrong one.
CURATED_SORTS/MORE_SORTS :366-374 define the tray; SORT_COMMON/SORT_MORE
(libraryFilters.ts:174-175) define what :128-129 accepts. Size and
"Author (Last, First)" are accepted but unrenderable - chip reads "Size", tray
shows nothing active, no way back except picking something else. Silent drift
hazard on the next core bump. Fix: narrow the validator to the tray's lists (one
line) regardless of unification direction. -> /impeccable harden

[P1] Five chrome bands (~240px) before the first cover, all same weight.
:214-245, :739-820, styles :1679-1745. Violates "covers lead; chrome recedes"
and the Thumb Zone Rule - every control is at the top on a one-handed-in-the-dark
app. Code concedes it at :652-653 ("the only thumb-reachable control"). Fix:
collapse header+search+view chips past ~120px, stick the control bar;
differentiate navigation weight from adjustment weight. -> /impeccable layout

[P1] Whole library re-filters and re-sorts on every progress tick. progressOf is
useCallback on [progress] (:564-570); progress is a fresh Map per emission
(:453-456); filtered (:598-601) and sorted (:602-605) both depend on it. Full
715-item recompute per emission even on Title sort. Compounded: all three
FlatLists (:837, :884, :1456) lack windowSize, initialNumToRender,
maxToRenderPerBatch, removeClippedSubviews, and getItemLayout. Fix: depend on
progress only where the sort/filters use it; snapshot order on Progress sort; add
getItemLayout (also makes A-Z jumps exact and retires the :853-862 estimate).
-> /impeccable optimize

[P2] Measured accessibility gaps. Three controls under the floor with no hitSlop:
ctrlIconBtn exactly 38x38 (:773), ctrlChip ~28 high (:740,751), groupSortBtn ~24
high (:1553); Touchable has no default hitSlop. Only 3 accessibility annotations
across ~30 touchable sites (:788, :799, :1215-1217) - multi-select icon, sort
chevron, filter back, chevron-right rows all announce as bare "button", while
IconButton elsewhere in the same file does carry labels. useReducedMotion: ZERO
matches in library.tsx and AzRail.tsx despite DESIGN.md naming it the single
gate. fontSize 10 at :1757 is 1pt under the 11px floor. -> /impeccable audit

## What's Working

1. Offline designed as a mode, three layers deep, each a separate judgment. No
   error while a fallback still has something to show.
2. The A-Z rail is measured, not guessed - and B confirms the discipline is real
   by finding its one lapse: AzRail.tsx:119 inlines POP_SPRING's exact values
   instead of importing them.
3. BookTile's memo comparator (BookTile.tsx:33-47) compares callback PRESENCE not
   identity, because callers pass inline arrows. B found the asymmetry proving it
   deliberate: BookListRow (:1231) is unmemoized, taking 3 inline arrows per row
   (:903-905). Grid path protected, list path not.

## Persona Red Flags

2am one-handed listener: every control but the rail is in the top third (code
admits it, :652-653). Five bands of identical fill pills at 8% hairlines in
11-14px on #1b1a18/OLED black read as a grey smear. The only thing in the thumb
arc (bottom 112, elevation 12, :1775) is a dismissible gesture ad.

715-book power user: the filter drill-in is where they live and where it fails
hardest. No result count in Books. NONE of sort/desc/display/size/filters/
gridCols persist (:483-497) - all component state. The app remembered a dismissed
hint (PINCH_HINT_KEY, :106); it did not remember how you browse.

Large-text user: rail permanently 12px (allowFontScaling false); three unlabeled
icon-only controls; 380px fixed cap on scaling text.

Driver: state never persists, so "the way I browse" never becomes something the
car can inherit.

## Minor Observations

- Data-integrity flag: :530 uses getLibraryItemsPage -> minified=1 (abs.ts:273)
  while getAllLibraryItems is documented as the non-minified path required for
  genres/narrator/series (abs.ts:282-284). Would explain a thin filter tray.
  Verify on device.
- "Random" is a fixed-seed LCG shuffle (:410-418) - same order every render.
- Nested Touchables in the sort chip (:740-750); Android ripple can't distinguish.
- A-Z buckets use itemAuthor (:674), Author comparator uses authorName (:398) -
  multi-author books desync rail letters from visual order.
- GroupsView has a bare "Nothing here yet." (:1423-1431) vs Books' EmptyState.
- AzRail haptics fire before the availability guard (AzRail.tsx:84 vs :85).
- Library switcher counts load only on sheet open (:280-287).
- Rotation with manualGridCols clamps rather than re-derives (:607-613).
- AzRail.tsx:94 uses a 90ms duration matching no DUR token.
- MAX_FONT_SCALE is 1.6 (theme.ts:335); MAX_FONT_SCALE_FIXED is 1.25 (:347).

## Questions to Consider

1. The rail exists because 715 books can't be scrolled. Why does the list of 400
   authors get scrolled?
2. Why does the app remember a dismissed hint but not how you browse?
3. If the shelf itself is entirely Inter, where does the hearthside voice appear?
4. A book in progress shows a 3px bar and no number. What changes if it says
   "4h 12m left" in Geist Mono?
5. Books and Groups share a header and almost nothing else. One screen with four
   modes, or two screens sharing a tab?

## Status (fixed 2026-09-06, commits 6828036..547abd7)

All five priority issues addressed, plus most Minor Observations.

P0 filter drill-in -> search field (pinned outside the scroller, shown above 12
values), per-value counts, dismiss-on-pick removed, no-match state. AzRail was
NOT reused inside the list; search subsumes it and a second rail inside a 380px
sheet would collide with the one behind it. Revisit if search proves
insufficient on device.

P0 sort taxonomy -> deep-link validator now checks SELECTABLE_SORTS (the tray's
own list) rather than core's SORT_COMMON/SORT_MORE. The tray's curation stays
deliberate; the two lists can no longer disagree about what is enterable.

P1 chrome bands -> title+search collapse past HEADER_COLLAPSE_AT=120 with the
band height MEASURED via onLayout (not hardcoded, so it survives 1.6x). ctrlChip
lost its fill so adjustment reads quieter than viewChip navigation.

P1 progress recompute -> filtered/sorted key on progressDep (null unless the
sort is Progress or a progress filter is active), lookup held in a ref so it
never goes stale. All three FlatLists windowed. BookListRow memoized.

P2 -> hitSlop on ctrlIconBtn (38pt) and groupSortBtn (~24pt); accessibility
labels across the control bar, search box, filter back and group sorts;
useEnterAnim() gates entrances on Reduce Motion; ctrlBadgeText 10 -> 11; AzRail
imports POP_SPRING/DUR instead of inlining them.

Minors fixed: Random reseeds (was identical every time), A-Z buckets on
lastName to match the Author comparator, rotation re-derives columns,
LibrarySwitcher loads the active count eagerly, GroupsView gets a real
EmptyState, AzRail haptics moved inside the availability guard, result count
added to the filter chip row.

NOT fixed, deliberately: the two sort UIs (Books chip+sheet vs Groups inline
buttons) remain different shapes for the same job; "comfortable/compact" and the
capitalized raw enums still read as machine tokens; "Select books" still sits in
the Sort tab; the nested Touchables in the sort chip remain (now distinguished
by accessibility labels, but Android's ripple still spans the whole chip); the
serif still appears twice in the file. UNVERIFIED: the minified=1 vs
getAllLibraryItems data-integrity question - needs a device check of whether the
Genre/Series filter groups are deriving from stripped metadata.
