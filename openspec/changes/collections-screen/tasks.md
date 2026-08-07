## 1. Mobile API

- [ ] 1.1 Add `?limit=0` to `getLibraryCollections` in `src/api/abs.ts` - without
      it a browse screen silently drops collections past the ABS page size.
- [ ] 1.2 Add `getCollection(id)`, `updateCollection(id, patch)`,
      `deleteCollection(id)`, and remove-book-from-collection.
- [ ] 1.3 Note the body-shape asymmetry in a comment: collection-single takes
      `{id}`, collection-batch takes `{books: [...]}`. It is an easy mis-port.

## 2. Mobile browse screen

- [ ] 2.1 `app/collections/index.tsx`: a 2-column grid, tab bar preserved via
      the `from` param, matching `app/shelf/[key].tsx`'s screen scaffolding.
- [ ] 2.2 `CollectionCard`: 2x2 stack of the first four covers plus a `+N`
      badge. Covers use `Cover`'s `aspectRatio` - book art is 2:3, not square.
- [ ] 2.3 Empty state explaining collections and pointing at the existing create
      flow in `AddToListSheet`.

## 3. Mobile detail screen

- [ ] 3.1 `app/collections/[id].tsx`: book grid reusing `BookTile` and the
      `library.tsx` FlatList recipe (`numColumns` + `key` remount +
      `adaptiveGridTileWidth`).
- [ ] 3.2 Header: name, book count, total duration, Play all.
- [ ] 3.3 Overflow actions: Rename, Delete collection. Long-press a book to
      remove it from the collection.
- [ ] 3.4 Confirmations for delete and remove. Delete names the book count;
      remove names the collection. Neither may read as deleting a book.

## 4. Hosted web parity

- [ ] 4.1 `src/api/absLibrary.ts`: add update / delete / remove-item beside the
      existing `getCollection`.
- [ ] 4.2 `src/pages/CollectionDetailPage.tsx`: add Rename, Delete collection,
      and remove-a-book, matching the self-hosted page's structure so the two
      web copies converge rather than drift further.
- [ ] 4.3 Same confirmation wording as mobile.

## 5. Verify

- [ ] 5.1 Typecheck both repos; prettier on changed files.
- [ ] 5.2 With more collections than one ABS page, confirm all are listed -
      the `limit=0` fix is the point of this check.
- [ ] 5.3 Rename, remove a book, and delete a collection on mobile; confirm each
      persists and that removed books are still in the library.
- [ ] 5.4 Repeat on hosted web; confirm identical actions and wording.
- [ ] 5.5 Confirm a collection maintained on one client reads correctly on the
      other.
