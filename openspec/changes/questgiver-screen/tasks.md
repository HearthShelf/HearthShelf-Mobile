## 1. Fix the external-search gate first

- [x] 1.1 In `HearthShelf-WebApp/src/pages/QuestGiverPage.tsx:216`, drop the
      `rmabEnabled` condition on the external candidate search. Enabling the
      option searches; what the listener can do with a result still depends on
      what is connected.
- [x] 1.2 Check the result-card actions still choose correctly with external
      picks present and no request backend - the buy path must appear rather
      than a dead Request button. (Verified by inspection: pick `kind` is
      `rmabEnabled ? 'request' : 'new'`, and `'new'` renders "Find on Audible"
      in `QuestGiverResultCard.tsx:120-126`. Independent of the search gate.)
- [x] 1.3 Confirm the self-hosted copy already behaves this way; align the help
      text in both so it matches what now happens. (Self-hosted was already
      un-gated; help text was already correct and identical in both - the
      search was the bug. Both copies now match.)

## 2. Mobile API client

- [ ] 2.1 `src/api/questgiver.ts` covering `config`, `recommend` and `runs`,
      using the `${serverUrl}/hs/...` + bearer pattern from `src/api/absRmab.ts`.
- [ ] 2.2 Mirror web's fallbacks exactly: `recommend` falls through to
      `qgHeuristic` on ANY failure; config falls back to feature ON / AI OFF.
      These are what make the flow work without a backend.
- [ ] 2.3 Local mirror of runs and feedback in device storage, with the server
      as source of truth.

## 3. The flow

- [ ] 3.1 Screens for the four steps, one question each, with a progress
      indicator and working back navigation that preserves answers.
- [ ] 3.2 Step 1 basis: history vs a chosen set. The chosen-set path needs a
      book selector - plain, no FLIP animation.
- [ ] 3.3 Step 2 direction, with copy derived from the listener's own profile.
- [ ] 3.4 Step 3 weights: sliders via the existing `AppSlider`, showing the top
      four genres from `profile.listened` (already sorted by score) with the
      rest behind an expand.
- [ ] 3.5 Seed weights for EVERY genre on arrival and submit the whole map,
      exactly as web does - collapsed genres must still influence the result.
      A version that submits only visible genres silently changes what
      QuestGiver recommends, and would pass a casual test.
- [ ] 3.6 Hide the expand affordance when there is nothing behind it.
- [ ] 3.7 Step 4 fine-tune: length, familiarity, narrator preference, and the
      look-beyond toggle.
- [ ] 3.8 Running state, then results.

## 4. Results, feedback, history

- [ ] 4.1 Result cards: cover, title, author, reason, and the right action for
      whether the pick is owned.
- [ ] 4.2 Show which engine produced the results.
- [ ] 4.3 Thumbs up/down and a note per pick; persist and feed later runs.
- [ ] 4.4 Past runs view, newest first, expanding to that run's picks.

## 5. Consolidate

- [x] 5.1 Where the port would duplicate shared *logic* (assembling answers,
      resolving picks to items, shaping run history), lift it to
      `C:\code\HearthShelf-Core` instead. Do not lift UI. (Added
      `qgResolvePicks`, `qgRunLabel`, `qgPickKey`; both web pages repointed.
      Verified byte-identical to the replaced inline logic over 42 resolve
      cases + 6 label cases.)
- [~] 5.2 If a core change lands, pull the submodule in every consumer and
      rebuild all three so nothing is left on a stale ref. (Both web apps
      bumped + rebuilt clean. Mobile pending. NOTE: `npm run sync-core` runs
      `git submodule update --remote`, which resets the submodule to
      `origin/main` - it silently reverted a local checkout mid-verification
      here. The core commit must be pushed before consumers can sync normally.)

## 6. Verify

- [ ] 6.1 `npx tsc --noEmit` in mobile; build both web apps after the gate fix;
      prettier on changed files.
- [ ] 6.2 **Run the whole flow with no AI provider configured** and confirm it
      completes with heuristic picks. This is the fallback that makes QuestGiver
      shippable independent of any AI setup.
- [ ] 6.3 Run it with AI configured; confirm the engine badge changes and that
      external picks appear when the option is on.
- [ ] 6.4 With the option on and NO request backend connected, confirm external
      candidates are still searched and the buy action appears - the gate fix.
- [ ] 6.5 Run twice with identical answers - once without touching the weights
      expand, once after expanding - and confirm the submitted weight map is the
      same both times. If collapsed genres were dropped, results would still
      look plausible, which is exactly why this needs checking rather than
      eyeballing.
- [ ] 6.6 Confirm runs made on mobile appear on web and vice versa.
- [ ] 6.7 Walk the flow backwards from step 4 to step 1; confirm no answers are
      lost.
