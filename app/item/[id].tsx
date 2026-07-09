/**
 * Book detail, phone-first. The screen is state-aware: its sections REORDER by
 * where the listener is with the book, because the job of the screen changes.
 *  - In progress: resume is the job. Status card + CTA up top, then the chapter
 *    list starting at the current chapter (tap a row to play from it).
 *  - Not started: convincing is the job. CTA, then About, series, chapters.
 *  - Finished: what's-next is the job. Finished card, then the series link,
 *    then "Listen again", About, chapters.
 *
 * Everything visible is a real affordance backed by ABS data or an OS feature:
 * finished toggle (PATCH /api/me/progress), add-to-list, bookmarks (jump/
 * delete), share (OS sheet), download (browser), previous sessions, cover zoom.
 * No ratings-less star rows, no dead taps. Rating renders only when the server
 * has one.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Pressable, ScrollView, Share, StyleSheet, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { BottomSheetScrollView } from '@gorhom/bottom-sheet'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type {
  ABSBookmark,
  ABSChapter,
  ABSLibraryItemDetail,
  ABSListeningSession,
  ABSMediaProgress,
  ABSSeries,
} from '@hearthshelf/core'
import type { HSFinishedByUser, HSListeningNowUser } from '@hearthshelf/core'
import { coverHue, formatDuration, formatTimestamp, stripHtml } from '@hearthshelf/core'
import {
  avatarUrl,
  coverUrl,
  deleteBookmark,
  getItemDetail,
  getLibrarySeries,
  getRecentSessions,
} from '@/api/abs'
import { getFinishedBy, getListeningNow } from '@/api/social'
import { getNotes } from '@/api/notes'
import { NotesSheet } from '@/social/NotesSheet'
import { ClubCard } from '@/social/ClubCard'
import {
  getProgressState,
  subscribeProgress,
  refreshProgress,
  promptAndMarkItemsFinished,
} from '@/store/progress'
import {
  getDownloadsState,
  subscribeDownloads,
  downloadItem,
  cancelDownload,
  deleteDownload,
  downloadFor,
} from '@/player/downloads'
import { offlineDetailFor } from '@/player/offlineCatalog'
import { requestSeek } from '@/player/store'
import { playItemById } from '@/player/playback'
import { AddToListSheet } from '@/player/AddToListSheet'
import type { SheetHandle } from '@/player/sheets'
import {
  AppText,
  Avatar,
  Centered,
  Cover,
  IconButton,
  Loading,
  PrimaryButton,
  Screen,
  Sheet,
  Touchable,
  type SheetRef,
  icons,
} from '@/ui/primitives'
import { Icon } from '@/ui/icons'
import { useSheetBackHandler } from '@/ui/useBackHandler'
import { AppTabBar } from '@/ui/AppTabBar'
import { CoverGlow } from '@/ui/CoverGlow'
import { CoverLightbox } from '@/ui/CoverLightbox'
import { EmberBurst } from '@/ui/EmberBurst'
import { DUR } from '@/ui/motion'
import { Toast, useToast } from '@/ui/Toast'
import { haptics } from '@/ui/haptics'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useMiniPlayerInset } from '@/ui/useContentInset'
import { useColors } from '@/ui/ThemeProvider'

const CHAPTER_PREVIEW_COUNT = 4
const DESCRIPTION_CLAMP_LINES = 6

function formatBytes(bytes: number): string {
  if (!bytes) return ''
  const mb = bytes / (1024 * 1024)
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`
}

type SectionKey =
  | 'status'
  | 'cta'
  | 'about'
  | 'finishedBy'
  | 'listeningNow'
  | 'notes'
  | 'club'
  | 'series'
  | 'chapters'

export default function ItemDetailScreen() {
  const router = useRouter()
  // Hardware back closes an open sheet first; only with none open does it pop
  // the route (dismiss() returns false, letting the default back proceed).
  useSheetBackHandler()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { id } = useLocalSearchParams<{ id: string }>()
  const { message, show } = useToast()
  const miniInset = useMiniPlayerInset()

  const [detail, setDetail] = useState<ABSLibraryItemDetail | null>(null)
  // Progress comes from the shared store, so mark-finished anywhere (here, a
  // long-press sheet, the series page) updates this screen immediately.
  const progressById = useSyncExternalStore(subscribeProgress, getProgressState).byId
  const progress: ABSMediaProgress | null = (id && progressById.get(id)) || null
  const download = useSyncExternalStore(subscribeDownloads, getDownloadsState).byId.get(id ?? '')
  const [bookmarks, setBookmarks] = useState<ABSBookmark[]>([])
  const [series, setSeries] = useState<ABSSeries | null>(null)
  const [finishedBy, setFinishedBy] = useState<HSFinishedByUser[]>([])
  const [listeningNow, setListeningNow] = useState<HSListeningNowUser[]>([])
  const [error, setError] = useState<string | null>(null)
  const [zoomed, setZoomed] = useState(false)
  // Increments each time the book is marked finished, firing the ember burst.
  const [finishBurst, setFinishBurst] = useState(0)

  const chaptersSheetRef = useRef<SheetRef>(null)
  const overflowSheetRef = useRef<SheetRef>(null)
  const bookmarksSheetRef = useRef<SheetRef>(null)
  const sessionsSheetRef = useRef<SheetRef>(null)
  const addToListRef = useRef<SheetHandle>(null)
  const notesSheetRef = useRef<SheetHandle>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    void (async () => {
      let d: ABSLibraryItemDetail
      try {
        d = await getItemDetail(id)
      } catch (e) {
        // Offline (or the server is unreachable): rebuild the detail from the
        // downloaded book's own cached metadata + audio, so a downloaded book
        // still opens and plays. Only the server-only extras (who's listening,
        // notes, description) are missing.
        const dl = downloadFor(id)
        const offline = dl
          ? offlineDetailFor(id, {
              duration: dl.duration,
              chapters: dl.chapters,
              tracks: dl.tracks,
            })
          : null
        if (!cancelled) {
          if (offline) setDetail(offline)
          else setError((e as Error).message)
        }
        return
      }
      try {
        if (cancelled) return
        setDetail(d)

        // Progress + bookmarks ride the same /api/me call; both are best-effort.
        refreshProgress()
          .then((me) => {
            if (cancelled) return
            setBookmarks((me.bookmarks ?? []).filter((b) => b.libraryItemId === id))
          })
          .catch(() => undefined)

        const seriesRef = d.media.metadata.series?.[0]
        if (seriesRef) {
          getLibrarySeries(d.libraryId)
            .then((all) => {
              if (cancelled) return
              setSeries(all.find((s) => s.id === seriesRef.id) ?? null)
            })
            .catch(() => setSeries(null))
        }

        // Best-effort; hides itself when unavailable (older server, no ABS db).
        getFinishedBy(id)
          .then((res) => {
            if (cancelled) return
            setFinishedBy(res.available ? res.users : [])
          })
          .catch(() => setFinishedBy([]))

        // Who's listening recently; hidden when unavailable or nobody's sharing.
        getListeningNow(id)
          .then((res) => {
            if (cancelled) return
            setListeningNow(res.available ? res.users : [])
          })
          .catch(() => setListeningNow([]))
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [id])

  if (error) {
    return (
      <Screen>
        <Header onBack={() => router.back()} />
        <Centered>
          <AppText variant="meta" color={colors.destructive}>
            {error}
          </AppText>
        </Centered>
      </Screen>
    )
  }

  if (!detail) {
    return (
      <Screen>
        <Header onBack={() => router.back()} />
        <Loading />
      </Screen>
    )
  }

  const meta = detail.media.metadata
  const chapters = detail.media.chapters ?? []
  // The detail media shape omits the flat `duration`; derive it from the last
  // chapter's end (full-book absolute seconds), falling back to summed audio
  // file durations for single-file books with no chapter markers.
  const duration =
    chapters.length > 0
      ? chapters[chapters.length - 1].end
      : detail.media.audioFiles.reduce((s, f) => s + f.duration, 0)
  const description = meta.description ? stripHtml(meta.description) : ''
  const title = meta.title || 'Untitled'
  const hue = coverHue(detail.id)
  // The detail endpoint omits the flattened authorName/narratorName the list
  // shape carries; it exposes authors[]/narrators[] instead.
  const authorName = meta.authors?.map((a) => a.name).join(', ') || meta.authorName || ''
  const narratorName = meta.narrators?.join(', ') || meta.narratorName || ''

  // The expanded detail carries the ebook as `ebookFile`; the minified list
  // shape uses the flat `ebookFormat`. Either presence means the book is
  // readable, so offer the reader alongside the audio CTA.
  const hasEbook = Boolean(detail.media.ebookFile || detail.media.ebookFormat)

  const isFinished = progress?.isFinished ?? false
  const isInProgress = !isFinished && (progress?.progress ?? 0) > 0
  const currentTime = isInProgress ? (progress?.currentTime ?? 0) : 0
  const currentChapterIndex = isInProgress
    ? chapters.findIndex((c) => currentTime >= c.start && currentTime < c.end)
    : -1

  // No "· Ch. N" suffix on Resume: books with prologues make the marker ordinal
  // disagree with the chapter's own title, and the pinned chapter row right
  // below already names where you are.
  const ctaLabel = isFinished ? 'Listen again' : isInProgress ? 'Resume' : 'Start listening'

  // This screen is pushed above the tab navigator, so it renders its own copy
  // of the tab bar (see player.tsx) rather than inheriting the tabs layout's.
  const goToTab = (name: string) => {
    router.dismissAll?.()
    router.replace(name === 'index' ? '/(tabs)' : `/(tabs)/${name}`)
  }

  const play = async () => {
    haptics.transport()
    // playItemById resolves the resume position itself (play session, else the
    // saved media-progress spot), so no manual seek here.
    await playItemById(detail.id)
    router.push('/player')
  }

  const playFrom = async (startSec: number) => {
    haptics.transport()
    await playItemById(detail.id)
    requestSeek(startSec)
    chaptersSheetRef.current?.dismiss()
    bookmarksSheetRef.current?.dismiss()
    sessionsSheetRef.current?.dismiss()
    router.push('/player')
  }

  const toggleFinished = async () => {
    const next = !isFinished
    try {
      // Finishing asks "when did you finish?" first; unfinishing is instant.
      // Optimistic flip + rollback live in the shared progress store.
      const ok = await promptAndMarkItemsFinished([{ id: detail.id, duration }], next)
      if (!ok) return // dismissed the prompt
      if (next) {
        haptics.success()
        setFinishBurst((b) => b + 1)
      }
      show(next ? 'Marked finished' : 'Back in progress')
    } catch {
      show('Could not update')
    }
  }

  const removeBookmark = async (b: ABSBookmark) => {
    haptics.warn()
    setBookmarks((list) => list.filter((x) => x.time !== b.time))
    try {
      await deleteBookmark(detail.id, b.time)
    } catch {
      setBookmarks((list) => [...list, b].sort((x, y) => x.time - y.time))
      show('Could not delete bookmark')
    }
  }

  const shareBook = async () => {
    overflowSheetRef.current?.dismiss()
    const narr = narratorName ? `, narrated by ${narratorName}` : ''
    await Share.share({ message: `${title} by ${authorName || 'Unknown author'}${narr}` })
  }

  const downloadBook = () => {
    if (download?.status === 'done') {
      void deleteDownload(detail.id)
      show('Download removed')
    } else if (download?.status === 'downloading' || download?.status === 'queued') {
      void cancelDownload(detail.id)
      show('Download cancelled')
    } else {
      void downloadItem(detail.id, title, authorName)
      show('Downloading for offline')
    }
  }

  const openAuthor = () => {
    const author = meta.authors?.[0]
    if (!author) return
    router.push(
      `/group/authors/${encodeURIComponent(author.id)}?libraryId=${encodeURIComponent(detail.libraryId)}&name=${encodeURIComponent(author.name)}`,
    )
  }

  const openNarrator = () => {
    if (!narratorName) return
    router.push(
      `/group/narrators/${encodeURIComponent(narratorName)}?libraryId=${encodeURIComponent(detail.libraryId)}&name=${encodeURIComponent(narratorName)}`,
    )
  }

  // The job of the screen changes with listening state; so does the order.
  const sectionOrder: SectionKey[] = isInProgress
    ? [
        'status',
        'cta',
        'listeningNow',
        'series',
        'chapters',
        'club',
        'notes',
        'about',
        'finishedBy',
      ]
    : isFinished
      ? [
          'status',
          'series',
          'cta',
          'club',
          'notes',
          'about',
          'finishedBy',
          'listeningNow',
          'chapters',
        ]
      : ['cta', 'about', 'listeningNow', 'series', 'club', 'notes', 'finishedBy', 'chapters']

  const sections: Record<SectionKey, React.ReactNode> = {
    status: (
      <StatusCard
        key="status"
        isFinished={isFinished}
        progress={progress}
        duration={duration}
        chapterCount={chapters.length}
      />
    ),
    cta: (
      <View key="cta" style={styles.ctaRow}>
        <PrimaryButton label={ctaLabel} icon={icons.play} onPress={play} style={{ flex: 1 }} />
        <View style={styles.burstWrap}>
          <ActionSquare
            icon={isFinished ? icons.taskAlt : icons.check}
            label={isFinished ? 'Done' : 'Finish'}
            active={isFinished}
            onPress={toggleFinished}
            grow
          />
          {/* Embers rise off the button when the book is marked finished. */}
          <EmberBurst burst={finishBurst} colors={[colors.accent, colors.brandHearth]} />
        </View>
        {hasEbook && (
          <ActionSquare
            icon={icons.readAlong}
            label="Read"
            onPress={() => {
              haptics.select()
              router.push(`/item/${detail.id}/read`)
            }}
          />
        )}
        <ActionSquare
          icon={download?.status === 'done' ? icons.downloadDone : icons.download}
          label={
            download?.status === 'done'
              ? 'Downloaded'
              : download?.status === 'downloading' || download?.status === 'queued'
                ? `${Math.round((download.progress ?? 0) * 100)}%`
                : 'Download'
          }
          active={download?.status === 'done'}
          onPress={downloadBook}
        />
      </View>
    ),
    about: (
      <AboutSection
        key="about"
        description={description}
        narratorName={narratorName}
        onNarrator={openNarrator}
      />
    ),
    finishedBy:
      finishedBy.length > 0 ? <FinishedBySection key="finishedBy" users={finishedBy} /> : null,
    listeningNow:
      listeningNow.length > 0 ? (
        <ListeningNowSection key="listeningNow" users={listeningNow} />
      ) : null,
    notes: <NotesSection key="notes" onOpen={() => notesSheetRef.current?.present()} />,
    club: <ClubCard key="club" libraryItemId={detail.id} onToast={show} />,
    series: series ? (
      <SeriesCard
        key="series"
        series={series}
        highlight={isFinished}
        onPress={() =>
          router.push(
            `/series/${encodeURIComponent(series.id)}?libraryId=${encodeURIComponent(detail.libraryId)}`,
          )
        }
      />
    ) : null,
    chapters:
      chapters.length > 0 ? (
        <ChaptersPreview
          key="chapters"
          chapters={chapters}
          currentChapterIndex={currentChapterIndex}
          currentTime={currentTime}
          isFinished={isFinished}
          isInProgress={isInProgress}
          onOpenAll={() => chaptersSheetRef.current?.present()}
          onPlayFrom={playFrom}
        />
      ) : null,
  }

  return (
    <Screen>
      <View style={StyleSheet.absoluteFill}>
        <CoverGlow hue={hue} height={320} />
      </View>

      <Header
        onBack={() => router.back()}
        bookmarkCount={bookmarks.length}
        onBookmarks={() => bookmarksSheetRef.current?.present()}
        onOverflow={() => overflowSheetRef.current?.present()}
      />

      <Animated.ScrollView
        entering={FadeIn.duration(DUR.base)}
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: miniInset }}
        showsVerticalScrollIndicator={false}
      >
        <Hero
          detail={detail}
          title={title}
          authorName={authorName}
          hue={hue}
          duration={duration}
          chapterCount={chapters.length}
          onZoom={() => setZoomed(true)}
          onAuthor={meta.authors?.[0] ? openAuthor : undefined}
        />
        {sectionOrder.map((k) => sections[k])}
      </Animated.ScrollView>

      {/* Pushed above the tabs navigator, so it renders its own copy of the bar
          (see player.tsx) rather than inheriting the tabs layout's. */}
      <AppTabBar activeName={null} onPressTab={goToTab} />

      <Sheet ref={chaptersSheetRef} title="Chapters" snapPoints={['70%']}>
        <BottomSheetScrollView contentContainerStyle={{ paddingBottom: spacing.xxl }}>
          {chapters.map((c, i) => (
            <ChapterRow
              key={c.id ?? i}
              chapter={c}
              index={i}
              current={i === currentChapterIndex}
              finished={isFinished || (isInProgress && c.end <= currentTime)}
              currentTime={currentTime}
              onPress={() => void playFrom(i === currentChapterIndex ? currentTime : c.start)}
            />
          ))}
        </BottomSheetScrollView>
      </Sheet>

      <Sheet ref={overflowSheetRef} title={title}>
        <SheetRow icon={icons.share} label="Share" onPress={() => void shareBook()} />
        <SheetRow
          icon={icons.addList}
          label="Add to collection or playlist"
          onPress={() => {
            overflowSheetRef.current?.dismiss()
            addToListRef.current?.present()
          }}
        />
        <SheetRow
          icon={icons.recent}
          label="Previous sessions"
          onPress={() => {
            overflowSheetRef.current?.dismiss()
            sessionsSheetRef.current?.present()
          }}
        />
        <FileInfoLine detail={detail} />
      </Sheet>

      <Sheet ref={bookmarksSheetRef} title="Bookmarks">
        {bookmarks.length === 0 ? (
          <AppText variant="meta" color={colors.textMuted} style={{ paddingVertical: spacing.lg }}>
            No bookmarks yet. Add them from the player.
          </AppText>
        ) : (
          bookmarks.map((b) => (
            <View key={b.time} style={styles.bookmarkRow}>
              <Touchable style={styles.bookmarkTap} onPress={() => void playFrom(b.time)}>
                <Icon name={icons.bookmarkFilled} size={20} color={colors.brandHearth} />
                <AppText variant="meta" numberOfLines={1} style={{ flex: 1 }}>
                  {b.title || 'Bookmark'}
                </AppText>
                <AppText variant="mono" color={colors.textMuted}>
                  {formatTimestamp(b.time)}
                </AppText>
              </Touchable>
              <IconButton
                name={icons.close}
                size={18}
                color={colors.textFaint}
                onPress={() => void removeBookmark(b)}
              />
            </View>
          ))
        )}
      </Sheet>

      <SessionsSheet ref={sessionsSheetRef} itemId={detail.id} onJump={playFrom} />

      <AddToListSheet
        ref={addToListRef}
        libraryId={detail.libraryId}
        libraryItemId={detail.id}
        onAdded={show}
      />

      <NotesSheet
        ref={notesSheetRef}
        libraryItemId={detail.id}
        position={currentTime}
        finished={isFinished}
        onToast={show}
      />

      <CoverLightbox
        visible={zoomed}
        uri={coverUrl(detail.id)}
        title={title}
        author={authorName}
        hue={hue}
        onClose={() => setZoomed(false)}
      />

      <Toast message={message} />
    </Screen>
  )
}

