---
target: Library
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 3
p1_count: 2
target_identity: "file:C:\\code\\HearthShelf-Mobile\\app\\(tabs)\\library.tsx"
target_fingerprint: "sha256:4bc701830ee4a16e270bf78d728c2a5d61b123651e1c86bd7efcaa2d6172df24"
target_path: "C:\\code\\HearthShelf-Mobile\\app\\(tabs)\\library.tsx"
timestamp: 2026-09-06T04-49-23Z
slug: app-tabs-library-tsx
---
Method: dual-agent (A: design review · B: detector + deterministic evidence)

Both agents were briefed to treat the six commits of 904602a..547abd7 as
UNREVIEWED code by an author with an incentive to believe it worked, not as
fixes to confirm. That framing produced the P0 crash finding below.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Result count renders only when filters exist; unfiltered library never states its size |
| 2 | Match System / Real World | 2 | "comfortable"/"compact", "View options", sheet tabs are raw enum keys |
| 3 | User Control and Freedom | 3 | Back handling careful; pinch-to-resize has no undo and no reset control |
| 4 | Consistency and Standards | 2 | Two sort UIs; rail padding 28 in Books vs 30 in Groups for the same rail |
| 5 | Error Prevention | 3 | parseViewPrefs validates; nothing prevents a zero-result filter combination |
| 6 | Recognition Rather Than Recall | 2 | The collapse hides the library switcher - scrolled, nothing says which library |
| 7 | Flexibility and Efficiency | 4 | Pinch, rail, persisted prefs, multi-select, deep-links |
| 8 | Aesthetic and Minimalist Design | 2 | Five bands remain; the collapse is a retreat, not a resolution |
| 9 | Error Recovery | 3 | Retry on all paths, but message={error} still passes the raw exception |
| 10 | Help and Documentation | 2 | One pinch hint; nothing explains the rail, the chip flip, or long-press |
| **Total** | | **26/40** | **Down 3 from 29 - the fixes introduced new defects** |

## Design Specificity Verdict

Authored in data model and failure modes; category-interchangeable in chrome.
Authored: A-Z rail keying on the active comparator; offline as a first-class
branch; seriesProgressLabel's owned-only doctrine reasoning about meaning drift;
the filterChipLabel disambiguation. Generic: the five-band header stack, the
Display/Sort/Filter tab sheet, textTransform capitalize on raw enum keys.

BRAND ABSENT: variant="eyebrow" appears TWICE in 2,388 lines (:1310, :1432),
both inside the modal sheet. A user who never opens View-options never sees the
serif on this screen. DESIGN.md calls the eyebrow "the serif's main structural
appearance". A judged the previous "deferred" call on this WRONG.

Detector: 0 findings across library.tsx, AzRail, BookTile, states.tsx. B flags
this as a NULL RESULT, not a pass - everything material was found by source
tracing. tsc exit 0 and eslint exit 0 likewise prove less than they appear:
eslint --print-config shows NO `unused` rule enabled, tsc has no
noUnusedLocals. Two dead imports exist (:75 Centered, :114
adaptiveGridColumns).

Browser overlays: N/A (React Native, no web target). No server started.

## Priority Issues

[P0] THE GENRE FILTER THROWS; SERIES IS SILENTLY EMPTY. Both agents confirmed
independently. library.tsx:753 calls getLibraryItemsPage(id, 0, 0) and
minified=1 is HARDCODED into that function (abs.ts:273). The codebase documents
the consequence itself at abs.ts:282-284: getAllLibraryItems is "NOT minified -
so items carry the full metadata (genres, narrator, series)". Corroborated in
HearthShelf-WebApp/src/api/absLibrary.ts:67-82 where the minified type carries
only {title, authorName, narratorName}.

genres is not merely empty - .flatMap(i => i.media.metadata.genres) over
undefined THROWS TypeError the moment the Genre row is tapped. Hidden by three
things: core types genres as non-optional (types/abs.ts:129) so TS raises
nothing; applyLibraryFilter uses .includes() unguarded while the adjacent tags
case IS guarded with ?? []; and mobile's getLibraryItemsPage returns
data.results RAW with no mapper, where the WebApp normalizes every field
(absLibrary.ts:967-1002) - which is why the WebApp survives the same endpoint.

This was flagged as an open question in the previous critique and search UI was
shipped on top of it anyway. Wrong order.
Fix: non-minified fetch. Guards alone leave both groups permanently empty - a
silent wrong answer rather than a crash. -> /impeccable harden

[P0] PRIMARY NAVIGATION INVISIBLE TO SCREEN READERS - and the a11y commit made
it worse by contrast. viewChip (:266-279, :324) has no role, no state, no label.
Touchable's own doc comment (primitives.tsx:187-189) names this exact failure.
Commit e3e42a5 labeled the sort chip, filter chip, both icon buttons, search
box, filter back and group sorts - every control EXCEPT the navigation. B's
census: 23 Touchables, accessibilityState present EXACTLY ONCE. Also missing on
sheetTab (:1248), segChoice (:1436), SortRow (:1470 - active state is an arrow
glyph and accent color only). -> /impeccable audit

