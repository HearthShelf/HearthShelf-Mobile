## Why

Collections are a standard Audiobookshelf feature, and every HearthShelf client
handles them differently:

- **Mobile** can add books to a collection (via `AddToListSheet`) but has no way
  to browse one. You can file a book away and never see it again.
- **Hosted web** browses collections read-only. No rename, no delete, no
  removing a book - even though ABS supports all three and the account has
  permission.
- **Self-hosted web** has the full set, and is the reference for what this
  should look like.

That is three different answers to the same question. This change gives mobile a
Collections screen and brings hosted web up to the same capability, so all three
agree.

## What Changes

**Mobile** gains a Collections browse screen (grid of cover-stack tiles) and a
detail screen (book grid, Play all, rename, delete, remove a book).

**Hosted web** gains the write actions its detail page is missing: rename,
delete the collection, and remove a book from it.

Shared to both:

- Renaming and deleting confirm first; delete says how many books are affected.
- Removing a book from a collection removes it from the collection only, never
  from the library.
- Creating a collection stays where it already is - mobile's add-to-list sheet,
  web's existing flow. The browse screens link to it rather than duplicating it.

Also fixed in passing: mobile's `getLibraryCollections` omits `?limit=0`, so it
truncates at the ABS default page size. Invisible today because the add-to-list
sheet only needs names; a browse screen would silently drop collections.

## Capabilities

### New Capabilities
- `collections`: Browsing a library's collections, viewing one, and maintaining
  it - rename, delete, remove a book.

## Impact

**Mobile** (`C:\code\HearthShelf-Mobile`)
- New: `app/collections/index.tsx`, `app/collections/[id].tsx`, a
  `CollectionCard` (2x2 cover stack + `+N`).
- `src/api/abs.ts`: add `getCollection`, `updateCollection`,
  `deleteCollection`, remove-book; add `?limit=0` to `getLibraryCollections`.
- Reuses `BookTile` and the `library.tsx` FlatList grid recipe.

**Hosted web** (`C:\code\HearthShelf-WebApp`)
- `src/pages/CollectionDetailPage.tsx`: add the write actions.
- `src/api/absLibrary.ts`: add update/delete/remove-item alongside the existing
  reads.

No `@hearthshelf/core` change - `ABSCollection` already covers this. No server
change; every endpoint is ABS-native.