// ---- Hero ----

function Hero({
  detail,
  title,
  authorName,
  hue,
  duration,
  chapterCount,
  onZoom,
  onAuthor,
}: {
  detail: ABSLibraryItemDetail
  title: string
  authorName: string
  hue: string
  duration: number
  chapterCount: number
  onZoom: () => void
  onAuthor?: () => void
}) {
  const colors = useColors()
  const styles = useStyles()
  const meta = detail.media.metadata
  const rating = meta.rating

  // One compact meta line instead of a stat-strip card: same facts, less chrome.
  const metaParts = [
    formatDuration(duration),
    chapterCount > 0 ? `${chapterCount} chapters` : null,
    meta.genres?.[0] ?? null,
    meta.publishedYear ?? null,
  ].filter(Boolean)

  return (
    <View style={styles.hero}>
      <Pressable onPress={onZoom}>
        <Cover
          uri={coverUrl(detail.id)}
          itemId={detail.id}
          size={172}
          radius={radius.card}
          fallback={{ hue, initial: title.charAt(0).toUpperCase(), title }}
        />
      </Pressable>
      <AppText variant="hero" style={styles.title}>
        {title}
      </AppText>
      {meta.subtitle ? (
        <AppText variant="quote" color={colors.textMuted} style={styles.subtitle}>
          {meta.subtitle}
        </AppText>
      ) : null}
      <View style={styles.byline}>
        <Pressable onPress={onAuthor} disabled={!onAuthor} hitSlop={6}>
          <AppText variant="label" color={onAuthor ? colors.text : colors.textMuted}>
            {authorName || 'Unknown author'}
          </AppText>
        </Pressable>
        {rating != null && rating > 0 ? (
          <>
            <AppText variant="label" color={colors.textFaint}>
              ·
            </AppText>
            <Icon name="star" size={15} color={colors.brandHearth} />
            <AppText variant="mono">{rating.toFixed(1)}</AppText>
          </>
        ) : null}
      </View>
      {metaParts.length > 0 ? (
        <AppText variant="mono" color={colors.textMuted} style={{ marginTop: spacing.sm }}>
          {metaParts.join(' · ')}
        </AppText>
      ) : null}
    </View>
  )
}

