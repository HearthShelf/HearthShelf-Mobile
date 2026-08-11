/**
 * One collection: an unordered grid of books.
 *
 * A collection is library-wide, so renaming or deleting one affects everyone on
 * the server - ABS gates both behind permissions (canUpdate / canDelete,
 * CollectionController.js:447-453) and so does this screen, hiding actions the
 * account cannot perform rather than offering a guaranteed 403.
 *
 * No positions and no ordering are shown: ABS stores an order for collection
 * books, but nothing in the product exposes or promises it, and implying an
 * order that cannot be changed is worse than showing none.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, StyleSheet, View, useWindowDimensions } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { ABSCollection, ABSLibraryItem } from '@hearthshelf/core'
import {
  deleteCollection,
  getCollection,
  getMe,
  removeBookFromCollection,
  updateCollection,
} from '@/api/abs'
import { playItemById } from '@/player/playback'
import { getProgressState, subscribeProgress } from '@/store/progress'
import { useSyncExternalStore } from 'react'
import { BookTile } from '@/ui/BookTile'
import { ListDetailHeader } from '@/ui/lists/ListDetailHeader'
import { RenameListSheet } from '@/ui/lists/RenameListSheet'
import { BookPickerSheet } from '@/ui/lists/BookPickerSheet'
import { COLLECTION_KIND } from '@/ui/lists/kind'
import { confirmDeleteList, confirmRemoveFromList } from '@/ui/lists/confirmations'
import { AppText, Screen, Touchable } from '@/ui/primitives'
import { EmptyState, ErrorState, SkeletonTile } from '@/ui/states'
import { Icon } from '@/ui/icons'
import { adaptiveGridColumns, adaptiveGridTileWidth } from '@/ui/responsive'
import { useContentInset } from '@/ui/useContentInset'
import { Toast, useToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'
import { useRef } from 'react'
import type { BottomSheetModal } from '@gorhom/bottom-sheet'

const GUTTER = spacing.md

export default function CollectionDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const colors = useColors()
  const s = makeStyles(colors)
  const contentInset = useContentInset()
  const { width } = useWindowDimensions()
  const cols = adaptiveGridColumns({ width, minTile: 104, maxCols: 5, gutter: GUTTER })
  const tileWidth = adaptiveGridTileWidth({ width, cols, gutter: GUTTER })
  const progressById = useSyncExternalStore(subscribeProgress, getProgressState).byId
  const { message: toast, show: showToast } = useToast()
  const renameSheet = useRef<BottomSheetModal>(null)
  const pickerSheet = useRef<BottomSheetModal>(null)

  const [collection, setCollection] = useState<ABSCollection | null>(null)
  const [error, setError] = useState(false)
  const [canUpdate, setCanUpdate] = useState(false)
  const [canDelete, setCanDelete] = useState(false)

  const load = useCallback(async () => {
    if (!id) return
    setError(false)
    try {
      setCollection(await getCollection(id))
    } catch {
      setError(true)
    }
  }, [id])

  useEffect(() => {
    void load()
    // Trust the server's own flags - ABS gates these on `permissions.update` /
    // `permissions.delete` with no admin bypass (CollectionController.middleware).
    // Its defaults grant delete to root ONLY, so an `admin ||` bypass here would
    // show admins a Delete the server then 403s.
    void getMe()
      .then((me) => {
        setCanUpdate(me.permissions?.update === true)
        setCanDelete(me.permissions?.delete === true)
      })
      .catch(() => {
        setCanUpdate(false)
        setCanDelete(false)
      })
  }, [load])

  const books: ABSLibraryItem[] = useMemo(() => collection?.books ?? [], [collection])
  const totalSeconds = useMemo(
    () => books.reduce((a, b) => a + (b.media?.duration ?? 0), 0),
    [books],
  )

  const rename = async (name: string) => {
    if (!collection) return
    renameSheet.current?.dismiss()
    const previous = collection.name
    setCollection({ ...collection, name })
    try {
      await updateCollection(collection.id, { name })
      showToast('Collection renamed')
    } catch {
      setCollection((c) => (c ? { ...c, name: previous } : c))
      showToast('Could not rename that collection')
    }
  }

  const doDelete = async () => {
    if (!collection) return
    if (
      !(await confirmDeleteList({
        kind: 'collection',
        name: collection.name,
        count: books.length,
      }))
    )
      return
    try {
      await deleteCollection(collection.id)
      router.back()
    } catch {
      showToast('Could not delete that collection')
    }
  }

  const removeBook = async (book: ABSLibraryItem) => {
    if (!collection) return
    haptics.longPress()
    const title = book.media?.metadata?.title ?? 'This book'
    if (
      !(await confirmRemoveFromList({
        kind: 'collection',
        listName: collection.name,
        itemTitle: title,
      }))
    )
      return
    const snapshot = collection
    setCollection({ ...collection, books: books.filter((b) => b.id !== book.id) })
    try {
      await removeBookFromCollection(collection.id, book.id)
      showToast('Removed from collection')
    } catch {
      setCollection(snapshot)
      showToast('Could not remove that book')
    }
  }

  if (error && !collection)
    return (
      <Screen>
        <ErrorState message="Could not load that collection." onRetry={load} />
      </Screen>
    )

  return (
    <Screen>
      <ListDetailHeader
        kind="collection"
        name={collection?.name ?? ''}
        count={books.length}
        itemNoun="book"
        totalSeconds={totalSeconds}
        onBack={() => router.back()}
        onPlayAll={books.length ? () => void playItemById(books[0].id) : undefined}
        onAddBooks={canUpdate && collection ? () => pickerSheet.current?.present() : undefined}
        onRename={canUpdate && collection ? () => renameSheet.current?.present() : undefined}
        onDelete={canDelete && collection ? doDelete : undefined}
      />

      {collection === null ? (
        <View style={[s.grid, s.skeletonRow]}>
          {Array.from({ length: cols * 2 }, (_, i) => (
            <SkeletonTile key={i} width={tileWidth} />
          ))}
        </View>
      ) : books.length === 0 ? (
        <EmptyState
          icon="collections-bookmark"
          title="Nothing in here yet"
          body={
            canUpdate
              ? 'Search your library and pick the books that belong here.'
              : 'Add books to this collection from the actions menu on any book.'
          }
          cta={canUpdate ? 'Add books' : undefined}
          onCta={canUpdate ? () => pickerSheet.current?.present() : undefined}
        />
      ) : (
        <FlatList
          key={`grid-${cols}`}
          data={books}
          numColumns={cols}
          keyExtractor={(b) => b.id}
          columnWrapperStyle={cols > 1 ? s.col : undefined}
          contentContainerStyle={[s.grid, { paddingBottom: contentInset + spacing.xl }]}
          renderItem={({ item }) => (
            <BookTile
              item={item}
              width={tileWidth}
              progress={progressById.get(item.id)?.progress}
              finished={progressById.get(item.id)?.isFinished === true}
              from="collections"
              onLongPress={canUpdate ? () => void removeBook(item) : undefined}
            />
          )}
          ListFooterComponent={
            canUpdate ? (
              <Touchable
                onPress={() => showToast('Long-press a book to take it out of this collection')}
                style={s.hint}
                accessibilityRole="button"
                accessibilityLabel="How to remove a book"
              >
                <Icon name="info-outline" size={14} color={colors.textFaint} />
                <AppText variant="caption" color={colors.textFaint}>
                  Long-press a book to remove it
                </AppText>
              </Touchable>
            ) : null
          }
        />
      )}

      <RenameListSheet
        ref={renameSheet}
        kind="collection"
        currentName={collection?.name ?? ''}
        onSave={rename}
      />
      <BookPickerSheet
        ref={pickerSheet}
        descriptor={COLLECTION_KIND}
        libraryId={collection?.libraryId ?? null}
        mode="add"
        existingIds={books.map((b) => b.id)}
        onSubmit={async (ids) => {
          if (!collection) return
          await COLLECTION_KIND.addBooks(collection.id, ids)
          pickerSheet.current?.dismiss()
          await load()
          showToast(`Added ${ids.length} ${ids.length === 1 ? 'book' : 'books'}`)
        }}
      />
      <Toast message={toast} />
    </Screen>
  )
}

function makeStyles(_c: Palette) {
  return StyleSheet.create({
    grid: { paddingHorizontal: spacing.lg, gap: GUTTER },
    col: { gap: GUTTER },
    skeletonRow: { flexDirection: 'row', flexWrap: 'wrap' },
    hint: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.lg,
    },
  })
}
