## 1. Core: day grouping

- [ ] 1.1 In `C:\code\HearthShelf-Core`, add a session day-grouping helper.
      Return a shape that suits both a web list and a RN `SectionList` - resolve
      the `{day, rows}` vs `{title, data}` difference here, not at each call
      site.
- [ ] 1.2 Export from the barrel; push; `git pull origin main` in each
      consumer's `packages/core` and commit the submodule ref.

## 2. Mobile: sessions API

- [ ] 2.1 Widen `getRecentSessions` in `src/api/abs.ts` to take a page and
      return the full envelope (`total`, `page`, `numPages`). Existing callers
      pass no arguments, so a defaulted signature keeps them working - verify
      `src/player/sessionCache.ts` and the item/player screens still compile.
- [ ] 2.2 Normalize the row shape (itemId, title, author, seconds, startedAt,
      device) rather than passing raw ABS field names into the screen.

## 3. Mobile: sessions view

- [ ] 3.1 `app/history.tsx` with a segmented control; sessions is the default.
- [ ] 3.2 `SectionList` grouped by day using the core helper and `fmtSessDate`.
- [ ] 3.3 Rows: cover, title, `DeviceKindIcon` + device, start time, duration.
- [ ] 3.4 `onEndReached` paging with loading, error-with-retry, and end-of-list
      states. **This is the app's first paginated list** - these states set the
      pattern, so build them deliberately.
- [ ] 3.5 Summary tiles: session count from the server's `total`; any derived
      figure labelled as covering what is loaded so far.

## 4. Mobile: session corrections

- [ ] 4.1 Swipe a row to reveal Delete; long-press or overflow for Edit
      duration. Both confirm first.
- [ ] 4.2 Wire to the existing `deleteListeningSession` and
      `updateListeningSession`. Duration only - the ingest honours nothing else.
- [ ] 4.3 Hide Delete when the account lacks `permissions.delete`; still handle
      a 403.
- [ ] 4.4 Apply optimistically, roll back and surface the error on failure.

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

- [ ] 7.1 `npx tsc --noEmit` in mobile; build both web apps if the core helper
      touched them; prettier on changed files.
- [ ] 7.2 Scroll well past the first page in both views; confirm entries append
      without duplicates or gaps.
- [ ] 7.3 Delete a session; confirm it goes, the tiles recompute, and it is
      still gone after reload.
- [ ] 7.4 Edit a duration; confirm a reload shows one session, not two - the
      re-ingest upserting by id is the whole basis of the edit path.
- [ ] 7.5 With a non-delete-permission account, confirm Delete is absent.
- [ ] 7.6 Against a server without the ABS db mounted, confirm books reports
      unavailable and sessions still works.