// ---- Status ----

function StatusCard({
  isFinished,
  progress,
  duration,
  chapterCount,
}: {
  isFinished: boolean
  progress: ABSMediaProgress | null
  duration: number
  chapterCount: number
}) {
  const colors = useColors()
  const styles = useStyles()
  if (!progress || progress.progress <= 0) return null
  const pct = Math.round(progress.progress * 100)
  const chaptersLeft = Math.max(0, Math.round((1 - progress.progress) * chapterCount))
  const remaining = formatDuration(Math.max(0, duration - progress.currentTime))
  return (
    <View style={styles.statusCard}>
      <View style={styles.statusCardRow}>
        <AppText variant="label">
          {pct}%{chapterCount > 0 ? ` · ${chaptersLeft} chapters left` : ''}
        </AppText>
        <AppText variant="mono" color={colors.textMuted}>
          {remaining} left
        </AppText>
      </View>
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, { width: `${pct}%` }]} />
      </View>
    </View>
  )
}

// ---- CTA squares ----

function ActionSquare({
  icon,
  label,
  active,
  onPress,
  grow,
}: {
  icon: (typeof icons)[keyof typeof icons]
  label: string
  active?: boolean
  onPress: () => void
  /** Fill the parent's height (when wrapped for an overlay like EmberBurst). */
  grow?: boolean
}) {
  const colors = useColors()
  const styles = useStyles()
  return (
    <Touchable
      style={[styles.square, active && styles.squareActive, grow && { flex: 1 }]}
      onPress={onPress}
    >
      <Icon name={icon} size={22} color={active ? colors.brandHearth : colors.text} />
      <AppText
        variant="caption"
        numberOfLines={1}
        color={active ? colors.brandHearth : colors.textMuted}
      >
        {label}
      </AppText>
    </Touchable>
  )
}

