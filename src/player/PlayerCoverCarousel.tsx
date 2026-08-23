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
import type { HSClub, HSClubMember, QueueEntry } from '@hearthshelf/core'
import { coverUrl } from '@/api/abs'
import { getClub, getClubs } from '@/api/clubs'
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
import { CarouselBookClubStrip } from '@/player/CarouselBookClubStrip'

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
  /** Whether the Player setting allows club context over carousel books. */
  clubOverlaysEnabled = true,
  /** Slot for the bookmark/zoom controls and club strip over the live card. */
  overlay,
  /** The live overlay is accepting text; freeze the deck and its cover gesture
   *  until composition ends so swipes/holds cannot steal keyboard touches. */
  overlayActive = false,
  /** Onscreen skip feedback overlay (only meaningful on the live card). */
  skipFeedback,
  /** Double-tap skip hotspots for the live card's left/right margins. Rendered
   *  in the gutters beside the cover so they coexist with horizontal paging. */
  hotspots,
  /** Tap the live cover (play/pause or lightbox, per the player's own logic). */
  onLivePress,
  onLongPressPage,
  onLiveHoldStart,
  onLiveHoldEnd,
  /** Reports the deck (page count, active index, the active page's book, and a
   *  jump fn) so the player can draw the dots and the browsed book's header +
   *  transport. */
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
  clubOverlaysEnabled?: boolean
  overlay?: React.ReactNode
  overlayActive?: boolean
  skipFeedback?: React.ReactNode
  hotspots?: React.ReactNode
  onLivePress: () => void
  /** Long-press an UP-NEXT cover to open the book actions sheet (same menu as
   *  the home shelves). Not wired on the live page - holding that one is the
   *  fast-forward gesture below. */
  onLongPressPage?: (page: {
    itemId: string
    title: string
    author: string
    isLive: boolean
  }) => void
  /** Press-and-hold the live cover: fast-forward while held, normal on release. */
  onLiveHoldStart?: () => void
  onLiveHoldEnd?: () => void
  onDeckChange?: (info: {
    count: number
    index: number
    /** The book centered right now (live at index 0, else an up-next entry). */
    active: { itemId: string; title: string; author: string; isLive: boolean }
    jumpTo: (i: number) => void
    /** Start/switch to the browsed book and reorder the deck (deck Play btn). */
    playActive: () => void
  }) => void
  /** Continuous scroll position (fractional page index), fired every frame so
   *  the player's dots track the finger in real time (not just on settle). */
  onScrollFraction?: (frac: number) => void
}) {
  const { colors } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const listRef = useRef<FlatList<DeckPage>>(null)
  const [index, setIndex] = useState(0)
  const [clubs, setClubs] = useState<HSClub[]>([])
  const [clubMembersByBook, setClubMembersByBook] = useState<Map<string, HSClubMember[]>>(
    () => new Map(),
  )
  const requestedClubBooks = useRef(new Set<string>())

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
  const pageIdsKey = useMemo(() => pages.map((page) => page.itemId).join('|'), [pages])

  // Club summaries are enough to label every current/up-next club book without
  // one request per page. Reload when the deck's membership changes so newly
  // queued books acquire their club name while the player remains open.
  useEffect(() => {
    if (!clubOverlaysEnabled || pages.length <= 1) {
      setClubs([])
      return
    }
    let cancelled = false
    void getClubs().then((response) => {
      if (!cancelled) setClubs(response.enabled ? response.mine : [])
    })
    return () => {
      cancelled = true
    }
  }, [clubOverlaysEnabled, pageIdsKey, pages.length])

  const clubByItem = useMemo(() => {
    const mapped = new Map<string, HSClub>()
    for (const page of pages) {
      const current = clubs.find((club) => club.currentBook?.libraryItemId === page.itemId)
      const queued = clubs.find((club) => club.queuedItemIds.includes(page.itemId))
      const club = current ?? queued
      if (club) mapped.set(page.itemId, club)
    }
    return mapped
  }, [clubs, pages])

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

  // Report deck state up: dots, the browsed book (header + its transport), a
  // jump fn, and a play-this fn. `active` is clamped in case index outruns a
  // shrinking deck.
  const active = pages[Math.min(index, pages.length - 1)] ?? pages[0]
  const focusedClub = clubByItem.get(active.itemId)
  // Progress is heavier than the summary, so fetch it only for the focused
  // ahead-book and cache it. The server resolves bookId against both timeline
  // and Up next, allowing members who read ahead to appear at their real point.
  useEffect(() => {
    if (!clubOverlaysEnabled || active.isLive || !focusedClub) return
    const key = `${focusedClub.id}:${active.itemId}`
    if (clubMembersByBook.has(key) || requestedClubBooks.current.has(key)) return
    // `index` ratchets across every page during a fast fling. Wait for a brief
    // settle before loading so flying over five books does not fire five club
    // detail requests.
    const timer = setTimeout(() => {
      requestedClubBooks.current.add(key)
      void getClub(focusedClub.id, { bookId: active.itemId })
        .then((detail) => {
          if (!detail) return
          setClubMembersByBook((previous) => {
            const next = new Map(previous)
            next.set(key, detail.members)
            return next
          })
        })
        .finally(() => {
          requestedClubBooks.current.delete(key)
        })
    }, 220)
    return () => clearTimeout(timer)
  }, [active.isLive, active.itemId, clubMembersByBook, clubOverlaysEnabled, focusedClub])
  const playActive = useCallback(() => {
    if (active && !active.isLive) void switchTo(active)
  }, [active, switchTo])
  useEffect(() => {
    onDeckChange?.({ count: pages.length, index, active, jumpTo, playActive })
  }, [pages.length, index, active, onDeckChange, jumpTo, playActive])

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
    const pageClub = clubByItem.get(item.itemId)
    const clubMembers = pageClub
      ? clubMembersByBook.get(`${pageClub.id}:${item.itemId}`)
      : undefined
    return (
      // Each page is one cover wide plus the inter-cover gap, so neighbors
      // peek at the screen edges (the deck advertises itself). Snap lands the
      // active cover centered.
      <View style={{ width: coverWidth + PAGE_GAP, alignItems: 'center' }}>
        <View style={[styles.card, { width: coverWidth }]}>
          <SpringPressable
            scaleTo={0.98}
            disabled={item.isLive && overlayActive}
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
            // Holding the LIVE cover fast-forwards (boost on long-press, restore on
            // release); holding an up-next cover opens the book actions sheet.
            // onPressOut also fires when the press is cancelled (the touch turns
            // into a horizontal page swipe), so the boost can't outlive the finger.
            onLongPress={
              item.isLive
                ? onLiveHoldStart
                : onLongPressPage
                  ? () => onLongPressPage(item)
                  : undefined
            }
            onPressOut={item.isLive ? onLiveHoldEnd : undefined}
            delayLongPress={300}
            style={styles.pressTarget}
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
                  style={[
                    styles.dim,
                    { backgroundColor: withAlpha('#0a0806', isFocus ? 0.28 : 0.5) },
                  ]}
                  pointerEvents="none"
                />
                <View style={styles.upNextTag} pointerEvents="none">
                  <AppText
                    variant="caption"
                    color="rgba(255,255,255,0.85)"
                    style={styles.upNextText}
                  >
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
                {pageClub && (
                  <CarouselBookClubStrip
                    clubName={pageClub.name}
                    itemId={item.itemId}
                    members={clubMembers}
                  />
                )}
              </>
            )}
          </SpringPressable>

          {/* Live overlays are siblings of the cover press target. Text inputs
              and strip controls can now own their touches instead of bubbling
              into tap-to-play / hold-to-boost. */}
          {item.isLive && (
            <>
              {skipFeedback}
              {overlay}
            </>
          )}
        </View>
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
        scrollEnabled={!overlayActive}
        removeClippedSubviews={!overlayActive}
        style={{ width: pageW, overflow: 'visible' }}
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
    // The cover itself clips in pressTarget; this outer layer stays visible so
    // the keyboard-aware inline composer can rise beyond the art bounds.
    card: { borderRadius: radius.card, overflow: 'visible', position: 'relative' },
    pressTarget: { borderRadius: radius.card, overflow: 'hidden' },
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
