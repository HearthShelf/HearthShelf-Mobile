## Context

Playlists are ABS-native (`/api/playlists`, `/api/libraries/:id/playlists`).
`ABSPlaylist` and `ABSPlaylistItem` are already in core
(`packages/core/src/types/abs.ts:433-455`).

Mobile has the write half via `AddToListSheet` (`createPlaylist`,
`addItemToPlaylist`, `addItemsToPlaylist` in `src/api/abs.ts`) and no browse.

Both web apps render playlist detail as a list rather than a grid. Self-hosted
draws a `drag_indicator` handle on every row; **nothing is wired to it** - there
is no reorder implementation in either web app.

## Goals / Non-Goals

**Goals:**
- Mobile can browse, open and maintain playlists.
- Episodes read as episodes.
- Share scaffolding with the Collections screens rather than duplicating it.

**Non-Goals:**
- Reordering. See below.
- A second create flow - `AddToListSheet` already has one.
- Cross-client parity work. Unlike Collections, both web apps already browse
  playlists; this change is mobile-only.

## Decisions

### Playlists differ from collections in three ways that matter

Not cosmetic differences:

1. **Ordered.** ABS persists item order, so rows show a position and the list
   must not re-sort.
2. **Private.** `ABSPlaylist` carries a `userId`; collections carry only
   `libraryId`. Deleting a playlist affects one person, which makes its
   confirmation lighter-weight than a collection's.
3. **Can hold an episode.** `ABSPlaylistItem` has an optional `episodeId`
   alongside `libraryItemId`. A collection cannot.

The third is why the detail view is a list of *items*, not a grid of `BookTile`.
A `BookTile` addresses a library item; an episode row needs the episode.

### Do not port the drag handle

Self-hosted draws one and it does nothing. Porting it would ship a control that
lies about what it does - the worst kind of affordance. Reordering is a real
feature (ABS stores the order) but it is a separate change with its own write
path, and this spec explicitly forbids the misleading middle ground.

### Build after Collections

The browse screen, empty state, header and maintenance actions are the same
shape as Collections. If both are scheduled, Collections goes first and this one
reuses its scaffolding. If only one ships, either stands alone.

### `?limit=0` again

`getLibraryPlaylists` has the same truncation bug as the collections list. Same
fix, same reason.

## Risks / Trade-offs

- **`PlaylistRow` is new.** No existing mobile primitive matches it - the
  closest are `QueueSheet`'s rows and the library list mode. Some visual
  drift from those is likely unless the row is built by adapting one.
- **Episode metadata may be thin.** `ABSPlaylistItem` carries `libraryItem`,
  but how much episode detail rides along is worth checking against a real
  server before designing the row's second line. If it is missing, the row may
  need a per-episode lookup - which would change this from a cheap screen to a
  moderate one.
- **Renumbering after a removal is display-only.** The positions shown are
  derived from list order, not stored ranks; removing an item renumbers what is
  on screen and the server's own order is unaffected beyond the removal.
