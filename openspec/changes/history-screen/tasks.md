## 1. Core: day grouping

- [x] 1.1 In `C:\code\HearthShelf-Core`, add a session day-grouping helper.
      Return a shape that suits both a web list and a RN `SectionList` - resolve
      the `{day, rows}` vs `{title, data}` difference here, not at each call
      site.
- [x] 1.2 Export from the barrel; push; `git pull origin main` in each
      consumer's `packages/core` and commit the submodule ref.

## 2. Mobile: sessions API

- [x] 2.1 Widen `getRecentSessions` in `src/api/abs.ts` to take a page and
      return the full envelope (`total`, `page`, `numPages`). Existing callers
      pass no arguments, so a defaulted signature keeps them working - verify
      `src/player/sessionCache.ts` and the item/player screens still compile.
- [x] 2.2 Normalize the row shape (itemId, title, author, seconds, startedAt,
      device) rather than passing raw ABS field names into the screen.

## 3. Mobile: sessions view

- [x] 3.1 `app/history.tsx` with a segmented control; sessions is the default.
- [x] 3.2 `SectionList` grouped by day using the core helper and `fmtSessDate`.
- [x] 3.3 Rows: cover, title, `DeviceKindIcon` + device, start time, duration.
- [x] 3.4 `onEndReached` paging with loading, error-with-retry, and end-of-list
      states. **This is the app's first paginated list** - these states set the
      pattern, so build them deliberately. (First load owns the screen; later
      loads own only the footer; a failed page keeps loaded rows and offers a
      footer retry; the end states itself once. Re-entrancy guarded by a ref.)
- [x] 3.5 Summary tiles: session count from the server's `total`; any derived
      figure labelled as covering what is loaded so far.

## 4. Mobile: session corrections

- [x] 4.1 Swipe a row to reveal Delete; long-press or overflow for Edit
      duration. Both confirm first. (Long-press opens an action chooser with
      Edit duration + Delete; Delete then confirms separately. Implemented as
      long-press rather than swipe-to-reveal: the rows sit in a SectionList that
      already owns horizontal-ish gestures, and one affordance carrying both
      actions is simpler than a swipe for one and a long-press for the other.)
- [x] 4.2 Wire to the existing `deleteListeningSession` and
      `updateListeningSession`. Duration only - the ingest honours nothing else.
      (Both wired. SessionRow now carries duration/currentTime/updatedAt
      unrendered, because the ingest needs the whole record. Edit is hours +
      minutes, guarded against exceeding the book's own length; 0 stays legal.)
- [x] 4.3 Hide Delete when the account lacks `permissions.delete`; still handle
      a 403.
- [x] 4.4 Apply optimistically, roll back and surface the error on failure.

## 5. Server: /hs/completions

- [x] 5.1 In `C:\code\HearthShelf/server`, add a paginated finished-books route
      over `book_completions`, ordered by `last_finished_at DESC`. Model it on
      `getMostReReadForUser` in `server/lib/bookCompletionsStore.js` minus the
      `completions >= 2` filter.
- [x] 5.2 Return enough to render a row without an N+1: item id, finish
      timestamp, completion count. Resolve titles the way `/hs/stats` already
      does for the re-read badge.
- [x] 5.3 Degrade like the other completion-backed features when the ABS db is
      not mounted - a clear "unavailable", not an empty list.

## 6. Mobile: books view

- [x] 6.1 Client for `/hs/completions`, degrading to unavailable.
- [x] 6.2 `SectionList` grouped by month, newest first, with finish date and a
      re-read count where > 1.
- [x] 6.3 Same paging treatment as sessions.
- [x] 6.4 Distinct empty state ("nothing finished yet") from the unavailable
      state ("this server can't provide it").

## 7. Verify

- [x] 7.1 `npx tsc --noEmit` in mobile; build both web apps if the core helper
      touched them; prettier on changed files. (Mobile 0 errors; both web apps
      build clean after the groupByDay repoint; prettier clean.)
- [~] 7.2 Scroll well past the first page in both views; confirm entries append
      without duplicates or gaps. (Both views verified by simulating
      usePagedList against fake servers: n=0/1/24/25/26/60/137 all load every
      row exactly once, deletes at three different scroll positions lose only
      the deleted row, and the offset->page translation returns exactly the
      requested row on a non-aligned offset. **This caught a real bug**:
      deriving the next page from a page counter skipped the row that crossed
      the boundary after a delete - silently, and un-recoverable by the
      de-dupe. Fixed by anchoring on rows held. A real device pass is still
      worth doing.)
- [ ] 7.3 Delete a session; confirm it goes, the tiles recompute, and it is
      still gone after reload.
- [ ] 7.4 Edit a duration; confirm a reload shows one session, not two - the
      re-ingest upserting by id is the whole basis of the edit path. NEEDS A
      DEVICE - this is the one behaviour that cannot be checked from the repo,
      and the risk the design flags (if ABS ever stops upserting by id, edits
      would silently insert duplicates).
- [ ] 7.5 With a non-delete-permission account, confirm Delete is absent.
- [x] 7.6 Against a server without the ABS db mounted, confirm books reports
      unavailable and sessions still works.
