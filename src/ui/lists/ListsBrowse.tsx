/**
 * The shared browse surface for both list kinds.
 *
 * Collections and playlists differ here only by their descriptor (see kind.ts),
 * so this component never asks which kind it is rendering. Anything that would
 * require it to ask belongs in the descriptor instead.
 *
 * Screen scaffolding mirrors app/shelf/[key].tsx: a pushed route that keeps the
 * owning tab lit through the `from` param, and the same FlatList grid recipe as
 * library.tsx (adaptive columns + the `key` remount that FlatList requires when
 * numColumns changes).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { FlatList, StyleSheet, View, useWindowDimensions } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { BottomSheetModal } from '@gorhom/bottom-sheet'
import { getLibraries } from '@/api/abs'
import { AppTabBar, tabFromParam } from '@/ui/AppTabBar'
import { AppText, Screen, Touchable } from '@/ui/primitives'
import { EmptyState, ErrorState, SkeletonTile } from '@/ui/states'
import { Icon } from '@/ui/icons'
import { ListCard } from '@/ui/lists/ListCard'
import { BookPickerSheet } from '@/ui/lists/BookPickerSheet'
import type { ListKindDescriptor, ListSummary } from '@/ui/lists/kind'
import { adaptiveGridColumns, adaptiveGridTileWidth } from '@/ui/responsive'
import { useContentInset } from '@/ui/useContentInset'
import { spacing, type Palette } from '@/ui/theme'
import { useColors } from '@/ui/ThemeProvider'

const GUTTER = spacing.md

export function ListsBrowse({ descriptor }: { descriptor: ListKindDescriptor }) {
  const router = useRouter()
  const colors = useColors()
  const s = makeStyles(colors)
  const { from } = useLocalSearchParams<{ from?: string }>()
  const active = tabFromParam(from, 'library')
  const contentInset = useContentInset()
  const { width } = useWindowDimensions()
  const cols = adaptiveGridColumns({ width, minTile: 150, maxCols: 4, gutter: GUTTER })
  const tileWidth = adaptiveGridTileWidth({ width, cols, gutter: GUTTER })

  const [lists, setLists] = useState<ListSummary[] | null>(null)
  const [error, setError] = useState(false)
  // Held so the picker can create into the same library this screen is showing.
  const [libraryId, setLibraryId] = useState<string | null>(null)
  const pickerRef = useRef<BottomSheetModal>(null)

  const load = useCallback(async () => {
    setError(false)
    try {
      const libs = await getLibraries()
      const lib = libs.find((l) => l.mediaType === 'book') ?? libs[0]
      if (!lib) {
        setLists([])
        return
      }
      setLibraryId(lib.id)
      setLists(await descriptor.list(lib.id))
    } catch {
      setError(true)
      setLists([])
    }
  }, [descriptor])

  useEffect(() => {
    void load()
  }, [load])

  const goToTab = (tabName: string) => {
    router.dismissAll?.()
    router.replace(tabName === 'index' ? '/(tabs)' : `/(tabs)/${tabName}`)
  }

  const itemNoun = descriptor.kind === 'collection' ? 'book' : 'item'

  return (
    <Screen tabBar={<AppTabBar activeName={active} onPressTab={goToTab} />}>
      <View style={s.head}>
        <Touchable
          onPress={() => router.back()}
          style={s.iconBtn}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Icon name="arrow-back" size={20} color={colors.text} />
        </Touchable>
        <View style={s.headText}>
          <AppText variant="eyebrow" color={colors.accent}>
            Library
          </AppText>
          <AppText variant="title">{descriptor.labelPlural}</AppText>
        </View>
        <Touchable
          onPress={() => pickerRef.current?.present()}
          disabled={!libraryId}
          style={s.iconBtn}
          accessibilityRole="button"
          accessibilityLabel={`New ${descriptor.label.toLowerCase()}`}
        >
          <Icon name="add" size={24} color={libraryId ? colors.text : colors.textFaint} />
        </Touchable>
      </View>

      {lists === null ? (
        <View style={[s.grid, s.skeletonRow]}>
          {Array.from({ length: cols * 2 }, (_, i) => (
            <SkeletonTile key={i} width={tileWidth} />
          ))}
        </View>
      ) : error ? (
        <ErrorState
          message={`Could not load your ${descriptor.labelPlural.toLowerCase()}.`}
          onRetry={load}
        />
      ) : lists.length === 0 ? (
        <EmptyState
          icon={descriptor.icon}
          title={descriptor.emptyTitle}
          body={descriptor.emptyBody}
        />
      ) : (
        <FlatList
          // FlatList will not re-flow an existing list when numColumns changes,
          // so the key forces a remount on rotation. Same recipe as library.tsx.
          key={`grid-${cols}`}
          data={lists}
          numColumns={cols}
          keyExtractor={(l) => l.id}
          columnWrapperStyle={cols > 1 ? s.col : undefined}
          contentContainerStyle={[s.grid, { paddingBottom: contentInset + spacing.xl }]}
          renderItem={({ item }) => (
            <ListCard
              list={item}
              width={tileWidth}
              icon={descriptor.icon}
              itemNoun={itemNoun}
              onPress={() => router.push(descriptor.route(item.id))}
            />
          )}
        />
      )}

      <BookPickerSheet
        ref={pickerRef}
        descriptor={descriptor}
        libraryId={libraryId}
        mode="create"
        onSubmit={async (books, name) => {
          const made = await descriptor.create(libraryId as string, name, books)
          pickerRef.current?.dismiss()
          // Reload so the new list is there if the user comes straight back.
          void load()
          if (made.id) router.push(descriptor.route(made.id))
        }}
      />
    </Screen>
  )
}

function makeStyles(_c: Palette) {
  return StyleSheet.create({
    head: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
    },
    headText: { flex: 1, gap: 1 },
    iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    grid: { paddingHorizontal: spacing.lg, gap: GUTTER },
    col: { gap: GUTTER },
    skeletonRow: { flexDirection: 'row', flexWrap: 'wrap' },
  })
}