// ---- About ----

function AboutSection({
  description,
  narratorName,
  onNarrator,
}: {
  description: string
  narratorName: string
  onNarrator: () => void
}) {
  const colors = useColors()
  const styles = useStyles()
  const [expanded, setExpanded] = useState(false)
  // Rough clamp check; RN can't cheaply report "did numberOfLines truncate".
  const clampable = description.length > 320
  if (!description && !narratorName) return null
  return (
    <View style={styles.section}>
      {description ? (
        <>
          <AppText variant="eyebrow" color={colors.textMuted}>
            About
          </AppText>
          <AppText
            variant="quote"
            numberOfLines={expanded || !clampable ? undefined : DESCRIPTION_CLAMP_LINES}
            style={{ marginTop: spacing.sm, lineHeight: 24 }}
          >
            {description}
          </AppText>
          {clampable ? (
            <Pressable onPress={() => setExpanded((e) => !e)} hitSlop={8}>
              <AppText variant="label" color={colors.accent} style={{ marginTop: spacing.sm }}>
                {expanded ? 'Read less' : 'Read more'}
              </AppText>
            </Pressable>
          ) : null}
        </>
      ) : null}
      {narratorName ? (
        <Pressable onPress={onNarrator} hitSlop={6}>
          <AppText variant="meta" color={colors.textMuted} style={{ marginTop: spacing.md }}>
            Narrated by <AppText variant="label">{narratorName}</AppText>
          </AppText>
        </Pressable>
      ) : null}
    </View>
  )
}

