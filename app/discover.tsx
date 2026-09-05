/**
 * Discover: the full taste engine, where Home only previews it.
 *
 * The base shelves come from @hearthshelf/core's buildDiscoverShelves() over the
 * whole library + listening history - pure, deterministic, and offline-capable,
 * so this screen always has content without an AI call. rankDiscoverShelves()
 * then layers the user's feedback on top, the same ordering the web apps use.
 * (Web also feeds it the latest QuestGiver picks; that input is optional and
 * this screen does not wire it in yet.)
 *
 * The monthly AI shelf leads when one exists, and "Popular on your server"
 * tails. Both degrade to nothing when the backend is unreachable.
 *
 * Shelves are published to the shared shelves store on every load so the
 * existing /shelf/[key] See-all screen can render any row's full grid without
 * refetching - the same handoff Home uses.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  FlatList,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { ABSLibraryItem, DiscoverShelf } from '@hearthshelf/core'
import {
  buildDiscoverShelves,
  buildDiscoverSummary,
  discoverCandidates,
  rankDiscoverShelves,
  ignoredItemIds,
} from '@hearthshelf/core'
import { getAllLibraryItems, getLibraries, getLibrarySeries } from '@/api/abs'
import { getDismissalsState } from '@/store/dismissals'
import {
  getDiscoverFeedback,
  getMonthlyShelf,
  getPopular,
  setDiscoverFeedback,
  type DiscoverFeedbackMap,
  type DiscoverVote,
  type MonthlyShelf,
} from '@/api/discover'
import { publishDiscoverShelves } from '@/store/homeShelves'
import { getProgressState, subscribeProgress } from '@/store/progress'
import { playItemById } from '@/player/playback'
import {
  AppText,
  Centered,
  IconButton,
  Screen,
  SectionHeader,
  Touchable,
  icons,
} from '@/ui/primitives'
import { BookTile } from '@/ui/BookTile'
import { DiscoverAiTile } from '@/ui/DiscoverAiTile'
import { DiscoverFeedbackSheet, type DiscoverFeedbackHandle } from '@/ui/DiscoverFeedbackSheet'
import { getRatings, setRating, type RatingMap } from '@/api/ratings'
import {
  BookActionsSheet,
  type BookActionsHandle,
  type BookActionsSource,
} from '@/ui/BookActionsSheet'
import { AppTabBar, tabFromParam, useGoToTab } from '@/ui/AppTabBar'
import { Icon, type IconName } from '@/ui/icons'
import { Toast, useToast } from '@/ui/Toast'
import { EmptyState, Skeleton, SkeletonRow } from '@/ui/states'
import { haptics } from '@/ui/haptics'
import { spacing } from '@/ui/theme'
import { useContentInset } from '@/ui/useContentInset'
import { useColors } from '@/ui/ThemeProvider'
import { adaptiveShelfTileWidth } from '@/ui/responsive'

// Core labels each shelf with a Material Symbols name (what the web apps
// render). This app draws MaterialIcons, so map the handful the taste engine
// emits onto their mobile glyph keys; anything unmapped falls back to sparkle.
const SHELF_ICONS: Record<string, IconName> = {
  recommend: icons.sparkle,
  local_fire_department: icons.flame,
  person: icons.person,
  record_voice_over: icons.person,
  auto_stories: icons.library,
  library_books: icons.book,
  trending_up: icons.stats,
}

function shelfIcon(icon?: string): IconName {
  return (icon && SHELF_ICONS[icon]) || icons.sparkle
}

export default function DiscoverScreen() {
  const router = useRouter()
  const colors = useColors()
  const { from } = useLocalSearchParams<{ from?: string }>()
  const active = tabFromParam(from, 'index')
  const contentInset = useContentInset()
  const { width } = useWindowDimensions()
  const tileWidth = adaptiveShelfTileWidth(width)

  const progressById = useSyncExternalStore(subscribeProgress, getProgressState).byId
  const { message: toast, show: showToast } = useToast()
  const actionsRef = useRef<BookActionsHandle>(null)
  const feedbackRef = useRef<DiscoverFeedbackHandle>(null)

  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [items, setItems] = useState<ABSLibraryItem[]>([])
  const [shelves, setShelves] = useState<DiscoverShelf[]>([])
  const [monthly, setMonthly] = useState<MonthlyShelf | null>(null)
  const [popular, setPopular] = useState<ABSLibraryItem[]>([])
  const [feedback, setFeedback] = useState<DiscoverFeedbackMap>({})
  // Ratings are their own thing now (see src/api/ratings.ts): a rating is about
  // a BOOK, a Discover vote is about a RECOMMENDATION. Separate state, separate
  // endpoint, loaded together only because this screen shows both.
  const [ratings, setRatings] = useState<RatingMap>({})
  // Mirrors `ratings` so a write can snapshot the pre-write value without
  // reading state inside an updater. Kept in step below.
  const ratingsRef = useRef<RatingMap>({})

  useEffect(() => {
    ratingsRef.current = ratings
  }, [ratings])

  const load = useCallback(async () => {
    try {
      setLoadError(false)
      const libs = await getLibraries()
      const lib = libs.find((l) => l.mediaType === 'book') ?? libs[0]
      if (!lib) {
        setItems([])
        setShelves([])
        return
      }
      const all = await getAllLibraryItems(lib.id)
      setItems(all)

      const progressMap = new Map(getProgressState().byId)
      const byId = new Map(all.map((it) => [it.id, it] as const))

      // Feedback feeds the ranking, so fetch it before ranking; it degrades to
      // empty, which just leaves the deterministic base order. QuestGiver picks
      // are the other ranking input on web, but this app has no QuestGiver
      // client yet - rankDiscoverShelves treats them as optional.
      const [fb, rt] = await Promise.all([getDiscoverFeedback(), getRatings()])
      setFeedback(fb)
      setRatings(rt)

      // Books in series the listener ignored - "no interest", so they drop out
      // of every row here while staying in the library and in search. The
      // engine sees no series ids, so resolve the set off /series first.
      let ignoredIds: ReadonlySet<string> = new Set()
      try {
        if (getDismissalsState().seriesIds.length) {
          ignoredIds = ignoredItemIds(await getLibrarySeries(lib.id), {
            ...getDismissalsState(),
            itemIds: [],
          })
        }
      } catch {
        // Leave the set empty - suggestions are unfiltered, not broken.
      }

      const { shelves: base } = buildDiscoverShelves(all, progressMap, ignoredIds)
      const ranked = rankDiscoverShelves(base, byId, { feedback: fb, ignoredIds })
      setShelves(ranked)

      // Publish for the See-all screen, which reads the shared shelves store.
      // Its own bucket, so a Home reload can't drop these rows out from under a
      // back-navigation (and Home's rows survive this publish).
      const published = ranked.map((s) => ({
        id: s.id,
        label: s.label,
        entities: s.items,
        source: 'browse' as BookActionsSource,
      }))
      publishDiscoverShelves(published)

      // The AI shelf and popular row are best-effort garnish on top.
      void getMonthlyShelf(
        buildDiscoverSummary(all, progressMap),
        discoverCandidates(all, progressMap, ignoredIds),
      ).then(setMonthly)
      void getPopular().then((rows) => {
        const resolved = rows
          .map((p) => byId.get(p.itemId))
          .filter((it): it is ABSLibraryItem => Boolean(it))
          .slice(0, 18)
        setPopular(resolved)
        // Re-publish with the popular row included, so its See-all resolves too.
        if (resolved.length > 0) {
          publishDiscoverShelves([
            ...published,
            {
              id: 'popular',
              label: 'Popular on your server',
              entities: resolved,
              source: 'browse' as BookActionsSource,
            },
          ])
        }
      })
    } catch {
      // The library reads are the only hard dependency - everything else
      // already degrades on its own. Offline or a dropped server lands here.
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const onRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await load()
    } finally {
      setRefreshing(false)
    }
  }, [load])

  const goToTab = useGoToTab()

  const openActions = useCallback((item: ABSLibraryItem) => {
    haptics.longPress()
    actionsRef.current?.present(
      item,
      getProgressState().byId.get(item.id)?.isFinished === true,
      'browse',
    )
  }, [])

  // Feedback writes optimistically so a tile reacts before the round-trip; the
  // server echoes the full map back and we adopt it when it's non-empty.
  const writeFeedback = useCallback((itemKey: string, fb: { vote?: DiscoverVote | null }) => {
    haptics.select()
    setFeedback((prev) => {
      const next = { ...prev }
      const entry = { ...(next[itemKey] ?? {}) }
      if (fb.vote !== undefined) {
        if (fb.vote === null) delete entry.vote
        else entry.vote = fb.vote
      }
      if (Object.keys(entry).length === 0) delete next[itemKey]
      else next[itemKey] = entry
      return next
    })
    void setDiscoverFeedback(itemKey, fb).then((map) => {
      if (map && Object.keys(map).length > 0) setFeedback(map)
    })
  }, [])

  // Ratings write to their own endpoint, and unlike feedback that write can
  // FAIL loudly - so roll the optimistic value back rather than leaving a star
  // on screen the server never stored.
  const writeRating = useCallback((itemKey: string, value: number | null) => {
    haptics.select()
    // Snapshot for rollback from the REF, not from inside the state updater:
    // an updater must be pure, and React invokes it twice in development, so
    // the second pass would capture the value we just optimistically wrote and
    // "roll back" to it. ratingsRef tracks the committed map (see the effect
    // below), which is the value we actually want to restore.
    const previous = ratingsRef.current[itemKey]
    setRatings((prev) => {
      const next = { ...prev }
      if (value === null) delete next[itemKey]
      else next[itemKey] = value
      return next
    })
    void setRating(itemKey, value)
      .then((map) => setRatings(map))
      .catch(() => {
        setRatings((prev) => {
          const next = { ...prev }
          if (previous === undefined) delete next[itemKey]
          else next[itemKey] = previous
          return next
        })
      })
  }, [])

  const byId = new Map(items.map((it) => [it.id, it] as const))
  // AI picks resolved to owned items, with not-interested hidden.
  const aiPicks =
    !monthly || monthly.engine === 'none'
      ? []
      : monthly.picks
          .map((p) => ({ item: byId.get(p.id), reason: p.reason }))
          .filter(
            (x): x is { item: ABSLibraryItem; reason: string } =>
              Boolean(x.item) && feedback[x.item!.id]?.vote !== 'not_interested',
          )

  const quickPlay = async (item: ABSLibraryItem) => {
    haptics.transport()
    try {
      await playItemById(item.id)
      router.push('/player')
    } catch {
      router.push(`/item/${item.id}?from=${active}`)
    }
  }

  const renderRow = (shelf: {
    id: string
    label: string
    icon?: string
    items: ABSLibraryItem[]
  }) => (
    <View key={shelf.id} style={{ marginTop: spacing.lg }}>
      <SectionHeader
        title={shelf.label}
        icon={shelfIcon(shelf.icon)}
        onPress={() => router.push(`/shelf/${encodeURIComponent(shelf.id)}?from=${active}`)}
        action={
          <Touchable
            onPress={() => router.push(`/shelf/${encodeURIComponent(shelf.id)}?from=${active}`)}
            hitSlop={8}
            style={styles.seeAll}
          >
            <AppText variant="caption" color={colors.textMuted}>
              See all
            </AppText>
            <Icon name={icons.chevronRight} size={16} color={colors.textMuted} />
          </Touchable>
        }
      />
      <FlatList
        data={shelf.items}
        keyExtractor={(it) => it.id}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.md }}
        renderItem={({ item }) => {
          const p = progressById.get(item.id)
          return (
            <BookTile
              item={item}
              width={tileWidth}
              from={active}
              progress={p?.progress}
              finished={p?.isFinished === true}
              onQuickPlay={() => void quickPlay(item)}
              onLongPress={() => openActions(item)}
            />
          )
        }}
      />
    </View>
  )

  return (
    <Screen tabBar={<AppTabBar activeName={active} onPressTab={goToTab} />}>
      <View style={styles.header}>
        <IconButton name={icons.back} onPress={() => router.back()} accessibilityLabel="Back" />
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="hero" numberOfLines={1}>
            Discover
          </AppText>
          <AppText variant="caption" color={colors.textMuted}>
            Picks tuned to your listening
          </AppText>
        </View>
      </View>

      {loading ? (
        <DiscoverSkeleton tileWidth={tileWidth} />
      ) : loadError ? (
        <Centered>
          <EmptyState
            icon={icons.cloudOff}
            title="Couldn't reach your library"
            body="Discover needs your library to build its picks. Check your connection and try again."
            cta="Try again"
            onCta={() => {
              setLoading(true)
              void load()
            }}
          />
        </Centered>
      ) : items.length === 0 ? (
        <Centered>
          <EmptyState
            title="Nothing to discover yet"
            body="Add books to your library and they'll start showing up here."
          />
        </Centered>
      ) : (
        /* Screen root deliberately un-animated: the navigator's own
           fade_from_bottom already fades this in, and a Reanimated `entering` on
           a screen ROOT races react-native-screens' transition - an interrupted
           push tears down the Fabric surface under it and the screen renders
           blank white with no JS error (HS-MOBILEAPP-13, diagnosed on the book
           screen; this is the same shape). */
        <ScrollView
          contentContainerStyle={{ paddingBottom: contentInset }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={colors.accent}
              colors={[colors.accent]}
            />
          }
        >
          {aiPicks.length > 0 ? (
            <View style={{ marginTop: spacing.lg }}>
              <SectionHeader
                title={monthly?.intro?.trim() ? monthly.intro : 'Your shelf this month'}
                icon={icons.sparkle}
              />
              <FlatList
                data={aiPicks}
                keyExtractor={(x) => x.item.id}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: spacing.lg, gap: spacing.md }}
                renderItem={({ item: pick }) => {
                  const p = progressById.get(pick.item.id)
                  return (
                    <DiscoverAiTile
                      item={pick.item}
                      reason={pick.reason}
                      width={tileWidth}
                      from={active}
                      progress={p?.progress}
                      finished={p?.isFinished === true}
                      feedback={feedback[pick.item.id]}
                      rating={ratings[pick.item.id]}
                      onOpenFeedback={() => feedbackRef.current?.present(pick.item)}
                      onQuickPlay={() => void quickPlay(pick.item)}
                      onLongPress={() => openActions(pick.item)}
                    />
                  )
                }}
              />
            </View>
          ) : null}

          {shelves.map((s) => renderRow(s))}

          {popular.length > 0
            ? renderRow({
                id: 'popular',
                label: 'Popular on your server',
                icon: 'trending_up',
                items: popular,
              })
            : null}
        </ScrollView>
      )}

      <BookActionsSheet ref={actionsRef} onToast={showToast} />
      <DiscoverFeedbackSheet
        ref={feedbackRef}
        feedbackFor={(id) => feedback[id]}
        ratingFor={(id) => ratings[id]}
        onVote={(item, v) =>
          writeFeedback(item.id, { vote: feedback[item.id]?.vote === v ? null : v })
        }
        onRate={(item, n) => writeRating(item.id, ratings[item.id] === n ? null : n)}
        onNotInterested={(item) => writeFeedback(item.id, { vote: 'not_interested' })}
      />
      <Toast message={toast} />
    </Screen>
  )
}

/** Mirrors the real layout (one AI row + two shelves) so content lands without reflow. */
function DiscoverSkeleton({ tileWidth }: { tileWidth: number }) {
  return (
    <View style={{ paddingHorizontal: spacing.lg, gap: spacing.lg, marginTop: spacing.lg }}>
      {[0, 1, 2].map((r) => (
        <View key={r} style={{ gap: spacing.sm }}>
          <SkeletonRow width="40%" height={14} />
          <View style={{ flexDirection: 'row', gap: spacing.md }}>
            {[0, 1, 2].map((c) => (
              <Skeleton key={c} width={tileWidth} height={tileWidth * 1.4} radius={12} />
            ))}
          </View>
        </View>
      ))}
    </View>
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
  seeAll: { flexDirection: 'row', alignItems: 'center', gap: 2 },
})
