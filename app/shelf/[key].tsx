/**
 * Shelf See-all screen: a pushed route rendering one Home shelf's full item
 * grid (replacing the old 85% bottom sheet). Same tile grammar as Home and
 * Library - tap = detail, quick-play chip = 1-tap audio, long-press = actions
 * sheet. The owning tab (Home) stays lit via the `from` param.
 */
import { useCallback, useRef, useSyncExternalStore } from 'react'
import { FlatList, StyleSheet, View, useWindowDimensions } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { ABSLibraryItem } from '@hearthshelf/core'
import { getHomeShelves, subscribeHomeShelves } from '@/store/homeShelves'
import { getProgressState, subscribeProgress } from '@/store/progress'
import { playItemById } from '@/player/playback'
import { AppText, Centered, IconButton, Screen, icons } from '@/ui/primitives'
import { BookTile } from '@/ui/BookTile'
import {
  BookActionsSheet,
  type BookActionsHandle,
  type BookActionsSource,
} from '@/ui/BookActionsSheet'
import { AppTabBar, tabFromParam } from '@/ui/AppTabBar'
import { Toast, useToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { spacing } from '@/ui/theme'
import { useContentInset } from '@/ui/useContentInset'
import { useColors } from '@/ui/ThemeProvider'
import { adaptiveGridColumns, adaptiveGridTileWidth } from '@/ui/responsive'

export default function ShelfScreen() {
  const router = useRouter()
  const colors = useColors()
  const { key, from } = useLocalSearchParams<{ key: string; from?: string }>()
  const active = tabFromParam(from, 'index')
  const contentInset = useContentInset()
  const { width } = useWindowDimensions()
  const cols = adaptiveGridColumns({ width, minTile: 104, maxCols: 5, gutter: spacing.md })
  const tileWidth = adaptiveGridTileWidth({ width, cols, gutter: spacing.md })

  const shelves = useSyncExternalStore(subscribeHomeShelves, getHomeShelves)
  const shelf = shelves.find((s) => s.id === key) ?? null
  const progressById = useSyncExternalStore(subscribeProgress, getProgressState).byId
  const { message: toast, show: showToast } = useToast()
  const actionsRef = useRef<BookActionsHandle>(null)

  const goToTab = (tabName: string) => {
    router.dismissAll?.()
    router.replace(tabName === 'index' ? '/(tabs)' : `/(tabs)/${tabName}`)
  }

  const openActions = useCallback(
    (item: ABSLibraryItem, source: BookActionsSource, series?: { id: string; name: string }) => {
      haptics.longPress()
      actionsRef.current?.present(
        item,
        getProgressState().byId.get(item.id)?.isFinished === true,
        source,
        series,
      )
    },
    [],
  )

  return (
    <Screen tabBar={<AppTabBar activeName={active} onPressTab={goToTab} />}>
      <View style={styles.header}>
        <IconButton name={icons.back} onPress={() => router.back()} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="hero" numberOfLines={1}>
            {shelf?.label ?? 'Shelf'}
          </AppText>
          {shelf ? (
            <AppText variant="caption" color={colors.textMuted}>
              {shelf.entities.length} {shelf.entities.length === 1 ? 'book' : 'books'}
            </AppText>
          ) : null}
        </View>
      </View>

      {!shelf ? (
        // The published shelves reset when Home reloads; if this key is gone
        // (e.g. after a server switch) there is nothing to render.
        <Centered>
          <AppText variant="meta" color={colors.textMuted}>
            This shelf is no longer available.
          </AppText>
        </Centered>
      ) : (
        <FlatList
          data={shelf.entities}
          keyExtractor={(it) => it.id}
          key={`shelf-${cols}`}
          numColumns={cols}
          columnWrapperStyle={{ gap: spacing.md }}
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingBottom: contentInset,
            gap: spacing.sm,
          }}
          renderItem={({ item }) => {
            const p = progressById.get(item.id)
            const quickPlay = async () => {
              haptics.transport()
              try {
                await playItemById(item.id)
                router.push('/player')
              } catch {
                router.push(`/item/${item.id}?from=${active}`)
              }
            }
            return (
              <BookTile
                item={item}
                width={tileWidth}
                from={active}
                progress={p?.progress}
                finished={p?.isFinished === true}
                onQuickPlay={() => void quickPlay()}
                onLongPress={() =>
                  openActions(item, shelf.source ?? 'browse', shelf.seriesByItemId?.[item.id])
                }
              />
            )
          }}
        />
      )}

      <BookActionsSheet ref={actionsRef} onToast={showToast} />
      <Toast message={toast} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
})
