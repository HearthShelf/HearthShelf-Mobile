/**
 * ABS response shapes - the slice the spike needs.
 * Ported from HearthShelf/src/api/types.ts (kept field-for-field where used).
 */

export interface ABSBookMetadata {
  title: string | null
  titleIgnorePrefix: string
  subtitle: string | null
  authorName: string
  narratorName: string
  seriesName: string
  publishedYear: string | null
  description: string | null
  genres: string[]
  language: string | null
  explicit: boolean
}

export interface ABSBookMedia {
  id: string
  metadata: ABSBookMetadata
  coverPath: string | null
  tags: string[]
  numTracks: number
  numAudioFiles: number
  numChapters: number
  duration: number
  size: number
  ebookFormat?: string
}

export interface ABSLibraryItem {
  id: string
  libraryId: string
  folderId: string
  path: string
  mediaType: string
  media: ABSBookMedia
  addedAt: number
  updatedAt: number
  isMissing: boolean
  isInvalid: boolean
}

export interface ABSLibrary {
  id: string
  name: string
  mediaType: string
}

export interface ABSLibrariesResponse {
  libraries: ABSLibrary[]
}

export interface ABSLibraryItemsResponse {
  results: ABSLibraryItem[]
  total: number
  limit: number
  page: number
  sortDesc: boolean
  mediaType: string
  minified: boolean
}

export interface ABSShelf {
  id: string
  label: string
  type: 'book' | 'series' | 'authors' | 'podcast' | 'episode'
  entities: ABSLibraryItem[]
}

export interface ABSItemsInProgressResponse {
  libraryItems: ABSLibraryItem[]
}

export interface ABSAudioTrack {
  index: number
  contentUrl: string
  mimeType: string
  duration: number
  startOffset: number
}

export interface ABSChapter {
  id: number
  start: number
  end: number
  title: string
}

export interface ABSPlaybackSession {
  id: string
  libraryItemId: string
  displayTitle: string
  displayAuthor: string
  coverPath: string | null
  duration: number
  currentTime: number
  chapters: ABSChapter[]
  audioTracks: ABSAudioTrack[]
}
