## Context

`packages/core/src/lib/questgiver.ts` (363 lines) already holds the whole
engine: `qgBooks`, `qgBuildProfile`, `qgLibraryCandidates`,
`qgExternalSearchTerms`, `qgExternalCandidates`, `qgHeuristic`, `qgCraftPrompt`,
plus every type. It is exported from the barrel and needs no porting.

Endpoints are `/hs/questgiver/*` on the HearthShelf backend: `config`,
`recommend`, `runs` (GET/POST), and an admin config. Mobile's `src/api/absRmab.ts`
already uses the exact auth pattern needed (`${serverUrl}/hs/...` + bearer).

`qgRecommend` wraps the AI call in try/catch and falls through to `qgHeuristic`
on any failure. The config fetch's own fallback is "feature ON, AI OFF". So the
flow is complete without AI; the only thing AI adds is `newPicks` - suggestions
outside the library.

The two web `QuestGiverPage.tsx` copies are near-identical (811 vs 819 lines)
with one behavioural divergence: self-hosted runs the external search when
`lookBeyond` is on; hosted requires `rmabEnabled` too
(`HearthShelf-WebApp/src/pages/QuestGiverPage.tsx:216`).

## Goals / Non-Goals

**Goals:**
- Mobile gets the flow.
- Fix the `lookBeyond` gate rather than porting it.
- Reduce drift: shared behaviour described once, shared logic in core.

**Non-Goals:**
- Rewriting the engine. It works and it is already shared.
- Requiring AI. The heuristic is the floor.
- Merging the two web page components. Converging behaviour is in scope;
  merging 800-line components is its own change.
- Porting the picker's FLIP animation. See below.

## Decisions

### The gate on external search was a bug, not a policy

Hosted requires a connected request backend before searching outside the
library, while its own help text promises Audible suggestions when that backend
is off. So the toggle contradicts itself, and self-hosted already does the right
thing.

Searching and acting are separate concerns. Enabling the option searches; what
you can *do* with a result depends on what is connected. All three clients adopt
the un-gated behaviour.

### One question per screen

Web stacks four steps in a scrolling column, which works on a wide viewport. On
a phone each step gets its own view with a progress indicator. This is a layout
change, not a flow change - the questions, their order, and their options are
unchanged, which is what the spec pins down.

### The weights step shows four genres, with the rest behind an expand

Web renders a slider per owned genre plus the explore genres - on a large
library that is a dozen-plus near-identical controls. On a phone that is a long
scroll of sliders with no sense of which ones matter, and it buries the Continue
button.

Default to the top four by listening, with the rest behind an expand. "Top" is
already computed: `qgBuildProfile` sorts `profile.listened` by score descending
(`packages/core/src/lib/questgiver.ts:181`), where score is
`finished * 2 + started`. So this is a slice, not new ranking logic.

The critical property is that this stays presentational. Web seeds a weight for
*every* genre when the step is first reached and passes the whole map to the run
(`HearthShelf/src/pages/QuestGiverPage.tsx:111-122, 198`). Collapsed genres keep
their seeded weights and still influence the result - the spec pins this down,
because a version that only submitted visible genres would quietly change what
QuestGiver recommends.

Four is a judgement call: enough to feel like real control, short enough that
Continue stays on screen. If it reads thin against a real library, the number
moves; the shape does not.

### Do not port the picker's FLIP animation

`QuestGiverPicker` (157 lines) animates covers flying between the grid and the
selected list using `useLayoutEffect` and measured DOM rects. There is no direct
RN equivalent, and it is decoration. Mobile uses a plain selector; if it wants
motion later, Reanimated's layout animations are the route.

### Consolidation: core is for logic, not components

The instruction to reduce drift cuts a specific way here. The engine is already
shared, so there is nothing to lift. Where the mobile port would otherwise
duplicate genuinely shared *logic* - assembling answers, resolving picks to
items, shaping run history - that goes to core.

What does not go to core is UI. Three renderers for three platforms is correct;
the drift to avoid is behavioural, and the spec is what holds that.

### Run history is per-server, not per-device

`/hs/questgiver/runs` already stores runs server-side; web mirrors to
`localStorage` for offline. Mobile mirrors to its own storage, but the server is
the source of truth so runs follow the listener.

## Risks / Trade-offs

- **The biggest of the four by a distance.** Even with the engine free, this is
  a multi-screen flow with its own state machine. Sequencing it after the other
  three is deliberate.
- **Un-gating external search widens the blast radius on hosted.** More runs
  will now hit the catalog search. It is capped at 30 hits to keep the prompt
  small, but hosted has more concurrent users than a self-hosted box - worth
  watching after release.
- **Feedback storage differs by platform.** Web uses `localStorage`; mobile
  needs an equivalent. If feedback ever needs to influence results server-side
  rather than client-side, this becomes a real design question rather than a
  storage detail.
- **Collapsing weights hides a failure mode.** If the implementation submits
  only the visible genres, QuestGiver still returns plausible-looking picks -
  just subtly worse ones, with no error and nothing obviously wrong on screen.
  It would survive a casual test. Hence the explicit spec scenario and the
  verify step comparing submitted weight maps rather than eyeballing results.
