## 1. Fix the external-search gate first

- [ ] 1.1 In `HearthShelf-WebApp/src/pages/QuestGiverPage.tsx:216`, drop the
      `rmabEnabled` condition on the external candidate search. Enabling the
      option searches; what the listener can do with a result still depends on
      what is connected.
- [ ] 1.2 Check the result-card actions still choose correctly with external
      picks present and no request backend - the buy path must appear rather
      than a dead Request button.
- [ ] 1.3 Confirm the self-hosted copy already behaves this way; align the help
      text in both so it matches what now happens.

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
- [ ] 3.4 Step 3 weights: a slider per genre using the existing `AppSlider`.
      **Check this against a real library early** - a dozen-plus sliders on a
      phone may need a more compact control, and finding that out after the flow
      is built around it is expensive.
- [ ] 3.5 Step 4 fine-tune: length, familiarity, narrator preference, and the
      look-beyond toggle.
- [ ] 3.6 Running state, then results.

## 4. Results, feedback, history

- [ ] 4.1 Result cards: cover, title, author, reason, and the right action for
      whether the pick is owned.
- [ ] 4.2 Show which engine produced the results.
- [ ] 4.3 Thumbs up/down and a note per pick; persist and feed later runs.
- [ ] 4.4 Past runs view, newest first, expanding to that run's picks.

## 5. Consolidate

- [ ] 5.1 Where the port would duplicate shared *logic* (assembling answers,
      resolving picks to items, shaping run history), lift it to
      `C:\code\HearthShelf-Core` instead. Do not lift UI.
- [ ] 5.2 If a core change lands, pull the submodule in every consumer and
      rebuild all three so nothing is left on a stale ref.

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
- [ ] 6.5 Confirm runs made on mobile appear on web and vice versa.
- [ ] 6.6 Walk the flow backwards from step 4 to step 1; confirm no answers are
      lost.