// ---- Finished by ----
// Small avatar chips for who's finished this book, privacy-filtered server-side
// (/hs/social/finished-by). Hidden entirely when empty/unavailable - the parent
// only renders this section when finishedBy.length > 0.

function FinishedBySection({ users }: { users: HSFinishedByUser[] }) {
  const colors = useColors()
  const styles = useStyles()
  return (
    <View style={styles.section}>
      <AppText variant="eyebrow" color={colors.textMuted}>
        Finished by {users.length} {users.length === 1 ? 'person' : 'people'}
      </AppText>
      <View style={styles.finishedByRow}>
        {users.map((u) => (
          <View key={u.userId} style={styles.finishedByChip}>
            <Avatar
              uri={avatarUrl(u.userId)}
              size={28}
              name={u.username}
              hue={coverHue(u.userId)}
            />
            <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
              {u.username}
            </AppText>
          </View>
        ))}
      </View>
    </View>
  )
}

// ---- Listening recently ----
// Small avatar chips for who's listening to this book right now-ish, filtered
// server-side by the shareCurrentlyListening presence setting. UI says
// "recently", not "online" (presence has first-sync lag by design).

function ListeningNowSection({ users }: { users: HSListeningNowUser[] }) {
  const colors = useColors()
  const styles = useStyles()
  return (
    <View style={styles.section}>
      <AppText variant="eyebrow" color={colors.textMuted}>
        {users.length} listening recently
      </AppText>
      <View style={styles.finishedByRow}>
        {users.map((u) => (
          <View key={u.userId} style={styles.finishedByChip}>
            <View>
              <Avatar
                uri={avatarUrl(u.userId)}
                size={28}
                name={u.username}
                hue={coverHue(u.userId)}
              />
              <View style={styles.listeningPulse} />
            </View>
            <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
              {u.username}
            </AppText>
          </View>
        ))}
      </View>
    </View>
  )
}

