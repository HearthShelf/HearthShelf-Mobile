/**
 * The list-kind adapter.
 *
 * Collections and playlists are the same idea wearing two hats: a named,
 * hand-built list of things to listen to. Their BROWSE screens are the same
 * screen with the nouns swapped, so rather than write it twice the shared
 * surface takes one of these descriptors and reads everything it needs off it.
 *
 * The rule that keeps this honest: if the browse surface ever needs to ask
 * "which kind am I?", the answer belongs here instead. A component branching on
 * `kind` internally re-introduces the duplication in a less visible form.
 *
 * The adapter deliberately stops before the DETAIL screens. A collection detail
 * is an unordered grid of books; a playlist detail is an ordered list of rows
 * that may address a podcast episode. They share chrome, not a body - forcing
 * one component to render both would cost more than the duplication it removes.
 */
import type { ABSCollection, ABSLibraryItem, ABSPlaylist } from '@hearthshelf/core'
import {
  deleteCollection,
  deletePlaylist,
  getLibraryCollections,
  getLibraryPlaylists,
  updateCollection,
  updatePlaylist,
} from '@/api/abs'
import type { IconName } from '@/ui/icons'

export type ListKind = 'collection' | 'playlist'

/** A list of either kind, reduced to what a browse tile needs. */
export interface ListSummary {
  id: string
  name: string
  /** How many things it holds. */
  count: number
  /** Library item ids for the tile's cover stack, already trimmed by the caller. */
  coverIds: string[]
}

export interface ListKindDescriptor {
  kind: ListKind
  label: string
  labelPlural: string
  icon: IconName
  /** Where a tile navigates. */
  route: (id: string) => string
  /** Fetch every list of this kind in a library, newest ABS order preserved. */
  list: (libraryId: string) => Promise<ListSummary[]>
  rename: (id: string, name: string) => Promise<unknown>
  remove: (id: string) => Promise<void>
  /** Copy for the empty state - what this kind is, and how to make one. */
  emptyTitle: string
  emptyBody: string
}

/** First four cover ids plus the count, from a collection's books. */
function collectionSummary(c: ABSCollection): ListSummary {
  const books: ABSLibraryItem[] = c.books ?? []
  return {
    id: c.id,
    name: c.name,
    count: books.length,
    coverIds: books.slice(0, 4).map((b) => b.id),
  }
}

/**
 * Same for a playlist. The cover for an episode entry is still the containing
 * podcast's library item - an episode has no artwork of its own in ABS - so
 * `libraryItemId` is right for both shapes here.
 */
function playlistSummary(p: ABSPlaylist): ListSummary {
  const items = p.items ?? []
  return {
    id: p.id,
    name: p.name,
    count: items.length,
    coverIds: items.slice(0, 4).map((i) => i.libraryItemId),
  }
}

export const COLLECTION_KIND: ListKindDescriptor = {
  kind: 'collection',
  label: 'Collection',
  labelPlural: 'Collections',
  icon: 'collections-bookmark',
  route: (id) => `/collections/${id}`,
  list: async (libraryId) => (await getLibraryCollections(libraryId)).map(collectionSummary),
  rename: (id, name) => updateCollection(id, { name }),
  remove: deleteCollection,
  emptyTitle: 'No collections yet',
  emptyBody:
    'A collection groups books for everyone on this server. Add one from the actions menu on any book.',
}

export const PLAYLIST_KIND: ListKindDescriptor = {
  kind: 'playlist',
  label: 'Playlist',
  labelPlural: 'Playlists',
  icon: 'queue-music',
  route: (id) => `/playlists/${id}`,
  list: async (libraryId) => (await getLibraryPlaylists(libraryId)).map(playlistSummary),
  rename: (id, name) => updatePlaylist(id, { name }),
  remove: deletePlaylist,
  emptyTitle: 'No playlists yet',
  emptyBody:
    'A playlist is your own ordered queue and can hold single podcast episodes. Add one from the actions menu on any book.',
}
