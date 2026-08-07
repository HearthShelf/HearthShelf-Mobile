## Context

Collections are ABS-native (`/api/collections`, `/api/libraries/:id/collections`)
with no HearthShelf backend involvement. `ABSCollection` is already in core
(`packages/core/src/types/abs.ts:427`) and the list response carries each
collection's `books`, so cover-stack artwork needs no extra request.

Mobile already has the write half: `AddToListSheet` creates collections and adds
books to them (`src/player/AddToListSheet.tsx`), backed by
`getLibraryCollections` / `createCollection` / `addBooksToCollection` in
`src/api/abs.ts:488-559`. What is missing is everything read-and-maintain.

Self-hosted web's `CollectionDetailPage.tsx` is the reference implementation:
Play all, rename via a modal, delete behind a confirm. Hosted web's copy of the
same page is read-only.

## Goals / Non-Goals

**Goals:**
- Mobile can browse and maintain collections.
- Hosted web reaches the same capability as self-hosted.
- One spec describing the behaviour both should implement.

**Non-Goals:**
- A second create flow. Both clients already have one.
- Reordering books within a collection - ABS does not model collection order.
- Unifying the two web `CollectionsPage.tsx` copies. In scope is closing the
  capability gap, not merging the files.
- RSS feed and Download entries. They exist in the self-hosted menu with no
  handler attached, so there is nothing to port.

## Decisions

### Cover stacks come from the list response, not per-collection fetches

`getLibraryCollections` already returns full `ABSCollection` objects including
`books`. A grid of tiles needs no N+1 fetch - take the first four ids for
artwork and the length for the count.

### Fix `?limit=0` as part of this change

Mobile's `getLibraryCollections` and `getLibraryPlaylists` omit `limit=0`, so
ABS applies its default page size. Today only `AddToListSheet` calls them and
only reads names, so a truncated list is invisible. A browse screen makes it a
silent data-loss bug: collections simply missing, no error. Hosted web already
passes `limit=0` (`absLibrary.ts:285`); mobile should match.

### Hosted web gets the write actions

Hosted's read-only detail page is not a technical limit - ABS supports the
writes and the same account has permission. Leaving it read-only means a
listener who tidies collections on their phone finds they cannot on the web,
which is exactly the drift this pass is meant to remove.

### Remove-a-book must read as scoped

The dangerous confusion here is "remove" meaning "delete the book". Confirmation
copy names the collection explicitly, and the spec requires that the book stay
in the library. Same reasoning for deleting a collection - the confirmation says
how many books it holds precisely so it is clear they are not being deleted.

### Portrait covers

Book art is roughly 2:3. The mockup's first pass drew square cover stacks, which
stretched every cover. Mobile's `Cover` takes an `aspectRatio`; the stack should
use it rather than forcing squares.

## Risks / Trade-offs

- **Two implementations again.** Mobile and hosted web both change, and nothing
  mechanically keeps them aligned afterwards. The spec is the shared artifact.
- **Collections are library-wide, not per-user.** Unlike playlists, a collection
  has no `userId` - deleting one affects everyone on the server. The confirmation
  should not imply it is personal. Worth considering whether the delete action
  needs a permission gate on shared servers; ABS does not obviously provide one,
  so this ships without it and is flagged rather than solved.
- **Optimistic maintenance against a list that another client may have
  changed.** Rename/delete are cheap enough to re-fetch on failure; the risk is
  a stale list, not lost data.
