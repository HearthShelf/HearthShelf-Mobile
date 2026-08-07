## Context

Both kinds are ABS-native, with no HearthShelf backend involvement:

| | Collections | Playlists |
| --- | --- | --- |
| Endpoints | `/api/collections`, `/api/libraries/:id/collections` | `/api/playlists`, `/api/libraries/:id/playlists` |
| Core type | `ABSCollection` (`types/abs.ts:460`) | `ABSPlaylist` (`types/abs.ts:481`) |
| Items field | `books: ABSLibraryItem[]` | `items: ABSPlaylistItem[]` |
| Scope | `libraryId` - library-wide | `libraryId` + `userId` - private |
| Ordered | No | Yes |
| Can hold an episode | No | Yes (`episodeId`) |

Mobile already has the write half for both: `AddToListSheet`
(`src/player/AddToListSheet.tsx`) creates and adds, backed by
`src/api/abs.ts:490-559`. What is missing is everything read-and-maintain.

Both web apps have all four pages. The two web copies have fully drifted from
each other (same line counts, ~200 differing lines each) - the same drift
documented for the admin surfaces.

## Goals / Non-Goals

**Goals:**
- One spec, one shared surface, two backends.
- Mobile can browse and maintain both kinds.
- Hosted web reaches self-hosted's capability for collections.
- The differences that remain are the ones that are actually real.

**Non-Goals:**
- Reordering playlists. ABS stores the order, so this is a real feature - but it
  needs its own write path and belongs in its own change. This spec forbids the
  misleading middle ground of shipping a handle that does nothing.
- A second create flow. Every client already has one in its add-to-list flow.
- Merging the two web repos' copies of these pages. In scope is closing the
  capability gap, not unifying the files.
- RSS feed / Download menu entries. They exist in the self-hosted menu with no
  handler attached, so there is nothing to port.

## Decisions

### The seam is a kind adapter, not a shared component with `if` branches

The browse screens are already the same component. Rather than copy it again,
the shared surface takes a small descriptor:

```
kind: 'collection' | 'playlist'
label / labelPlural / icon      -> chrome
itemsOf(record)                 -> books | items, normalised
coverIdOf(item)                 -> the id artwork is drawn from
route(id)                       -> where a tile navigates
api: { list, get, update, remove, removeItem }
```

Everything the two browse screens differ by today fits in that descriptor. A
component that instead branches on `kind` inside its body would re-introduce the
duplication in a less visible form.

**Where the adapter stops.** The *detail* screens are not the same component and
should not be forced into one. A collection detail is an unordered grid of
`BookTile`; a playlist detail is an ordered list of rows that may address an
episode. Sharing the chrome (header, count, total duration, Play all, overflow
menu, confirmations) is worthwhile; sharing the body is not. Forcing one
component to render both a grid and an ordered list would be the kind of false
reuse that costs more than the duplication it removes.

### Ordering, privacy and episodes are the three real differences

1. **Ordered.** ABS persists playlist order, so rows show a position and the
   list must not re-sort. Collections have no order to preserve.
2. **Private.** `ABSPlaylist` carries `userId`; `ABSCollection` does not.
   Deleting a collection affects everyone on the server; deleting a playlist
   affects one person. The confirmations differ accordingly, and a collection's
   must not imply it is personal.
3. **Episodes.** A playlist entry may address a single podcast episode. This is
   why the playlist body is a list of *items*, not a grid of `BookTile` - a
   `BookTile` addresses a library item, and an episode row needs the episode.

### The two playlist-item shapes (verified against the ABS source)

`Playlist.toOldJSONExpanded()` (`server/models/Playlist.js:347`) emits two
different shapes, and this drives the whole playlist detail row:

```
book:    { libraryItemId, libraryItem }                     // libraryItem EXPANDED
episode: { libraryItemId, libraryItem, episodeId, episode } // libraryItem MINIFIED
```

Three consequences the implementation must honour:

