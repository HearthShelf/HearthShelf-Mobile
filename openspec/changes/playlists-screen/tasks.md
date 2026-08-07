## 1. API

- [ ] 1.1 Add `?limit=0` to `getLibraryPlaylists` in `src/api/abs.ts` - same
      truncation bug as the collections list.
- [ ] 1.2 Add `getPlaylist(id)`, `updatePlaylist(id, patch)`,
      `deletePlaylist(id)`, remove-item.
- [ ] 1.3 Note the body-shape asymmetry: playlist-single takes
      `{libraryItemId}`, playlist-batch takes `{items: [{libraryItemId}]}`.

## 2. Browse screen

- [ ] 2.1 `app/playlists/index.tsx`, reusing the Collections browse scaffolding
      (screen shell, `from` param, empty state shape).
- [ ] 2.2 Tile artwork from the playlist's own items; portrait covers via
      `Cover`'s `aspectRatio`.
- [ ] 2.3 Empty state pointing at the existing create flow in `AddToListSheet`.

## 3. Detail screen

- [ ] 3.1 `app/playlists/[id].tsx`: an ordered list, each row showing position,
      cover, title, source line and a play control. No drag handle.
- [ ] 3.2 Build `PlaylistRow` by adapting an existing row primitive
      (`QueueSheet`'s rows or the library list mode) rather than from scratch,
      so it does not drift visually.
- [ ] 3.3 Header: name, item count, total duration, Play all.
- [ ] 3.4 Episode items: identify the episode and its podcast, and open the
      episode rather than the podcast.
- [ ] 3.5 Overflow: Rename, Delete playlist. Long-press a row to remove it.
- [ ] 3.6 Confirmations for delete and remove, worded so neither reads as
      deleting the underlying book or episode.

## 4. Verify

- [ ] 4.1 `npx tsc --noEmit`; prettier on changed files.
- [ ] 4.2 With more playlists than one ABS page, confirm all are listed.
- [ ] 4.3 Confirm item order matches the server and survives a reload.
- [ ] 4.4 **Check an episode item against a real server first** - confirm
      `ABSPlaylistItem.libraryItem` carries enough to render the row. If it does
      not, stop and reassess: a per-episode lookup changes this screen's cost.
- [ ] 4.5 Rename, remove an item, delete a playlist; confirm each persists and
      that removed items remain in the library.
