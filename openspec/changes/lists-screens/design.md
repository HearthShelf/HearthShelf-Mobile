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
3. **Episodes.** `ABSPlaylistItem.episodeId` is optional but real. This is why
   the playlist body is a list of *items*, not a grid of `BookTile` - a
   `BookTile` addresses a library item, and an episode row needs the episode.

### Cover stacks come from the list response

Both list endpoints return full records including their items, so a grid of
tiles needs no N+1 fetch: take the first four ids for artwork and the length for
the count. Book art is roughly 2:3 - the stack must use `Cover`'s `aspectRatio`
rather than forcing squares.

### Fix `?limit=0` as part of this change

Mobile's `getLibraryCollections` and `getLibraryPlaylists` both omit it, so ABS
applies its default page size. Today only `AddToListSheet` calls them and only
reads names, so truncation is invisible. A browse screen turns it into silent
data loss: lists simply missing, no error. Hosted web already passes `limit=0`
(`absLibrary.ts:285`).

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
- **Episode metadata may be thin.** `ABSPlaylistItem` carries `libraryItem`, but
  how much episode detail rides along should be checked against a real server
  before the row's second line is designed. If it is missing, a per-episode
  lookup changes this from a cheap screen to a moderate one - see tasks.
- **Optimistic maintenance against a list another client may have changed.**
  Rename/delete are cheap to re-fetch on failure; the risk is a stale list, not
  lost data.
