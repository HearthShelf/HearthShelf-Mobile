## Context

`/api/me/listening-sessions` is ABS-native, offset-paged, and returns
`{sessions, total, page, numPages}`. Mobile's `getRecentSessions`
(`src/api/abs.ts:450`) hardcodes `page=0` and returns only `data.sessions`, so
the envelope is thrown away. Its existing callers
(`src/player/sessionCache.ts`, the item and player screens) pass no arguments,
so widening the signature is safe.

Formatting is already shared: `fmtSessDate` returns `{day, time}` with
Today/Yesterday/weekday/date handling, and `formatTimestamp` gives H:MM:SS
(`packages/core/src/lib/format.ts`). `DeviceKindIcon` exists on mobile.

The day-grouping loop is duplicated inline in both web `SessionsPage.tsx`
copies - about eight lines each.

Finished-book history is the gap. HearthShelf's own `book_completions` table
(`HearthShelf/server/db.js:547`) holds `media_item_id`, `completions` and
`last_finished_at` per user, and is durable. But it surfaces only as a single
"most re-read" badge (`getMostReReadForUser`,
`server/lib/bookCompletionsStore.js:89`) and as day/month aggregates via
`/hs/stats/history`. Neither can list finished books.

## Goals / Non-Goals

**Goals:**
- Both questions answered: what I listened to, what I finished.
- Correcting a bad session, which mobile can already do at the API layer.
- Move the grouping loop into core rather than writing a third copy.

**Non-Goals:**
- Filtering or searching history.
- Editing anything but a session's duration - the ABS ingest honours nothing
  else.
- Replacing the Stats tab. Stats answers "how much"; History answers "what".

## Decisions

### Infinite scroll, not page controls

The endpoint is offset-paged, so either model works. Prev/Next is a desktop
idiom; a phone list loads more at the bottom. `FlatList`'s `onEndReached` gives
this directly.

Worth knowing: **mobile has no `onEndReached` anywhere today.** Every existing
list either loads one page or fetches everything with `limit=0`. This is the
app's first paginated list, so its loading, error and end-of-list states are new
ground rather than a copy of an existing pattern.

### Summary tiles must state their scope

With infinite scroll, a tile reading "38h" is a lie that grows as you scroll.
Only the session *count* is a real total, because the server reports it. The
derived figures either say "so far" or do not ship. The spec requires the
distinction rather than prescribing the wording.

### Books needs a new endpoint; do not fake it client-side

The tempting shortcut is deriving finished books from the library:
`ABSMediaProgress` has `isFinished`. But it carries only `lastUpdate`, not a
finish timestamp - so a client-side version gives "finished, at some point",
with no reliable date, no month grouping and no re-read count. That is a
different, worse feature wearing the same name.

`/hs/completions` is a close sibling of the existing `getMostReReadForUser`
query: same table, ordered by `last_finished_at DESC`, paginated, without the
`completions >= 2` filter. Small, but it is server work in another repo - which
is why the Books segment can land after Sessions rather than blocking it.

### Grouping goes to core

Third copy of the same eight lines. The complication is that the web wants
`{day, rows}` and a RN `SectionList` wants `{title, data}`, so the helper should
return a shape both can adapt cheaply, or be parameterised. Worth resolving in
the core change rather than after.

### Sessions can ship without Books

The toggle only appears once there is something to toggle to. Shipping
Sessions-only is a coherent screen; the segment control arrives with the
endpoint.

## Risks / Trade-offs

- **First paginated list in the app.** Whatever this establishes for loading,
  error and end states will get copied. Worth doing carefully.
- **Optimistic delete against an infinite list.** Removing a row shifts every
  subsequent page boundary by one, so a later fetch could duplicate or skip an
  entry. Low impact - it self-corrects on refresh - but real, and the reason
  the spec requires totals to derive from the loaded list rather than a
  server-reported figure.
- **The session edit path is load-bearing and undocumented.** ABS has no
  session PATCH; the update re-submits through `/api/session/local` keeping the
  id, relying on that path upserting. If ABS changes it, edits would silently
  insert duplicates. Same exposure the web change carries.
- **`/hs/completions` depends on the ABS db being mounted.** Like the other
  completion-backed features, it degrades on a slim install - hence the spec
  scenario for the books view being unavailable while sessions still work.
