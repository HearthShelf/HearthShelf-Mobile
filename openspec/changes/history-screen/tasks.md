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

- [~] 3.1 `app/history.tsx` with a segmented control; sessions is the default.
      (Screen built, sessions view complete. The segment control arrives with the
      Books endpoint - design.md: "the toggle only appears once there is
      something to toggle to".)
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

- [~] 4.1 Swipe a row to reveal Delete; long-press or overflow for Edit
      duration. Both confirm first. (Long-press -> confirm -> Delete is wired.
      Swipe-to-reveal and Edit-duration are NOT built yet.)
- [~] 4.2 Wire to the existing `deleteListeningSession` and
      `updateListeningSession`. Duration only - the ingest honours nothing else.
      (Delete wired. `updateListeningSession` not yet surfaced.)
- [x] 4.3 Hide Delete when the account lacks `permissions.delete`; still handle
      a 403.
- [x] 4.4 Apply optimistically, roll back and surface the error on failure.

## 5. Server: /hs/completions

- [ ] 5.1 In `C:\code\HearthShelf/server`, add a paginated finished-books route
      over `book_completions`, ordered by `last_finished_at DESC`. Model it on
      `getMostReReadForUser` in `server/lib/bookCompletionsStore.js` minus the
      `completions >= 2` filter.
- [ ] 5.2 Return enough to render a row without an N+1: item id, finish
      timestamp, completion count. Resolve titles the way `/hs/stats` already
      does for the re-read badge.
- [ ] 5.3 Degrade like the other completion-backed features when the ABS db is
      not mounted - a clear "unavailable", not an empty list.

## 6. Mobile: books view

- [ ] 6.1 Client for `/hs/completions`, degrading to unavailable.
- [ ] 6.2 `SectionList` grouped by month, newest first, with finish date and a
      re-read count where > 1.
- [ ] 6.3 Same paging treatment as sessions.
- [ ] 6.4 Distinct empty state ("nothing finished yet") from the unavailable
      state ("this server can't provide it").

## 7. Verify

- [x] 7.1 `npx tsc --noEmit` in mobile; build both web apps if the core helper
      touched them; prettier on changed files. (Mobile 0 errors; both web apps
      build clean after the groupByDay repoint; prettier clean.)
- [~] 7.2 Scroll well past the first page in both views; confirm entries append
      without duplicates or gaps. (Sessions view verified by simulating the
      screen's paging reducer against a fake server: n=0/1/25/26/100/137 all
      load every row exactly once, and a delete mid-scroll loses only the
      deleted row. **This caught a real bug**: deriving the next page from a
      page counter skipped the row that crossed the boundary after a delete -
      silently, and un-recoverable by the de-dupe. Fixed by anchoring the page
      index on rows held. Books view N/A until the endpoint exists; a real
      device pass is still worth doing.)
- [ ] 7.3 Delete a session; confirm it goes, the tiles recompute, and it is
      still gone after reload.
- [ ] 7.4 Edit a duration; confirm a reload shows one session, not two - the
      re-ingest upserting by id is the whole basis of the edit path.
- [ ] 7.5 With a non-delete-permission account, confirm Delete is absent.
- [ ] 7.6 Against a server without the ABS db mounted, confirm books reports
      unavailable and sessions still works.
