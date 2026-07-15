/**
 * The full player's cover, promoted to a swipeable deck: page 0 is the live
 * (now-playing) book, the rest are the up-next queue. Swiping BROWSES only -
 * audio keeps playing the live book and the surrounding player chrome
 * (scrubber, transport, actions) stays bound to it. A "playing" marker rides
 * the live card; when you browse away, a non-live card shows a "Play this"
 * button (the only thing that switches playback) and a chip snaps you back.
 *
 * Rendered in place of the single Cover in app/player.tsx when the
 * `carouselPlayer` setting is on. Skip-hotspots are suppressed by the caller
 * while this is active (horizontal swipe would fight the edge double-taps).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FlatList, StyleSheet, View } from 'react-native'
import type { ListRenderItemInfo } from 'react-native'
import { coverHue } from '@hearthshelf/core'
import type { QueueEntry } from '@hearthshelf/core'
import { coverUrl } from '@/api/abs'
import { playItemById } from '@/player/playback'
import { requestSeek } from '@/player/store'
import { getQueueState, setQueueItems } from '@/player/queue'
import { getProgressState } from '@/store/progress'
import { AppText, Cover } from '@/ui/primitives'
import { Icon, icons } from '@/ui/icons'
import { SpringPressable } from '@/ui/motion'
import { haptics } from '@/ui/haptics'
import { radius, spacing, withAlpha, type Palette } from '@/ui/theme'
import { useTheme } from '@/ui/ThemeProvider'

// Gap between adjacent covers; also how much of each neighbor peeks past the
// centered active cover at the screen edges.
const PAGE_GAP = 32

/** One page: the live book (index 0) or an up-next queue entry. */
interface DeckPage {
  itemId: string
  title: string
  author: string
  /** true for the currently-playing book (page 0). */
  isLive: boolean
}

