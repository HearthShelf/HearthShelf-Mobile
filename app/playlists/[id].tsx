/**
 * One playlist: an ordered list of items, which may include podcast episodes.
 *
 * Order comes from the server and is NOT re-sorted here. ABS orders items by an
 * explicit `order` column (Playlist.js:81, 305), so the array arrives correct
 * and this screen's only job is to leave it alone. Position numbers are
 * display-only, derived from the array index.
 *
 * A playlist is private to its owner, so unlike collections there is no
 * permission gate - ABS checks ownership alone (PlaylistController.js:581).
 *
 * ONE SHARP EDGE: ABS deletes the whole playlist when its last item is removed
 * (PlaylistController.removeItem). Removing the final item therefore leaves this
 * screen with nothing to show, so it confirms differently and navigates back.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { BottomSheetModal } from '@gorhom/bottom-sheet'
import type { ABSPlaylist } from '@hearthshelf/core'
import { deletePlaylist, getPlaylist, removeItemFromPlaylist, updatePlaylist } from '@/api/abs'
import { playItemById } from '@/player/playback'
import { ListDetailHeader } from '@/ui/lists/ListDetailHeader'
import { PlaylistRow, resolvePlaylistEntry } from '@/ui/lists/PlaylistRow'
import { RenameListSheet } from '@/ui/lists/RenameListSheet'
import {
  confirmDeleteList,
  confirmRemoveFromList,
  confirmRemoveLastPlaylistItem,
} from '@/ui/lists/confirmations'
import { Screen } from '@/ui/primitives'
import { EmptyState, ErrorState, SkeletonRow } from '@/ui/states'
import { useContentInset } from '@/ui/useContentInset'
import { Toast, useToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

export default function PlaylistDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const colors = useColors()
  const s = makeStyles(colors)
  const contentInset = useContentInset()
  const { message: toast, show: showToast } = useToast()
  const renameSheet = useRef<BottomSheetModal>(null)

  const [playlist, setPlaylist] = useState<ABSPlaylist | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    setError(false)
    try {
      setPlaylist(await getPlaylist(id))
    } catch {
      setError(true)
    }
  }, [id])

  useEffect(() => {
    void load()
  }, [load])

  // Server order, untouched. Resolving each entry decides book-vs-episode once,
  // so the row never has to re-derive it.
  const entries = useMemo(() => (playlist?.items ?? []).map(resolvePlaylistEntry), [playlist])
  const totalSeconds = useMemo(() => entries.reduce((a, e) => a + e.seconds, 0), [entries])

  const rename = async (name: string) => {
    if (!playlist) return
    renameSheet.current?.dismiss()
    const previous = playlist.name
    setPlaylist({ ...playlist, name })
    try {
      await updatePlaylist(playlist.id, { name })
      showToast('Playlist renamed')
    } catch {
      setPlaylist((p) => (p ? { ...p, name: previous } : p))
      showToast('Could not rename that playlist')
    }
  }

  const doDelete = async () => {
    if (!playlist) return
    if (
      !(await confirmDeleteList({
        kind: 'playlist',
        name: playlist.name,
        count: entries.length,
      }))
    )
      return
    try {
      await deletePlaylist(playlist.id)
      router.back()
    } catch {
      showToast('Could not delete that playlist')
    }
  }

  const removeAt = async (index: number) => {
    if (!playlist) return
    const entry = entries[index]
    if (!entry) return
    haptics.longPress()

    // ABS destroys the playlist when the last item goes, so this is really a
    // delete wearing a remove's clothes and has to be confirmed as one.
    const isLast = entries.length === 1
    const ok = isLast
      ? await confirmRemoveLastPlaylistItem({ listName: playlist.name, itemTitle: entry.title })
      : await confirmRemoveFromList({
          kind: 'playlist',
          listName: playlist.name,
          itemTitle: entry.title,
        })
    if (!ok) return

    const snapshot = playlist
    setPlaylist({
      ...playlist,
      items: playlist.items.filter((_, i) => i !== index),
    })
    try {
      await removeItemFromPlaylist(playlist.id, entry.libraryItemId, entry.episodeId)
      if (isLast) {
        router.back()
        return
      }
      showToast('Removed from playlist')
    } catch {
      setPlaylist(snapshot)
      showToast('Could not remove that item')
    }
  }

  /**
   * Episodes cannot be played or opened individually yet: this app has no
   * podcast surface at all - no episode route, and playItemById addresses a
   * library item. So an episode row opens its containing podcast's item screen,
   * which is the honest destination available today, and offers no play control
   * rather than one that would start the wrong audio.
   */
  const openEntry = (index: number) => {
    const entry = entries[index]
    if (!entry) return
    router.push(`/item/${entry.libraryItemId}`)
  }

  if (error && !playlist)
    return (
      <Screen>
        <ErrorState message="Could not load that playlist." onRetry={load} />
      </Screen>
    )

  const firstBook = entries.find((e) => !e.isEpisode)

  return (
    <Screen>
      <ListDetailHeader
        kind="playlist"
        name={playlist?.name ?? ''}
        count={entries.length}
        itemNoun="item"
        totalSeconds={totalSeconds}
        onBack={() => router.back()}
        onPlayAll={firstBook ? () => void playItemById(firstBook.libraryItemId) : undefined}
        onRename={playlist ? () => renameSheet.current?.present() : undefined}
        onDelete={playlist ? doDelete : undefined}
      />

      {playlist === null ? (
        <View style={s.body}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : entries.length === 0 ? (
        <EmptyState
          icon="queue-music"
          title="Nothing in here yet"
          body="Add books to this playlist from the actions menu on any book."
        />
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(e, i) => (e.episodeId ?? e.libraryItemId) + ':' + i}
          contentContainerStyle={[s.body, { paddingBottom: contentInset + spacing.xl }]}
          renderItem={({ item, index }) => (
            <PlaylistRow
              entry={item}
              position={index + 1}
              onOpen={() => openEntry(index)}
              onPlay={item.isEpisode ? undefined : () => void playItemById(item.libraryItemId)}
              onLongPress={() => void removeAt(index)}
            />
          )}
        />
      )}

      <RenameListSheet
        ref={renameSheet}
        kind="playlist"
        currentName={playlist?.name ?? ''}
        onSave={rename}
      />
      <Toast message={toast} />
    </Screen>
  )
}

function makeStyles(_c: Palette) {
  return StyleSheet.create({
    body: { paddingHorizontal: spacing.lg, gap: spacing.xs },
  })
}
