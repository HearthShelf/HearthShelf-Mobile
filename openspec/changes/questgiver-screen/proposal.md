## Why

QuestGiver is HearthShelf's guided "what should I listen to next" flow: a few
questions, then a matched shortlist. It exists on both web apps and not on
mobile.

It looks like the largest of the four missing screens, and by UI volume it is -
roughly 800 lines of wizard plus five components. But the entire recommendation
engine is already in `@hearthshelf/core` (`lib/questgiver.ts`, 363 lines):
profile building, candidate pools, prompt crafting, and a complete deterministic
recommender. None of that needs porting. What is missing is the asking.

Two things are also wrong today and should be fixed here rather than replicated:

1. **"Look beyond my library" is gated on the request backend in the hosted app**
   but not in self-hosted. The toggle's own help text promises Audible
   suggestions when the request backend is off - so on hosted, it says one thing
   and does nothing. It should work whenever it is on.
2. **The two web copies have drifted** in a handful of small ways with no
   product reason behind them.

## What Changes

- A QuestGiver flow on mobile: four questions, one per screen, then results.
- Results are actionable: play, open details, or - for a pick outside the
  library - a way to get it.
- Past runs are browsable.
- Feedback (thumbs up/down, a note) on a pick, feeding later runs.

Fixed across all three clients:

- **"Look beyond my library" no longer requires the request backend.** When it
  is on, external candidates are searched. What a listener can *do* with an
  external pick still depends on what is connected - request it, or go buy it -
  but the search itself is not gated.

Consolidated rather than re-drifted:

- Anything the mobile port needs that is genuinely shared logic goes to core, not
  into a third copy.
- The two web copies converge on the un-gated behaviour, so all three agree.

## Capabilities

### New Capabilities
- `questgiver`: The guided recommendation flow - the questions asked, how the
  answers become a shortlist, what a listener can do with a result, and how
  feedback and past runs are kept.

## Impact

**Mobile** (`C:\code\HearthShelf-Mobile`)
- New: the flow screens, a results view, a past-runs view, and
  `src/api/questgiver.ts` (auth pattern copied from `src/api/absRmab.ts`).
- Run history and feedback need device storage; web uses `localStorage`.

**Both web apps**
- Remove the request-backend gate on external candidates
  (`HearthShelf-WebApp/src/pages/QuestGiverPage.tsx:216`).
- Converge any drift the mobile port exposes as accidental.

**Core** (`C:\code\HearthShelf-Core`)
- No engine change expected. Any helper the port would otherwise duplicate goes
  here.

**Server** - none. Endpoints exist, and the flow works without AI configured.