// ---- Notes opener ----
// A compact opener that fetches a lightweight count and pushes into the full
// NotesSheet. Hidden when notes are turned off on the server.

function NotesSection({ onOpen }: { onOpen: () => void }) {
  const colors = useColors()
  const styles = useStyles()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [enabled, setEnabled] = useState(true)
  const [count, setCount] = useState(0)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    // A position of 0 fetches only ungated/own notes for the count teaser; the
    // real (position-gated) list loads when the sheet opens.
    getNotes({ libraryItemId: id, position: 0 })
      .then((res) => {
        if (cancelled) return
        setEnabled(res.enabled)
        setCount(res.notes.length + res.hiddenAhead)
      })
      .catch(() => setEnabled(false))
    return () => {
      cancelled = true
    }
  }, [id])

  if (!enabled) return null

  return (
    <Pressable style={styles.section} onPress={onOpen}>
      <View style={styles.chaptersHeader}>
        <AppText variant="title">Notes</AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <AppText variant="caption" color={colors.textMuted}>
            {count > 0 ? `${count} · View all` : 'Add the first'}
          </AppText>
          <Icon name={icons.chevronRight} size={18} color={colors.textMuted} />
        </View>
      </View>
    </Pressable>
  )
}

// ---- Series ----

function SeriesCard({
  series,
  highlight,
  onPress,
}: {
  series: ABSSeries
  /** Finished books promote the series card: the next book is the story now. */
  highlight: boolean
  onPress: () => void
}) {
  const colors = useColors()
  const styles = useStyles()
  return (
    <Touchable style={styles.seriesCard} onPress={onPress}>
      <View style={styles.seriesCovers}>
        {series.books.slice(0, 3).map((b, i) => (
          <Cover
            key={b.id}
            uri={coverUrl(b.id)}
            size={42}
            radius={radius.tile}
            style={{ position: 'absolute', left: i * 11, zIndex: 3 - i }}
            fallback={{
              hue: coverHue(b.id),
              initial: (b.media.metadata.title || '?').charAt(0).toUpperCase(),
            }}
          />
        ))}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="eyebrow" color={colors.textMuted}>
          {highlight ? 'Next in series' : 'Series'}
        </AppText>
        <AppText variant="label" numberOfLines={1} style={{ marginTop: 2 }}>
          {series.name}
        </AppText>
      </View>
      <Icon name={icons.chevronRight} size={22} color={colors.textMuted} />
    </Touchable>
  )
}

