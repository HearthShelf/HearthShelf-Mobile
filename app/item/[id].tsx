/**
 * Book detail, reskinned to the "Material, warmed" mock (plan section 5): a hue
 * glow header, cover + title/author, an optional series link, a progress/
 * finished/not-started status card, the primary CTA, a chapters preview that
 * opens a full chapter list, a stat strip, and an editorial About blurb.
 *
 * Hidden on purpose (no ABS/app data source, so not stubbed as fake UI):
 * ratings, the social "readers" avatar stack, playlist-add, download. Bookmark
 * and share are ABS-real affordances the app doesn't wire up yet, so their
 * buttons are omitted rather than shown as dead taps.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import type { ABSChapter, ABSLibraryItemDetail, ABSMediaProgress, ABSSeries } from '@hearthshelf/core'
import { coverHue, formatDuration, formatTimestamp, stripHtml } from '@hearthshelf/core'
import { coverUrl, getItemDetail, getLibrarySeries, getMe } from '@/api/abs'
import { requestSeek } from '@/player/store'
import { playItemById } from '@/player/playback'
import {
  AppText,
  Centered,
  Cover,
  IconButton,
  Loading,
  PrimaryButton,
  Screen,
  Sheet,
  type SheetRef,
  icons,
} from '@/ui/primitives'
import { CoverGlow } from '@/ui/CoverGlow'
import { colors, radius, spacing } from '@/ui/theme'

const CHAPTER_PREVIEW_COUNT = 4

export default function ItemDetailScreen() {
  const router = useRouter()
  const { id } = useLocalSearchParams<{ id: string }>()
  const [detail, setDetail] = useState<ABSLibraryItemDetail | null>(null)
  const [progress, setProgress] = useState<ABSMediaProgress | null>(null)
  const [series, setSeries] = useState<ABSSeries | null>(null)
  const [error, setError] = useState<string | null>(null)
  const chaptersSheetRef = useRef<SheetRef>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    void (async () => {
      try {
        const d = await getItemDetail(id)
        if (cancelled) return
        setDetail(d)

        // Progress is best-effort - a failure shouldn't block the rest of Detail.
        getMe()
          .then((me) => {
            if (cancelled) return
            setProgress(me.mediaProgress.find((p) => p.libraryItemId === id) ?? null)
          })
          .catch(() => setProgress(null))

        // Series link: find this book's series among the library's series list.
        const seriesRef = d.media.metadata.series?.[0]
        if (seriesRef) {
          getLibrarySeries(d.libraryId)
            .then((all) => {
              if (cancelled) return
              setSeries(all.find((s) => s.id === seriesRef.id) ?? null)
            })
            .catch(() => setSeries(null))
        }
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

  const isFinished = progress?.isFinished ?? false
  const isInProgress = !isFinished && (progress?.progress ?? 0) > 0
  const isNotStarted = !isFinished && !isInProgress

  const ctaLabel = isFinished ? 'Listen again' : isInProgress ? 'Resume' : 'Start listening'
  const startPosition = isFinished ? 0 : (progress?.currentTime ?? 0)

  const play = async () => {
    await playItemById(detail.id)
    if (startPosition > 0) requestSeek(startPosition)
    router.push('/player')
  }

  const playFromChapter = async (chapter: ABSChapter) => {
    await playItemById(detail.id)
    requestSeek(chapter.start)
    chaptersSheetRef.current?.dismiss()
    router.push('/player')
  }

  return (
    <Screen>
      <View style={StyleSheet.absoluteFill}>
        <CoverGlow hue={hue} height={320} />
      </View>

      <Header onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 160 }} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <Cover
            uri={coverUrl(detail.id)}
            size={172}
            radius={radius.card}
            fallback={{ hue, initial: title.charAt(0).toUpperCase(), title }}
          />
          <AppText variant="hero" style={styles.title}>
            {title}
          </AppText>
          <AppText variant="label" color={colors.textMuted}>
            {meta.authorName || 'Unknown author'}
          </AppText>
        </View>

        {series && (
          <Pressable
            style={styles.seriesCard}
            onPress={() =>
              router.push(
                `/group/series/${encodeURIComponent(series.id)}?libraryId=${encodeURIComponent(detail.libraryId)}&name=${encodeURIComponent(series.name)}`
              )
            }
          >
            <View style={styles.seriesCovers}>
              {series.books.slice(0, 3).map((b, i) => (
                <Cover
                  key={b.id}
                  size={42}
                  radius={radius.tile}
                  style={{ position: 'absolute', left: i * 11, zIndex: 3 - i }}
                  fallback={{ hue: coverHue(b.id), initial: (b.media.metadata.title || '?').charAt(0).toUpperCase() }}
                />
              ))}
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <AppText variant="eyebrow">Series</AppText>
              <AppText variant="label" numberOfLines={1} style={{ marginTop: 2 }}>
                {series.name}
              </AppText>
            </View>
            <IconButton name={icons.chevronRight} color={colors.textMuted} />
          </Pressable>
        )}

        <StatusCard isFinished={isFinished} isInProgress={isInProgress} isNotStarted={isNotStarted} progress={progress} duration={duration} chapterCount={chapters.length} />

        <PrimaryButton label={ctaLabel} icon={icons.play} onPress={play} style={styles.playBtn} />

        {description ? (
          <View style={styles.section}>
            <AppText variant="eyebrow">About</AppText>
            <AppText variant="quote" style={{ marginTop: spacing.sm }}>
              {description}
            </AppText>
            {meta.narratorName ? (
              <AppText variant="meta" color={colors.textMuted} style={{ marginTop: spacing.md }}>
                Narrated by {meta.narratorName}
              </AppText>
            ) : null}
          </View>
        ) : meta.narratorName ? (
          <View style={styles.section}>
            <AppText variant="meta" color={colors.textMuted}>
              Narrated by {meta.narratorName}
            </AppText>
          </View>
        ) : null}

        {chapters.length > 0 ? (
          <View style={styles.section}>
            <Pressable style={styles.chaptersHeader} onPress={() => chaptersSheetRef.current?.present()}>
              <AppText variant="title">Chapters</AppText>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                <AppText variant="caption" color={colors.textMuted}>
                  {chapters.length} · View all
                </AppText>
                <IconButton name={icons.chevronRight} size={18} color={colors.textMuted} />
              </View>
            </Pressable>
            {chapters.slice(0, CHAPTER_PREVIEW_COUNT).map((c, i) => (
              <Pressable
                key={c.id ?? i}
                style={styles.chapterRow}
                onPress={() => chaptersSheetRef.current?.present()}
              >
                <IconButton name={icons.play} size={20} color={colors.textMuted} />
                <AppText variant="meta" numberOfLines={1} style={{ flex: 1 }}>
                  {c.title || `Chapter ${i + 1}`}
                </AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  {formatTimestamp(c.start)}
                </AppText>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={styles.statStrip}>
          <StatCell value={formatDuration(duration)} label="Length" />
          <View style={styles.statDivider} />
          <StatCell value={String(chapters.length)} label="Chapters" />
          <View style={styles.statDivider} />
          <StatCell value={meta.publishedYear || '—'} label="Published" />
        </View>
      </ScrollView>

      <Sheet ref={chaptersSheetRef} title="Chapters" snapPoints={['70%']}>
        <ChaptersList chapters={chapters} onSelect={playFromChapter} />
      </Sheet>
    </Screen>
  )
}

function StatusCard({
  isFinished,
  isInProgress,
  isNotStarted,
  progress,
  duration,
  chapterCount,
}: {
  isFinished: boolean
  isInProgress: boolean
  isNotStarted: boolean
  progress: ABSMediaProgress | null
  duration: number
  chapterCount: number
}) {
  if (isFinished) {
    return (
      <View style={[styles.statusCard, styles.statusCardRow]}>
        <IconButton name={icons.checkCircle} size={22} color={colors.brandHearth} />
        <AppText variant="label">Finished</AppText>
      </View>
    )
  }
  if (isInProgress && progress) {
    const pct = Math.round(progress.progress * 100)
    const chaptersLeft = Math.max(0, Math.round((1 - progress.progress) * chapterCount))
    const remaining = formatDuration(Math.max(0, duration - progress.currentTime))
    return (
      <View style={styles.statusCard}>
        <View style={styles.statusCardRow}>
          <AppText variant="label">
            {pct}% · {chaptersLeft} chapters left
          </AppText>
          <AppText variant="mono" color={colors.textMuted}>
            {remaining}
          </AppText>
        </View>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${pct}%` }]} />
        </View>
      </View>
    )
  }
  if (isNotStarted) {
    return (
      <View style={[styles.statusCard, styles.statusCardRow]}>
        <IconButton name={icons.schedule} size={21} color={colors.textMuted} />
        <AppText variant="meta" color={colors.textMuted}>
          Not started yet
        </AppText>
      </View>
    )
  }
  return null
}

function StatCell({ value, label }: { value: string; label: string }) {
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <AppText variant="mono" style={{ fontWeight: '600' }}>
        {value}
      </AppText>
      <AppText variant="caption" color={colors.textMuted} style={{ marginTop: spacing.xs }}>
        {label}
      </AppText>
    </View>
  )
}

function ChaptersList({
  chapters,
  onSelect,
}: {
  chapters: ABSChapter[]
  onSelect: (c: ABSChapter) => void
}) {
  const rows = useMemo(() => chapters, [chapters])
  return (
    <View>
      {rows.map((c, i) => (
        <Pressable key={c.id ?? i} style={styles.sheetChapterRow} onPress={() => onSelect(c)}>
          <IconButton name={icons.play} size={20} color={colors.textMuted} />
          <AppText variant="body" numberOfLines={1} style={{ flex: 1 }}>
            {c.title || `Chapter ${i + 1}`}
          </AppText>
          <AppText variant="mono" color={colors.textMuted}>
            {formatTimestamp(c.start)}
          </AppText>
        </Pressable>
      ))}
    </View>
  )
}

function Header({ onBack }: { onBack: () => void }) {
  return (
    <View style={styles.header}>
      <IconButton name={icons.back} onPress={onBack} style={styles.headerBtn} />
    </View>
  )
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  headerBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.fill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  hero: { alignItems: 'center', paddingHorizontal: spacing.xl, gap: spacing.xs },
  title: { textAlign: 'center', marginTop: spacing.md },
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
  statusCard: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
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
  playBtn: { marginHorizontal: spacing.lg, marginTop: spacing.md },
  section: { paddingHorizontal: spacing.lg, marginTop: spacing.xl },
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
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
  sheetChapterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  statStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginTop: spacing.xl,
    padding: spacing.lg,
    borderRadius: radius.card,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.hairline,
  },
  statDivider: { width: StyleSheet.hairlineWidth, height: '100%', backgroundColor: colors.hairline },
})
