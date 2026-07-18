# V3 production-beta audit

Baseline: the current `HearthShelf-Mobile` checkout on 2026-07-14 (`package.json` 0.0.2). This pass treats the implemented React Native routes and shared UI components as existing product behavior. V1 remains the consultant proposal; v2 remains Claude's proposal; v3 is now limited to changes that are still useful after inspecting the beta code.

## Corrected decisions

| Surface | Current beta implementation | V3 decision after code review |
| --- | --- | --- |
| Home | The artwork bleeds into the safe area. `PlayerHero` owns active playback on Home; `MiniPlayerDock` deliberately hides on `/`. Stats, releases, clubs, and shelves already follow the hero. | Keep the live hero and its playback controls. Add an overlay utility row for active server/library context, global Search, and Downloads. Do not add a second playback surface. |
| Library & Search | Library already has local search, view modes, sort/filter/display sheets, selection, offline fallback, responsive columns, and an A-Z rail on title-sorted grids. Global Search already includes optional out-of-library results. | Keep the current architecture. Remove the A-Z rail from grid view and reserve it for alphabetical lists. Let an empty library search escalate to global Search without discarding the query. |
| Player | The pushed player already has a collapse button. Artwork-tap playback defaults off. The tab bar remains visible outside immersive mode. Android Auto and CarPlay own the vehicle experience. | Preserve those behaviors. Do not add swipe-to-dismiss. Rename the phone-only immersive presentation to Focus view so it is not confused with vehicle integration. Add discoverable gesture labels and a large-text reflow. |
| Book & Reader | Detail already uses state-dependent section order, a dominant Resume/Start action, visible Finish with date prompt, Read/Download actions, overflow sheets, bookmarks, notes, lightbox, and persistent tabs. | Keep Finish visible and keep its date prompt. On compact widths, wrap the secondary actions below the primary CTA instead of squeezing them or moving completion into overflow. Keep Add to list in overflow. |
| Stats & Clubs | Stats already ships goals, highlights, charts, a heatmap, comparison, and leaderboard. The heatmap is currently a visual-only 11x11 grid. Clubs already ship list, room, progress, spoiler-safe notes, members, history, archive, and delete flows. | Add week selection plus seven accessible dated rows/list view for the heatmap. Keep the current club information architecture; no club redesign is required. |
| Settings | More already uses an account hero, grouped destinations, and descriptions that name the controls inside. Individual settings routes are already real and grouped. | Treat the current More screen as the v3 answer. No new hub controls and no visual redesign. Continue improving labels, focus, and deep-link context inside the existing structure. |
| Sign-in & System | Sign-in is an intentionally dark, branded pre-auth surface with enabled providers, email fallback, username completion, and keyboard avoidance. The connection splash already covers connecting, server choice, no-server, offline, and error phases. | Keep the dark tavern identity. Add explicit accessibility roles/labels, responsive large-text form layout, and a static reduced-motion splash. Do not require a light-mode sign-in. |

## Code evidence

- `app/(tabs)/index.tsx`: `PlayerHero`, `ContinueHero`, stats/release/club shelves.
- `src/player/MiniPlayerDock.tsx`: hides the mini-player on Home and player surfaces.
- `app/(tabs)/library.tsx`: local search, selection, sort/filter/display, offline fallback, responsive grid, current grid A-Z rail.
- `app/search.tsx`: global and out-of-library search.
- `app/player.tsx` and `src/store/settings.ts`: collapse action, artwork-tap default off, immersive mode, native vehicle boundary.
- `app/item/[id].tsx`: state-dependent book detail, Finish prompt, Read/Download, sheets, persistent tabs.
- `app/(tabs)/stats.tsx`: the current 11x11 noninteractive heatmap and the surrounding stats suite.
- `app/club/index.tsx` and `app/club/[id].tsx`: implemented club list, room, progress, notes, members, history, and lifecycle actions.
- `app/(tabs)/more.tsx`: account hero and descriptive grouped destinations.
- `app/sign-in.tsx`, `src/ui/SplashScreen.tsx`, and `app/_layout.tsx`: pre-auth UI and connection states.

## Interpretation rule

`CURRENT BETA — KEEP` means the current implementation is already the recommended v3 direction. `REVISE BETA` means the v3 mockup shows a deliberate change from current code. `RENAME BETA` means the implemented interaction remains while its product language changes. `ACCESSIBILITY PASS` means the layout stays recognizable while interaction semantics, focus, motion, or scaling change. `NO CHANGES` means v3 supplies the required 1:1 comparison without proposing a change.