export function PlayerCoverCarousel({
  liveItemId,
  liveTitle,
  liveAuthor,
  liveArtworkUrl,
  queue,
  coverWidth,
  coverAspect,
  /** Full width of the cover area; each page fills it so only the centered
   *  cover is visible (no neighbor peeking). */
  pageWidth,
  /** Slot for the bookmark/club buttons that overlay the live card. */
  overlay,
  /** Onscreen skip feedback overlay (only meaningful on the live card). */
  skipFeedback,
  /** Double-tap skip hotspots for the live card's left/right margins. Rendered
   *  in the gutters beside the cover so they coexist with horizontal paging. */
  hotspots,
  /** Tap the live cover (play/pause or lightbox, per the player's own logic). */
  onLivePress,
  /** Reports the deck (page count, active index) so the player can draw the
   *  position dots above the cover in normal flow. */
  onDeckChange,
  onScrollFraction,
}: {
  liveItemId: string
  liveTitle: string
  liveAuthor: string
  liveArtworkUrl?: string
  queue: QueueEntry[]
  coverWidth: number
  coverAspect: number
  pageWidth: number
  overlay?: React.ReactNode
  skipFeedback?: React.ReactNode
  hotspots?: React.ReactNode
  onLivePress: () => void
  onDeckChange?: (count: number, index: number, jumpTo: (i: number) => void) => void
  /** Continuous scroll position (fractional page index), fired every frame so
   *  the player's dots track the finger in real time (not just on settle). */
  onScrollFraction?: (frac: number) => void
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const listRef = useRef<FlatList<DeckPage>>(null)
  const [index, setIndex] = useState(0)

  const pages = useMemo<DeckPage[]>(() => {
    const live: DeckPage = {
      itemId: liveItemId,
      title: liveTitle,
      author: liveAuthor,
      isLive: true,
    }
    const rest = queue
      .filter((q) => q.libraryItemId !== liveItemId)
      .map((q) => ({
        itemId: q.libraryItemId,
        title: q.title,
        author: q.author,
        isLive: false,
      }))
    return [live, ...rest]
  }, [liveItemId, liveTitle, liveAuthor, queue])

  // Each page fills the full cover-area width so neighbors sit fully offscreen -
  // only the centered cover shows; the dots signal that more can be swiped in.
  const pageW = pageWidth

  // Animate the deck to a page (tapping a dot in the player drives this).
  const jumpTo = useCallback(
    (i: number) => {
      listRef.current?.scrollToOffset({ offset: i * (coverWidth + PAGE_GAP), animated: true })
    },
    [coverWidth],
  )

  // Report deck state up so the player can draw the position dots above the
  // cover (in normal flow, where they can't be clipped by the cover area).
  useEffect(() => {
    onDeckChange?.(pages.length, index, jumpTo)
  }, [pages.length, index, onDeckChange, jumpTo])

  const switchTo = useCallback(
    async (page: DeckPage) => {
      haptics.transport()
      // The book we're leaving is still worth listening to (it was live, so it's
      // in progress), so it shouldn't vanish from the deck. Rewrite up-next:
      // drop the book we're switching TO (it's about to be live) and put the
      // outgoing live book at the head, so it becomes the new "next up" (#2).
      // bump=false: this is a LOCAL display-only reorder of the deck, not a queue
      // edit. The server owns the active `items` in Auto/Playlist (it recomputes
      // on the next pull - the outgoing in-progress book is kept by the
      // in-progress rule), so we must NOT push this reorder back, or the stored
      // queue would inflate one prepended book per swipe.
      const outgoing = { libraryItemId: liveItemId, title: liveTitle, author: liveAuthor }
      const rest = getQueueState().items.filter(
        (q) => q.libraryItemId !== page.itemId && q.libraryItemId !== liveItemId,
      )
      setQueueItems([outgoing, ...rest], false)

      const saved = getProgressState().byId.get(page.itemId)
      await playItemById(page.itemId)
      if (!saved?.isFinished && (saved?.currentTime ?? 0) > 0) requestSeek(saved!.currentTime)
      // The live book is now this one; snap the deck back to page 0.
      listRef.current?.scrollToOffset({ offset: 0, animated: false })
      setIndex(0)
    },
    [liveItemId, liveTitle, liveAuthor],
  )

  const snap = coverWidth + PAGE_GAP
  // Last page boundary we ticked, so a fast fling clicks once per book crossed
  // (the settled `index` alone would miss the ones that flew by).
  const lastTick = useRef(0)
  const onScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { x: number } } }) => {
      const x = e.nativeEvent.contentOffset.x
      const frac = Math.max(0, Math.min(pages.length - 1, x / snap))
      // Continuous fractional page for the dots (tracks the finger every frame).
      onScrollFraction?.(frac)
      // Ratchet: tick each time the scroll crosses into a new book's cell, so a
      // whip across the deck feels like click-click-click past each detent.
      const nearest = Math.round(frac)
      if (nearest !== lastTick.current) {
        lastTick.current = nearest
        haptics.select()
      }
      if (nearest !== index) setIndex(nearest)
    },
    [snap, index, pages.length, onScrollFraction],
  )

  const renderPage = ({ item, index: i }: ListRenderItemInfo<DeckPage>) => {
    const isFocus = i === index
    const pageHue = coverHue(item.itemId)
    return (
      // Each page is one cover wide plus the inter-cover gap, so neighbors
      // peek at the screen edges (the deck advertises itself). Snap lands the
      // active cover centered.
      <View style={{ width: coverWidth + PAGE_GAP, alignItems: 'center' }}>
        <SpringPressable
          scaleTo={0.98}
          onPress={() =>
            item.isLive
              ? onLivePress()
              : isFocus
                ? switchTo(item)
                : listRef.current?.scrollToOffset({
                    offset: i * (coverWidth + PAGE_GAP),
                    animated: true,
                  })
          }
          style={[styles.card, { width: coverWidth }]}
        >
          <Cover
            uri={item.isLive ? liveArtworkUrl : coverUrl(item.itemId)}
            itemId={item.itemId}
            width={coverWidth}
            aspectRatio={coverAspect}
            radius={radius.card}
            fallback={{
              hue: pageHue,
              initial: item.title.charAt(0).toUpperCase(),
              title: item.title,
            }}
            style={{ backgroundColor: colors.high }}
          />

          {/* Non-live pages dim and carry a slim UP NEXT kicker; tap the focused
              one to play it. No separate play button/label - a single tap on
              the focused up-next cover switches to it (less busy). */}
          {!item.isLive && (
            <>
              <View
                style={[styles.dim, { backgroundColor: withAlpha('#0a0806', isFocus ? 0.28 : 0.5) }]}
                pointerEvents="none"
              />
              <View style={styles.upNextTag} pointerEvents="none">
                <AppText variant="caption" color="rgba(255,255,255,0.85)" style={styles.upNextText}>
                  {`UP NEXT · ${i} OF ${pages.length - 1}`}
                </AppText>
              </View>
              {isFocus && (
                <View style={styles.playHint} pointerEvents="none">
                  <Icon name={icons.play} size={26} color={colors.onAccent} />
                  <AppText variant="caption" color="#fff" style={{ fontWeight: '700' }}>
                    Tap to play
                  </AppText>
                </View>
              )}
            </>
          )}

          {/* Live overlays (bookmark/club/skip feedback) only over page 0. */}
          {item.isLive && (
            <>
              {skipFeedback}
              {overlay}
            </>
          )}
        </SpringPressable>
      </View>
    )
  }

  // Center the active cover: side padding reveals a peek sliver of the neighbor.
  const sidePad = Math.max(0, (pageW - coverWidth - PAGE_GAP) / 2)

  return (
    <View style={styles.wrap}>
      {/* Skip hotspots live in the gutters beside the centered cover (double-tap
          to skip); above the list so they receive the margin taps. */}
      {hotspots}
      <FlatList
        ref={listRef}
        data={pages}
        keyExtractor={(p) => p.itemId}
        renderItem={renderPage}
        horizontal
        style={{ width: pageW }}
        contentContainerStyle={{ paddingHorizontal: sidePad }}
        showsHorizontalScrollIndicator={false}
        // Momentum ratchet: a fling carries across the deck (each book a detent),
        // decelerating naturally and settling on the nearest cover. Neighbors
        // peek at the edges. `disableIntervalMomentum` is intentionally OFF so a
        // fast whip flies past many books instead of stopping one at a time.
        snapToInterval={coverWidth + PAGE_GAP}
        snapToAlignment="start"
        decelerationRate="normal"
        onScroll={onScroll}
        scrollEventThrottle={16}
        getItemLayout={(_, i) => ({
          length: coverWidth + PAGE_GAP,
          offset: (coverWidth + PAGE_GAP) * i,
          index: i,
        })}
      />
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    wrap: { alignSelf: 'stretch', alignItems: 'center' },
    card: { borderRadius: radius.card, overflow: 'hidden', position: 'relative' },
    dim: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, borderRadius: radius.card },
    liveTag: {
      position: 'absolute',
      top: 10,
      left: 10,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 9,
      paddingVertical: 5,
      borderRadius: radius.pill,
      backgroundColor: 'rgba(20,17,15,0.55)',
    },
    liveTagText: { letterSpacing: 1, fontWeight: '700' },
    // Translucent pill so the kicker reads over any artwork.
    upNextTag: {
      position: 'absolute',
      top: 12,
      left: 12,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: radius.pill,
      backgroundColor: 'rgba(15,12,10,0.55)',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: 'rgba(255,255,255,0.14)',
    },
    upNextText: { letterSpacing: 1.2, fontWeight: '600' },
    // A centered "tap to play" hint on the focused up-next cover.
    playHint: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
    },
  })
