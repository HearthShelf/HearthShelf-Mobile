---
target: Library
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 1
target_identity: "file:C:\\code\\HearthShelf-Mobile\\app\\(tabs)\\library.tsx"
target_fingerprint: "sha256:a90fa735799f26e06aaea9c0782f9adb14545481e1e5f4fd6ec7089351f366b4"
target_path: "C:\\code\\HearthShelf-Mobile\\app\\(tabs)\\library.tsx"
timestamp: 2026-09-06T03-16-13Z
slug: app-tabs-library-tsx
---
Method: dual-agent (A: design review · B: detector + deterministic evidence)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | No result count in Books view |
| 2 | Match System / Real World | 3 | DESC_BY_DEFAULT thoughtful; "Comfortable/Compact" describes density not size |
| 3 | User Control and Freedom | 3 | Multi-select exit is a 40pt X; hardware back not wired |
| 4 | Consistency and Standards | 2 | Two sort UIs; A-Z rail follows different rules in Books vs Groups |
| 5 | Error Prevention | 3 | Batch ops confirm; onScrollToIndexFailed has real fallbacks |
| 6 | Recognition Rather Than Recall | 2 | One filter at a time; category hidden ("Sanderson" not "Author: Sanderson") |
| 7 | Flexibility and Efficiency | 3 | Deep-link presets, pinch-resize; no saved view state |
| 8 | Aesthetic and Minimalist Design | 3 | Up to six stacked bands before content |
| 9 | Error Recovery | 2 | Both error paths = raw exception string, no retry; ErrorState unused |
| 10 | Help and Documentation | 3 | Pinch gets a coach mark; long-press-to-select gets nothing |
| Total | | 27/40 | Good - consistency and recovery drag it down |

## Design Specificity Verdict

Specifically authored components, generically authored screen. A-Z rail gesture
engineering anticipates 3 bugs and documents why it uses e.y over locationY;
letterIndex buckets by the active comparator so the rail never lies; BookTile's
memo comparator exists because callers pass inline arrows. But the composition
is not authored for 715 books - the findability answer is "scroll, or leave for
/search", and Title-ascending makes 715 covers into 715 independent lookups.

DETECTOR: unavailable, not clean. [] / exit 0 because only .html/.htm route to
the DOM engine. Zero weight either direction. BROWSER: skipped, native RN.

Agreement: both assessments independently flagged error states + touch targets.
B caught what A missed: ctrlBadge height:17 around 10pt text collides at the new
1.6x cap. A caught what B could not: everything about findability.
Genuine clean result from a check that actually ran: ZERO hardcoded colors in
1854 lines.

## Priority Issues

[P1] Both error paths render a raw exception with no retry. Library resolution
(:199-209) and books load (:681-689) render (e as Error).message in
colors.destructive. ErrorState exists in states.tsx with a Try-again button and
is used on search.tsx; library imports EmptyState + SkeletonTile from the same
module but not ErrorState. Car: dropped wifi = unreadable red string, nothing to
tap. Recovery logic already exists (self-heal on refocus), just not exposed.
-> /impeccable harden

[P2] A-Z rail off in grid view - default state has no navigation. showAzRail
gated on display === 'list' (:628); default is grid (:463) + Title (:461).
~238 rows at 3 cols with no anchor. IMPORTANT: this was a DELIBERATE shipped
decision - commit 48a78d8 "Full-width covers in the grid; A-Z rail lives in list
view", comment marked FINAL. A disagreement with a past call, not a bug. Counter-
argument: the grid path already computes railReserve (:632) and gridPadRight
(:691), so the plumbing is written and switched off; cost is at most one tile
column. -> /impeccable adapt

[P2] Back does not cancel multi-select - Android data loss. Selection lives in
BooksView (:458), back handler in LibraryScreen (:185), so back cannot see it.
Long-press 20 books, hit back, land on Home with selection gone. Mirror problem:
long-press is unhinted while pinch (less important) gets a persisted coach mark.
-> /impeccable harden

[P3] One filter at a time, category hidden. filter is a single string (:460);
second filter silently replaces the first; badge hardcoded to literal 1 (:729);
filterLabel drops the group name. At 715 books "Fantasy" still leaves ~200.
Cheap half: self-describing label + computed badge. Array refactor separable -
chip row already flex-wraps. -> /impeccable clarify then /impeccable shape

[P3] Skeleton reflows on every load. SkeletonTile defaults 2/3 (states.tsx:108),
app default coverAspect is 'square' (settings.ts:328), call site (:1046) passes
no aspectRatio. Portrait placeholders snap to square - in the component whose
comment says it prevents reflow. One-line fix. -> /impeccable polish

## Persona Red Flags

Dana (car): dropped connection + nothing downloaded = unreadable red string, no
tappable recovery. Quick-play only at 0<progress<1, so ~350 unstarted books need
a detour through detail - "find new" is one tap longer than "resume".
Sam (dark room, one-handed): every primary control at top of screen; the only
thumb-reachable affordance (A-Z rail) is the one disabled by default.
Ravi (low-vision): 4 view chips announce identically active or not; ONE
accessibilityLabel in 1854 lines, on a decorative close icon; A-Z rail hard-
disables font scaling at 12pt; ctrlBadge height:17 collides at 1.6x.

## Minor Observations

- "Random" is a pure function of index - same permutation every session. Comment
  says "stable" is intentional, so this is a NAMING problem: it is "Shuffled".
- Any progress update re-sorts all 715 items (sorted recomputes on progressOf).
- Two parallel sort taxonomies; Size and Author (Last, First) deep-linkable but
  unreachable in UI.
- "Select books" row sits inside the SORT tab - an action under a sort taxonomy.
- Filter sheet caps at maxHeight 380 with no search inside; Author group produces
  hundreds of values.
- Sort chip nests a Touchable inside a Touchable - two outcomes ~30px apart.
- 715 books arrive in one limit=0 request. Per project notes this is CORRECT
  documented ABS behavior on /items (unlike /series where limit=0 returns empty),
  so it is deliberate and server-safe. Open question is client-side memory/TTI,
  which neither assessment measured.

## Questions to Consider

- If covers are the content, why is the default order the one thing covers cannot
  express? What if the default sort made the GRID scannable, not the list
  indexable?
- Search navigates away to /search which has the same four scopes and offline
  fallback - so what is Library for? Browsing without a target is exactly what
  alphabetical-grid is worst at.
- Who is the pinch gesture for? It gets a coach mark, clamped range, override ref
  and a full remount per column change; long-press-to-select gets none of that.
- What should this screen say in the car, on a dead cell, with nothing
  downloaded? Right now it says whatever fetch threw.
