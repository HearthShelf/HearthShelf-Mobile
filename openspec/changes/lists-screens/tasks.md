## 1. Mobile API

- [ ] 1.1 Add `?limit=0` to `getLibraryCollections` and `getLibraryPlaylists` in
      `src/api/abs.ts` - without it a browse screen silently drops lists past
      the ABS default page size.
- [ ] 1.2 Add `getCollection(id)`, `updateCollection(id, patch)`,
      `deleteCollection(id)`, remove-book-from-collection.
- [ ] 1.3 Add `getPlaylist(id)`, `updatePlaylist(id, patch)`,
      `deletePlaylist(id)`, remove-item-from-playlist.
- [ ] 1.4 Comment the body-shape asymmetry - it is an easy mis-port:
      collection-single takes `{id}`, collection-batch takes `{books: [...]}`;
      playlist-single takes `{libraryItemId}`, playlist-batch takes
      `{items: [{libraryItemId}]}`.

## 2. The kind adapter

- [ ] 2.1 Define the descriptor (see design.md): label, labelPlural, icon,
      `itemsOf`, `coverIdOf`, `route`, and the api bundle.
- [ ] 2.2 Write the collection and playlist descriptors against it. Everything
      the two browse screens differ by must fit here - if something does not,
      reassess the seam rather than adding a `kind` branch inside a component.

## 3. Mobile browse screens

- [ ] 3.1 Shared browse surface: 2-column grid, tab bar preserved via the `from`
      param, matching `app/shelf/[key].tsx`'s screen scaffolding.
- [ ] 3.2 `ListCard`: 2x2 stack of the first four covers plus a `+N` badge.
      Covers use `Cover`'s `aspectRatio` - book art is 2:3, not square.
- [ ] 3.3 Empty state per kind, pointing at the existing create flow in
      `AddToListSheet`.
- [ ] 3.4 `app/collections/index.tsx` and `app/playlists/index.tsx` as thin
      routes over the shared surface with their descriptor.

## 4. Mobile collection detail

- [ ] 4.1 `app/collections/[id].tsx`: book grid reusing `BookTile` and the
      `library.tsx` FlatList recipe (`numColumns` + `key` remount +
      `adaptiveGridTileWidth`).
- [ ] 4.2 Header: name, book count, total duration, Play all.
- [ ] 4.3 Overflow: Rename, Delete. Long-press a book to remove it.

## 5. Mobile playlist detail

- [ ] 5.1 **Check an episode item against a real server before building the row**
      - confirm `ABSPlaylistItem.libraryItem` carries enough to render an
      episode's title and its podcast. If it does not, stop and reassess: a
      per-episode lookup changes this screen's cost.
- [ ] 5.2 `app/playlists/[id].tsx`: ordered list, each row showing position,
      cover, title, source line and a play control. No drag handle.
- [ ] 5.3 Build `PlaylistRow` by adapting an existing row primitive
      (`QueueSheet`'s rows or the library list mode) rather than from scratch,
      so it does not drift visually.
- [ ] 5.4 Header: name, item count, total duration, Play all.
- [ ] 5.5 Episode items open the episode, not the podcast.
- [ ] 5.6 Overflow: Rename, Delete. Long-press a row to remove it.

## 6. Shared confirmations

- [ ] 6.1 One confirmation helper for both kinds and both actions.
- [ ] 6.2 Collection delete names the book count and does not read as personal;
      playlist delete reflects that only the listener is affected.
- [ ] 6.3 Remove names the list. Neither action may read as deleting a book or
      episode.

## 7. Hosted web parity

- [ ] 7.1 `src/api/absLibrary.ts`: add update / delete / remove-item beside the
      existing `getCollection`.
- [ ] 7.2 `src/pages/CollectionDetailPage.tsx`: add Rename, Delete, and
      remove-a-book, matching the self-hosted page's structure so the two web
      copies converge rather than drift further.
- [ ] 7.3 Same confirmation wording as mobile.

## 8. Web bug fixes found while specifying

- [ ] 8.1 Both web apps: playlist rows navigate to `/book/${libraryItemId}`
      ignoring `episodeId` (`PlaylistDetailPage.tsx:78`), so an episode opens
      the podcast. Route episode items to the episode.
- [ ] 8.2 Self-hosted: remove the `drag_indicator` handle from playlist rows
      (`PlaylistDetailPage.tsx:80`). Nothing is wired to it.

## 9. Verify

- [ ] 9.1 Typecheck all three repos (`npx tsc --noEmit` on mobile, `npm run
      build` on both web apps); prettier on changed files.
- [ ] 9.2 With more lists than one ABS page, confirm all are listed - the
      `limit=0` fix is the point of this check.
- [ ] 9.3 Rename, remove an item, and delete on mobile for **both** kinds;
      confirm each persists and that removed items are still in the library.
- [ ] 9.4 Confirm playlist order matches the server and survives a reload.
- [ ] 9.5 Confirm an episode item renders as an episode and opens the episode.
- [ ] 9.6 Repeat the maintenance actions on hosted web; confirm identical
      actions and wording.
- [ ] 9.7 Confirm a list maintained on one client reads correctly on another.
