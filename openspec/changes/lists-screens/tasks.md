## 0. Core types

- [x] 0.1 Correct `ABSPlaylistItem` in `HearthShelf-Core/src/types/abs.ts` to
      ABS's real two-shape response: `episodeId?: string` and
      `episode?: ABSPodcastEpisode`, both absent on book entries. Done in
      HearthShelf-Core; consumers pull the submodule.

## 1. Mobile API

- [ ] 1.1 Pass `?limit=0` on `getLibraryCollections` and `getLibraryPlaylists`
      in `src/api/abs.ts`. NOT a truncation fix - ABS already returns everything
      when `limit` is absent. This is parity with hosted web plus insurance
      against the `// TODO: Create paginated queries` in `LibraryController.js`.
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

- [ ] 5.1 `app/playlists/[id].tsx`: ordered list, each row showing position,
      cover, title, source line and a play control. No drag handle. Render in
      server order; do not re-sort.
- [ ] 5.2 Build `PlaylistRow` by adapting an existing row primitive
      (`QueueSheet`'s rows or the library list mode) rather than from scratch,
      so it does not drift visually.
- [ ] 5.3 Header: name, item count, total duration, Play all.
- [ ] 5.4 Branch the row on `item.episode` being present (NOT on
      `episodeId != null` - both keys are absent on book entries). Episode rows
      take title and duration from `episode`; `libraryItem` is the podcast and
      is minified. Mirrors ABS's own `ItemTableRow.vue:100`.
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

- [ ] 8.1 Both web apps: playlist rows render from `libraryItem` and navigate to
      `/book/${libraryItemId}` without consulting `episode`
      (`PlaylistDetailPage.tsx:78`), so an episode shows and opens its podcast.
      Render episode rows from `episode` and route them to the episode.
- [ ] 8.2 Self-hosted: remove the `drag_indicator` handle from playlist rows
      (`PlaylistDetailPage.tsx:80`). Nothing is wired to it.

## 9. Verify

- [ ] 9.1 Typecheck all three repos (`npx tsc --noEmit` on mobile, `npm run
      build` on both web apps); prettier on changed files.
- [ ] 9.2 With a large number of lists, confirm all are listed on every client.
- [ ] 9.3 Rename, remove an item, and delete on mobile for **both** kinds;
      confirm each persists and that removed items are still in the library.
- [ ] 9.4 Confirm playlist order matches the server and survives a reload.
- [ ] 9.5 Confirm an episode item renders as an episode and opens the episode.
- [ ] 9.6 Repeat the maintenance actions on hosted web; confirm identical
      actions and wording.
- [ ] 9.7 Confirm a list maintained on one client reads correctly on another.