[P0] THE COLLAPSE COMMENT CLAIMS HYSTERESIS THE CODE DOES NOT IMPLEMENT.
:665-670 says "Hysteresis: collapse past the band, restore well before it".
There is ONE threshold: onCollapseChange?.(y > HEADER_COLLAPSE_AT). GroupsView
(:1734) has the same single comparison. The band animates HEIGHT, so every
toggle relayouts the list - a thumb resting near 120px pulses the screen in a
dark room.
Separately B confirmed bandHeight is STRICTLY ONE-SHOT (:246-252,
`if (h > 0 && bandHeight.value === 0)`). onLayout fires again on rotation and
font-scale change and the new height is DISCARDED, so the container multiplies a
stale height and CLIPS TEXT at large font sizes - the precise failure the
measurement was written to prevent.
Third: the collapsing band contains LibrarySwitcher (:302-305), so on a
multi-library server nothing identifies the current library once scrolled.
-> /impeccable adapt

[P1] RESTORED RANDOM SORT GIVES THE IDENTICAL ORDER EVERY LAUNCH. shuffleSeed is
useState(1) (:646) and appears nowhere in ViewPrefs (:465-471), parseViewPrefs
(:476-494) or the save effect (:706-710) - but SELECTABLE_SORTS INCLUDES
'Random' (:516), so it restores. sort='Random', seed=1, forever. This reproduces
the exact bug 547abd7 set out to fix: the fix covered the in-session re-tap
(:953) and missed the restore path. Two features shipped in the same session,
interacting in a way neither commit considered.
Fix: useState(() => Date.now()), or exclude Random from restoration.
-> /impeccable harden

[P1] 12 OF 16 TOUCH TARGETS UNDER 44pt, and one of the two new constants misses.
CTRL_ICON_HITSLOP=6 -> 50pt, CORRECT, comment accurate. GROUP_SORT_HITSLOP=10 ->
43pt, MISSES 44 BY ONE POINT while its comment claims otherwise (needs 13).
Worst: sheetRow at 43pt across FOUR sites (:1290, :1347, :1359, :1470) - every
sort row, filter group and filter value, the primary interaction surface of the
whole sheet. Also viewChip 33 (no hitSlop), libSwitcher 27, filterChip remove 25.
-> /impeccable audit

## What's Working

1. The progress-dependency gating is correct AND is a design fix. B traced it
   for staleness and found none: renderItem calls progressOf directly
   (:1167-1168) and BookTile's comparator compares progress by value
   (BookTile.tsx:38), so tiles repaint every tick regardless of the gate. Only
   ordering/membership is deferred - exactly right.
2. The filter drill-in respects 715 books: search pinned outside the scroller,
   counts through the group's own accessor, no dismiss-on-pick, 12-value
   threshold.
3. Layered back handling respecting modal depth (:263-289, :620-635) - sheet
   wins over selection-clear because both are reachable from the toolbar.

## Persona Red Flags

2am listener: collapse pulses; everything stateful is at the top against the
Thumb Zone Rule; the pinch hint at bottom:112/elevation:12 is the loudest thing
on screen and it's a tooltip about a gesture.

715-book power user: Genre throws, Series empty - the two groups that matter
most at that scale. sheetScroll maxHeight 380 means the FIRST encounter with 500
authors is a six-row window.

Driver: VIEW_PREFS_KEY is device-local AsyncStorage while PRODUCT.md's headline
differentiator is "preferences follow the listener across every surface rather
than being per-client". coverAspect syncs; sort and layout now don't. The commit
subject "The Library now remembers how you like to browse" reads as an
account-level promise it doesn't keep.

Screen-reader user: P0 above, plus the filterChip remove announces TWICE
("Remove filter Genre: Fantasy" then "Remove Genre: Fantasy") - a double
announcement the a11y pass itself introduced.

## Minor Observations

- estRowHeight undershoots ~15px not "a few": TILE_META_HEIGHT=34 assumes two
  caption lines; BookTile renders a 2-line title PLUS a 1-line author.
- onScrollToIndexFailed in list mode uses averageItemLength, which FlatList
  reports as 0 for unmeasured regions - a deep A-Z jump scrolls to offset 0.
- BookTile.tsx:120 hardcodes #fff on the play icon; should be colors.onAccent
  (it sits on an accent-filled chip, so a light accent gives white-on-light).
- AzRail motion is not reduce-motion gated (AzRail.tsx:98,127) - the one motion
  surface in scope that isn't.
- LibrarySkeleton hardcodes height:54 for the control bar, whose real height grew
  when ctrlChip padding increased - the skeleton->content transition now jumps.
- filterCount uses marginLeft:auto in a flexWrap row; with 4+ chips it wraps to
  its own line, orphaned.
- FilterValues count tally allocates 715 Sets + sorts on the sheet open path.
- Random forces desc=false but the chip still renders an up-arrow and announces
  "ascending".
- Rail padding 28 (:1015) vs 30 (:1902) when AZ_RAIL_WIDTH is exported and = 30.
- LibrarySwitcher.loadCounts depends on counts, so the memo does nothing.
- sortItems builds a 9-entry comparator record per call (:495-517).
- groupCovers Cover omits itemId, likely losing offline/downloaded resolution.
- gapLabel called twice per row inside renderItem (:1972, :1974).

## Questions to Consider

1. The comment says hysteresis; the code says one threshold. A found THREE
   comments describing intent rather than behavior in one pass (hysteresis :667,
   "no longer a raw exception" :983, "a few px" :911). A comment describing a fix
   that wasn't made is worse than no comment - it stops the next reader checking.
2. Is the browse preference device-local by decision or convenience? coverAspect
   syncs; sort and layout don't. What is the rule?
3. Was the minified path chosen or inherited? If chosen for payload size, Genre
   and Series should be REMOVED from the curated groups, not left to crash.
4. Two sort UIs was deferred as cosmetic. A user who learns "tap the chip to
   flip" in Books and finds no chip in Series has learned the controls are not a
   system.
5. What does this screen say when it succeeds? 715 books ends in padding.