// ---- Chapters ----

function ChapterRow({
  chapter,
  index,
  current,
  finished,
  currentTime,
  onPress,
}: {
  chapter: ABSChapter
  index: number
  current: boolean
  finished: boolean
  currentTime: number
  onPress: () => void
}) {
  const colors = useColors()
  const styles = useStyles()
  return (
    <Touchable style={[styles.chapterRow, current && styles.chapterRowNow]} onPress={onPress}>
      <Icon
        name={current ? icons.nowPlaying : finished ? icons.checkCircle : icons.play}
        size={20}
        color={current ? colors.accent : finished ? colors.success : colors.textMuted}
      />
      <AppText
        variant="meta"
        numberOfLines={1}
        style={[{ flex: 1 }, current && { fontWeight: '600' }]}
      >
        {chapter.title || `Chapter ${index + 1}`}
      </AppText>
      <AppText variant="mono" color={current ? colors.text : colors.textMuted}>
        {current
          ? `${formatDuration(Math.max(0, chapter.end - currentTime))} left`
          : formatTimestamp(Math.max(0, chapter.end - chapter.start))}
      </AppText>
    </Touchable>
  )
}

function ChaptersPreview({
  chapters,
  currentChapterIndex,
  currentTime,
  isFinished,
  isInProgress,
  onOpenAll,
  onPlayFrom,
}: {
  chapters: ABSChapter[]
  currentChapterIndex: number
  currentTime: number
  isFinished: boolean
  isInProgress: boolean
  onOpenAll: () => void
  onPlayFrom: (startSec: number) => Promise<void>
}) {
  const colors = useColors()
  const styles = useStyles()
  // In progress, the preview window starts at the current chapter; otherwise the top.
  const start = currentChapterIndex > 0 ? currentChapterIndex : 0
  const window = chapters.slice(start, start + CHAPTER_PREVIEW_COUNT)
  return (
    <View style={styles.section}>
      <Pressable style={styles.chaptersHeader} onPress={onOpenAll}>
        <AppText variant="title">Chapters</AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
          <AppText variant="caption" color={colors.textMuted}>
            {chapters.length} · View all
          </AppText>
          <Icon name={icons.chevronRight} size={18} color={colors.textMuted} />
        </View>
      </Pressable>
      {window.map((c, i) => {
        const idx = start + i
        const current = idx === currentChapterIndex
        return (
          <ChapterRow
            key={c.id ?? idx}
            chapter={c}
            index={idx}
            current={current}
            finished={isFinished || (isInProgress && c.end <= currentTime)}
            currentTime={currentTime}
            onPress={() => void onPlayFrom(current ? currentTime : c.start)}
          />
        )
      })}
    </View>
  )
}

// ---- Sessions sheet ----

const SessionsSheet = ({
  ref,
  itemId,
  onJump,
}: {
  ref: React.RefObject<SheetRef | null>
  itemId: string
  onJump: (sec: number) => Promise<void>
}) => {
  const colors = useColors()
  const styles = useStyles()
  const [sessions, setSessions] = useState<ABSListeningSession[] | null>(null)

  const load = useCallback(() => {
    getRecentSessions()
      .then((all) => setSessions(all.filter((s) => s.libraryItemId === itemId)))
      .catch(() => setSessions([]))
  }, [itemId])

  return (
    <Sheet ref={ref} title="Previous sessions" snapPoints={['50%']}>
      <BottomSheetScrollView
        contentContainerStyle={{ paddingBottom: spacing.xxl }}
        onLayout={() => {
          if (sessions === null) load()
        }}
      >
        {sessions === null ? (
          <AppText variant="meta" color={colors.textMuted} style={{ paddingVertical: spacing.lg }}>
            Loading…
          </AppText>
        ) : sessions.length === 0 ? (
          <AppText variant="meta" color={colors.textMuted} style={{ paddingVertical: spacing.lg }}>
            No recent sessions for this book.
          </AppText>
        ) : (
          sessions.map((s) => (
            <Touchable
              key={s.id}
              style={styles.sessionRow}
              onPress={() => void onJump(s.currentTime)}
            >
              <Icon name={icons.recent} size={20} color={colors.textMuted} />
              <View style={{ flex: 1 }}>
                <AppText variant="meta">
                  {new Date(s.updatedAt).toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                  })}
                  {' · '}
                  {formatDuration(s.timeListening)} listened
                </AppText>
              </View>
              <AppText variant="mono" color={colors.textMuted}>
                {formatTimestamp(s.currentTime)}
              </AppText>
            </Touchable>
          ))
        )}
      </BottomSheetScrollView>
    </Sheet>
  )
}

// ---- Overflow bits ----