- **`episode` is the discriminator, not `episodeId != null`.** Both keys are
  *absent* on book entries, not null. Our `ABSPlaylistItem` in core declared
  `episodeId: string | null` and omitted `episode` entirely - both wrong, and
  corrected as part of this change.
- **Episode rows must read `episode.title` and `episode.duration`.** The
  sibling `libraryItem` is the *podcast*, so
  `libraryItem.media.metadata.title` is the show's name. ABS's own client does
  exactly this (`client/components/tables/playlist/ItemTableRow.vue:100` -
  `if (this.episode) return this.episode.title`). Rendering the row from
  `libraryItem` is the bug that makes every episode in a playlist show the
  podcast's title.
- **`libraryItem` is minified on episode entries.** Anything a book row reads
  off the expanded shape may simply be missing on an episode row.

This retires the "episode metadata may be thin" risk: `episode` is a full
`toOldJSONExpanded()` payload carrying `title`, `subtitle`, `duration`,
`season`, `episode`, `pubDate` and `audioTrack`. No per-episode lookup is
needed, and the screen stays cheap.

### Cover stacks come from the list response

Both list endpoints return full records including their items, so a grid of
tiles needs no N+1 fetch: take the first four ids for artwork and the length for
the count. Book art is roughly 2:3 - the stack must use `Cover`'s `aspectRatio`
rather than forcing squares.

### `?limit=0` is already the default - pass it anyway, but not urgently

**Corrected against the ABS source.** Both library routes build
`limit: req.query.limit || 0` and then slice only `if (payload.limit)`
(`server/controllers/LibraryController.js:823, 861`). Zero is falsy, so omitting
`limit` returns **everything** - there is no default page size, and no
truncation bug. The earlier framing of this as silent data loss was wrong.

Passing `limit=0` explicitly is still worth doing for parity with hosted web
(`absLibrary.ts:285`) and to pin the behaviour against a future ABS that does
add pagination - both controllers carry a `// TODO: Create paginated queries`
comment. It is a defensive tidy, not a fix, and the verification step should not
claim to be testing a bug.

### Remove-an-item must read as scoped

The dangerous confusion is "remove" meaning "delete the book". Confirmation copy
names the list explicitly, and the spec requires the underlying item stay in the
library. Same reasoning for deleting a collection: the confirmation says how many
books it holds precisely so it is clear they are not being deleted.

### Two bugs found while specifying this, folded in

- **Episode navigation is wrong on web.** `PlaylistDetailPage.tsx:78` navigates
  to `/book/${it.libraryItemId}` without consulting `episodeId`, so an episode
  in a playlist opens the podcast. The spec requires the episode.
- **The drag handle lies.** Self-hosted draws `drag_indicator` on every playlist
  row (`PlaylistDetailPage.tsx:80`) and nothing is wired to it. It should be
  removed, not ported.

## Risks / Trade-offs

- **Three implementations, one spec.** Mobile, hosted web and self-hosted web
  all change, and nothing mechanically keeps them aligned afterwards. The
  adapter helps within a client, not across them; the spec is the shared
  artifact. This is the same exposure the admin surfaces already carry.
- **The adapter could be over-fitted.** It is shaped by exactly two kinds. If a
  third list-like thing appears (a smart//saved filter, say) the descriptor may
  not stretch. Two is enough to justify it and few enough to rewrite cheaply.
- **Collections are library-wide.** Deleting one affects everyone, and ABS does
  not obviously expose a permission for it. This ships without a gate and is
  flagged rather than solved.
- **Playlist order is server-side and must not be re-sorted.** ABS orders items
  by an explicit `order` column (`Playlist.js:81, 305`), so the array arrives in
  the right order and the client's only job is not to disturb it. Position
  numbers are display-only, derived from array index.
- **Optimistic maintenance against a list another client may have changed.**
  Rename/delete are cheap to re-fetch on failure; the risk is a stale list, not
  lost data.
