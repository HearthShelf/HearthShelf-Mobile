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
  onDeckChange?: (count: number, index: number) => void
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

  // Report deck state up so the player can draw the position dots above the
  // cover (in normal flow, where they can't be clipped by the cover area).
  useEffect(() => {
    onDeckChange?.(pages.length, index)
  }, [pages.length, index, onDeckChange])

  // Each page fills the full cover-area width so neighbors sit fully offscreen -
  // only the centered cover shows; the dots signal that more can be swiped in.
  const pageW = pageWidth

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

  const onScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { x: number } } }) => {
      const i = Math.max(
        0,
        Math.min(pages.length - 1, Math.round(e.nativeEvent.contentOffset.x / pageW)),
      )
      if (i !== index) {
        haptics.select()
        setIndex(i)
      }
    },
    [pageW, index, pages.length],
  )

  const returnToLive = useCallback(() => {
    haptics.select()
    listRef.current?.scrollToOffset({ offset: 0, animated: true })
    setIndex(0)
  }, [])

  const renderPage = ({ item, index: i }: ListRenderItemInfo<DeckPage>) => {
    const isFocus = i === index
    const pageHue = coverHue(item.itemId)
    return (
      <View style={{ width: pageW, alignItems: 'center' }}>
        {/* Skip hotspots live in the gutters beside the live cover (double-tap
            to skip). Rendered behind the card so the cover's own tap wins. */}
        {item.isLive ? hotspots : null}
        <SpringPressable
          scaleTo={0.98}
          onPress={() =>
            item.isLive
              ? onLivePress()
              : isFocus
                ? undefined
                : listRef.current?.scrollToOffset({ offset: i * pageW, animated: true })
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

          {/* Dim non-live pages so the live one reads as the active book. */}
          {!item.isLive && (
            <View
              style={[styles.dim, { backgroundColor: withAlpha('#0a0806', 0.32) }]}
              pointerEvents="none"
            />
          )}

          {/* Play-this on a browsed-to, non-live, focused card. */}
          {!item.isLive && isFocus && (
            <View style={styles.playWrap}>
              <SpringPressable onPress={() => switchTo(item)} style={styles.playBtn} scaleTo={0.9}>
                <Icon name={icons.play} size={30} color={colors.onAccent} />
              </SpringPressable>
              <AppText variant="caption" color="#fff" numberOfLines={2} style={styles.playLabel}>
                {item.title}
              </AppText>
            </View>
          )}

          {/* Up-next label on non-live cards. */}
          {!item.isLive && (
            <View style={styles.upNextTag} pointerEvents="none">
              <AppText variant="caption" color="rgba(255,255,255,0.75)" style={styles.upNextText}>
                UP NEXT
              </AppText>
            </View>
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

  const browsedAway = index !== 0

  return (
    <View style={styles.wrap}>
      <FlatList
        ref={listRef}
        data={pages}
        keyExtractor={(p) => p.itemId}
        renderItem={renderPage}
        horizontal
        style={{ width: pageW }}
        showsHorizontalScrollIndicator={false}
        // Full-width pages -> one cover per swipe, no neighbor peeking.
        pagingEnabled
        disableIntervalMomentum
        decelerationRate="fast"
        onScroll={onScroll}
        scrollEventThrottle={16}
        getItemLayout={(_, i) => ({ length: pageW, offset: pageW * i, index: i })}
      />

      {/* Return-to-now-playing chip (dots moved above the cover). */}
      {browsedAway ? (
        <SpringPressable onPress={returnToLive} style={styles.backChip} scaleTo={0.94}>
          <Icon name={icons.nowPlaying} size={25} color={colors.accent} />
          <AppText
            variant="caption"
            color={colors.text}
            style={{ fontWeight: '800', fontSize: 14 }}
          >
            Back to now playing
          </AppText>
        </SpringPressable>
      ) : null}
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
    upNextTag: { position: 'absolute', bottom: 12, left: 14 },
    upNextText: { letterSpacing: 1.2, fontWeight: '600' },
    playWrap: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    playBtn: {
      width: 62,
      height: 62,
      borderRadius: 31,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1.5,
      borderColor: 'rgba(255,255,255,0.3)',
    },
    playLabel: {
      fontSize: 18,
      fontWeight: '700',
      textAlign: 'center',
      paddingHorizontal: spacing.lg,
      // Readable over any artwork color: a soft dark halo behind the glyphs.
      textShadowColor: 'rgba(0,0,0,0.85)',
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 4,
    },
    backChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingHorizontal: spacing.xl,
      paddingVertical: 6,
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
    },
  })
