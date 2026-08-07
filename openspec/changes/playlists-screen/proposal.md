## Why

Mobile can add items to a playlist but cannot open one. Same shape as the
Collections gap: you can file something away and never reach it again.

Playlists are close enough to collections to share most of their scaffolding,
but they are not the same thing. A playlist is private (it carries a `userId`),
it is ordered, and it can hold a single podcast episode rather than a whole
book. Those differences decide the layout: an ordered list of items, not a grid
of books.

## What Changes

- A Playlists browse screen: the listener's playlists, each with its name, item
  count and artwork from its items.
- A playlist detail screen: an ordered list of items with their position, cover,
  title, source line and a per-row play control, plus Play all.
- Rename and delete a playlist; remove an item from one.
- Items that are podcast episodes read as episodes, not as books.
- Creating stays in the existing add-to-list flow.

Also fixed in passing: `getLibraryPlaylists` omits `?limit=0` and truncates at
the ABS default page size - the same latent bug as the collections list.

**Not** ported: the drag handle on the web playlist rows. It reorders nothing -
there is no implementation in either web app. See design.md.

## Capabilities

### New Capabilities
- `playlists`: Browsing a listener's playlists, viewing one in order, and
  maintaining it - rename, remove an item, delete.

## Impact

- New: `app/playlists/index.tsx`, `app/playlists/[id].tsx`, a `PlaylistRow`
  component (no existing mobile primitive matches it).
- `src/api/abs.ts`: add `getPlaylist`, `updatePlaylist`, `deletePlaylist`,
  remove-item; add `?limit=0` to `getLibraryPlaylists`.
- Shares the browse-screen scaffolding with `collections-screen`; build that
  first if both are scheduled together.
- No `@hearthshelf/core` change - `ABSPlaylist` and `ABSPlaylistItem` already
  cover this. No server change; endpoints are ABS-native.
