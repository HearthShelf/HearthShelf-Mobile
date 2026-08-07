## Why

Collections and playlists are the same idea wearing two hats: a named,
hand-built list of things to listen to. Every client treats them as two
unrelated features, and each one is incomplete in a different place:

- **Mobile** can add to both (via `AddToListSheet`) but can browse neither. You
  can file something away and never reach it again.
- **Hosted web** browses collections read-only - no rename, no delete, no
  removing a book - even though ABS supports all three and the account has
  permission.
- **Self-hosted web** has the full set for collections and is the reference.

The two browse screens are already the *same component with the nouns swapped*.
`CollectionsPage.tsx` and `PlaylistsPage.tsx` differ only in labels, one data
accessor (`books` vs `items`) and the route - they share the `coll-grid` /
`coll-card` CSS verbatim. Building them as two features again would triple that
duplication across three clients.

This change treats "a list of things" as one capability with two backends.

## What Changes

**One shared list surface, two kinds.** A single browse screen and a single
maintenance path, parameterised by kind. The kind decides its label, its icon,
its route, how items are read off the record, and which ABS endpoints are
called - nothing else.

**Mobile** gains browse and detail screens for both kinds.

**Hosted web** gains the write actions its collection detail page is missing:
rename, delete, remove a book.

**Both kinds** get rename, delete, and remove-an-item, with confirmations that
never read as deleting the underlying book.

**Where they legitimately differ**, they stay different (see design.md): a
collection is an unordered grid of books; a playlist is an ordered list that can
hold a single podcast episode.

Also fixed in passing:

- Mobile's `getLibraryCollections` and `getLibraryPlaylists` omit `?limit=0`, so
  both truncate at the ABS default page size. Invisible today because only the
  add-to-list sheet calls them and it reads names; a browse screen makes it
  silent data loss.
- Web playlist rows navigate to `/book/${libraryItemId}` regardless of
  `episodeId`, so a podcast episode in a playlist opens the podcast instead of
  the episode.
- Self-hosted's playlist rows draw a `drag_indicator` handle wired to nothing.

## Capabilities

### New Capabilities
- `lists`: Browsing, viewing and maintaining a user's hand-built lists -
  collections (library-wide, unordered, books) and playlists (private, ordered,
  books or episodes).

## Impact

**Mobile** (`C:\code\HearthShelf-Mobile`)
- New: `app/collections/index.tsx`, `app/collections/[id].tsx`,
  `app/playlists/index.tsx`, `app/playlists/[id].tsx`.
- New: a shared `ListCard` (cover stack + `+N`) and the kind adapter.
- New: `PlaylistRow` for the ordered detail list.
- `src/api/abs.ts`: get / update / delete / remove-item for both kinds, plus the
  `?limit=0` fix.
- Reuses `BookTile` and the `library.tsx` FlatList grid recipe.

**Hosted web** (`C:\code\HearthShelf-WebApp`)
- `src/pages/CollectionDetailPage.tsx`: add rename, delete, remove-a-book.
- `src/api/absLibrary.ts`: add the matching writes.

**Self-hosted web** (`C:\code\HearthShelf`)
- Remove the dead drag handle; fix episode navigation.

No `@hearthshelf/core` change - `ABSCollection`, `ABSPlaylist` and
`ABSPlaylistItem` already cover this. No server change; every endpoint is
ABS-native.

## Supersedes

Replaces the separate `collections-screen` and `playlists-screen` changes,
neither of which had been implemented. Their requirements are carried forward
here unchanged in substance; what is new is the shared surface between them.