function SheetRow({
  icon,
  label,
  onPress,
}: {
  icon: (typeof icons)[keyof typeof icons]
  label: string
  onPress: () => void
}) {
  const colors = useColors()
  const styles = useStyles()
  return (
    <Touchable style={styles.sheetRow} onPress={onPress}>
      <Icon name={icon} size={21} color={colors.textMuted} />
      <AppText variant="body">{label}</AppText>
    </Touchable>
  )
}

function FileInfoLine({ detail }: { detail: ABSLibraryItemDetail }) {
  const colors = useColors()
  const files = detail.media.audioFiles
  if (files.length === 0) return null
  const first = files[0]
  const parts = [
    `${files.length} file${files.length === 1 ? '' : 's'}`,
    first.codec ? first.codec.toUpperCase() : null,
    first.bitRate ? `${Math.round(first.bitRate / 1000)} kbps` : null,
    formatBytes(detail.media.size) || null,
  ].filter(Boolean)
  return (
    <AppText variant="mono" color={colors.textFaint} style={{ paddingTop: spacing.md }}>
      {parts.join(' · ')}
    </AppText>
  )
}

// ---- Header ----

function Header({
  onBack,
  bookmarkCount = 0,
  onBookmarks,
  onOverflow,
}: {
  onBack: () => void
  bookmarkCount?: number
  onBookmarks?: () => void
  onOverflow?: () => void
}) {
  const colors = useColors()
  const styles = useStyles()
  return (
    <View style={styles.header}>
      <IconButton name={icons.back} onPress={onBack} style={styles.headerBtn} />
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        {onBookmarks && bookmarkCount > 0 ? (
          <View>
            <IconButton
              name={icons.bookmarks}
              size={20}
              onPress={onBookmarks}
              style={styles.headerBtn}
            />
            <View style={styles.badge}>
              <AppText variant="caption" color={colors.onAccent} style={styles.badgeText}>
                {bookmarkCount}
              </AppText>
            </View>
          </View>
        ) : null}
        {onOverflow ? (
          <IconButton name={icons.more} onPress={onOverflow} style={styles.headerBtn} />
        ) : null}
      </View>
    </View>
  )
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    headerBtn: {
      width: 42,
      height: 42,
      borderRadius: 21,
      backgroundColor: colors.fill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badge: {
      position: 'absolute',
      top: -3,
      right: -3,
      minWidth: 17,
      height: 17,
      borderRadius: 9,
      paddingHorizontal: 4,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeText: { fontSize: 10, fontWeight: '700', lineHeight: 12 },
    hero: { alignItems: 'center', paddingHorizontal: spacing.xl },
    title: { textAlign: 'center', marginTop: spacing.lg },
    subtitle: { textAlign: 'center', marginTop: spacing.xs, fontSize: 14 },
    byline: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    statusCard: {
      marginHorizontal: spacing.lg,
      marginTop: spacing.lg,
      padding: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      gap: spacing.sm,
    },
    statusCardRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    progressTrack: {
      height: 5,
      borderRadius: 3,
      backgroundColor: colors.elevated,
      overflow: 'hidden',
    },
    progressFill: { height: '100%', backgroundColor: colors.accent, borderRadius: 3 },
    ctaRow: {
      flexDirection: 'row',
      gap: spacing.sm + 2,
      marginHorizontal: spacing.lg,
      marginTop: spacing.md,
    },
    square: {
      minWidth: 52,
      paddingHorizontal: spacing.xs,
      borderRadius: radius.card,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 2,
    },
    // Holds the Finish square + its ember-burst overlay; embers may rise above.
    burstWrap: { alignSelf: 'stretch', overflow: 'visible' },
    squareActive: {
      backgroundColor: colors.accentWash,
      borderColor: colors.accent,
    },
    section: { paddingHorizontal: spacing.lg, marginTop: spacing.xl },
    finishedByRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: spacing.md,
      marginTop: spacing.sm,
    },
    finishedByChip: { alignItems: 'center', width: 64, gap: spacing.xs },
    // A small accent dot on the avatar's corner marking active listening.
    listeningPulse: {
      position: 'absolute',
      right: -1,
      bottom: -1,
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: colors.accent,
      borderWidth: 1.5,
      borderColor: colors.scaffold,
    },
    seriesCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginHorizontal: spacing.lg,
      marginTop: spacing.lg,
      padding: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    seriesCovers: { width: 56, height: 46 },
    chaptersHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.sm,
    },
    chapterRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
    },
    chapterRowNow: {
      backgroundColor: colors.rowNow,
      borderRadius: radius.row,
      borderBottomWidth: 0,
      paddingHorizontal: spacing.md,
      marginHorizontal: -spacing.sm,
    },
    bookmarkRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.xs,
    },
    bookmarkTap: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
    },
    sessionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
    },
    sheetRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.lg,
      paddingVertical: spacing.md + 2,
    },
  })

// Memoized stylesheet for the active theme, shared by the section components.
function useStyles() {
  const colors = useColors()
  return useMemo(() => makeStyles(colors), [colors])
}
