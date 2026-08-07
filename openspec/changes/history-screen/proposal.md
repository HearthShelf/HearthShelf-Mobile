## Why

Mobile has no listening history. `getRecentSessions` exists but is hardcoded to
page 0 and throws away the pagination envelope, so it can only ever answer "the
most recent N" - it powers per-book session lists, not a history screen.

Two questions a listener actually asks, and they need different answers:

- *What have I been listening to?* - a session log. Also the only place to fix a
  session that recorded six hours you slept through.
- *What have I finished, and when?* - a completion log. The stats tab shows
  aggregates but never lists the books.

## What Changes

A History screen with two segments.

**Sessions** - every listening session, newest first, grouped by day, with the
book, device and duration. Loads more as you scroll. Swipe a row to delete a
session, or correct its duration.

**Books** - what you finished and when, newest first, grouped by month, with a
re-read count where there is one.

Supporting work:

- `getRecentSessions` gains real paging and returns the server's envelope
  (`total`, `numPages`) instead of discarding it.
- The day-grouping loop moves into `@hearthshelf/core`. Both web apps already
  duplicate it inline; mobile would be the third copy, and a `SectionList` wants
  a different shape than the web's.
- **New backend route `/hs/completions`** in `C:\code\HearthShelf/server`, so
  the Books segment has a data source. See design.md - the data already exists
  and is durable; nothing lists it.

## Capabilities

### New Capabilities
- `history`: The listener's own record of what they have listened to and
  finished - browsing it, and correcting a session that misrecords reality.

## Impact

**Mobile** (`C:\code\HearthShelf-Mobile`)
- New: `app/history.tsx`.
- `src/api/abs.ts`: page-aware sessions fetch; a client for `/hs/completions`.
- Reuses `fmtSessDate`, `formatTimestamp` and `DeviceKindIcon`, all already
  present.

**Core** (`C:\code\HearthShelf-Core`)
- A day-grouping helper shaped for both a web list and a RN `SectionList`.

**Server** (`C:\code\HearthShelf/server`)
- `/hs/completions`: paginated finished-books list over the existing
  `book_completions` table.

Session delete/edit behaviour is specified separately in the WebApp repo's
`session-editing` change, which closes the same gap for both web apps. Mobile
already has those two API functions; this change surfaces them.
