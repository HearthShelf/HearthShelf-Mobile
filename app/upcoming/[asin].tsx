/**
 * Upcoming / unowned book page. Distinct from the owned-item page (app/item):
 * this is for a book you don't have yet - typically an unreleased Audible title
 * from a series you're partway through. Shows the cover, release date + a live
 * countdown, a Follow toggle (get notified when it lands), and a Buy-on-Audible
 * link. Reached from the series screen's missing books, the Home countdown
 * banner, or a push deep-link.
 *
 * The book data comes from the followed-subscription (if any) so it renders
 * instantly; otherwise it's fetched by ASIN. Both carry the full display payload.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { Linking, ScrollView, StyleSheet, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import { useLocalSearchParams, useRouter } from 'expo-router'
import {
  coverHue,
  countdownLabel,
  daysUntilRelease,
  isUpcoming,
  type HSAudibleSearchResult,
} from '@hearthshelf/core'
import { fetchAudibleProduct, audibleStoreUrl } from '@/api/absAudible'
import {
  getSubscriptionsState,
  subscribeSubscriptions,
  findSubscription,
  subscribe,
  unsubscribe,
} from '@/player/subscriptions'
import {
  AppText,
  Centered,
  Cover,
  IconButton,
  Loading,
  Screen,
  Touchable,
  icons,
} from '@/ui/primitives'
import { CoverLightbox } from '@/ui/CoverLightbox'
import { Icon } from '@/ui/icons'
import { DUR } from '@/ui/motion'
import { haptics } from '@/ui/haptics'
import { formatDuration } from '@hearthshelf/core'
import { radius, spacing, type Palette } from '@/ui/theme'
import { useTheme } from '@/ui/ThemeProvider'

// A book the page can render: the Audible result shape plus an optional series
// sequence (present on subscriptions + series-roster books).
type UpcomingBook = HSAudibleSearchResult & { sequence?: string | null; seriesTitle?: string }

export default function UpcomingBookScreen() {
  const { asin } = useLocalSearchParams<{ asin: string }>()
  const router = useRouter()
  const styles = useStyles()
  const { colors } = useTheme()

  const { subscriptions } = useSyncExternalStore(subscribeSubscriptions, getSubscriptionsState)
  // The followed book (if any), converted to the page's book shape. A book sub
  // always has an asin, so it's safe to coalesce to the route asin.
  const existing = useMemo<UpcomingBook | null>(() => {
    const sub = subscriptions.find((s) => s.kind === 'book' && s.asin === asin)
    if (!sub) return null
    return {
      asin: sub.asin ?? String(asin),
      title: sub.title,
      author: sub.author ?? '',
      seriesAsin: sub.seriesAsin,
      seriesTitle: sub.seriesTitle,
      sequence: sub.sequence,
      coverArtUrl: sub.coverArtUrl,
      narrator: sub.narrator,
      durationMinutes: sub.durationMinutes,
      releaseDate: sub.releaseDate,
      publicationDatetime: sub.publicationDatetime,
    }
  }, [subscriptions, asin])

  const [book, setBook] = useState<UpcomingBook | null>(existing)
  const [loading, setLoading] = useState(!existing)
  const [lightbox, setLightbox] = useState(false)
  const [busy, setBusy] = useState(false)

  // Fetch when we don't already have the book from a subscription.
  useEffect(() => {
    if (existing) {
      setBook(existing)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void (async () => {
      const p = await fetchAudibleProduct(String(asin))
      if (!cancelled) {
        setBook(p)
        setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [asin, existing])

  if (loading) {
    return (
      <Screen>
        <Header onBack={() => router.back()} />
        <Loading />
      </Screen>
    )
  }
  if (!book) {
    return (
      <Screen>
        <Header onBack={() => router.back()} />
        <Centered>
          <AppText variant="meta" color={colors.textMuted}>
            Couldn't load this book.
          </AppText>
        </Centered>
      </Screen>
    )
  }

  const now = Date.now()
  const followed = !!findSubscription({ kind: 'book', asin: book.asin })
  const upcoming = isUpcoming(book, now)
  const days = daysUntilRelease(book, now)
  const countdown = countdownLabel(book, now)
  const hue = coverHue(book.asin)
  const seriesLine =
    book.seriesTitle && book.sequence
      ? `${book.seriesTitle}, Book ${book.sequence}`
      : (book.series ?? book.seriesTitle)

  const toggleFollow = async () => {
    if (busy) return
    setBusy(true)
    haptics.select()
    try {
      if (followed) {
        const sub = findSubscription({ kind: 'book', asin: book.asin })
        if (sub) await unsubscribe(sub.id)
      } else {
        await subscribe({
          kind: 'book',
          asin: book.asin,
          seriesAsin: book.seriesAsin,
          title: book.title,
          author: book.author,
          seriesTitle: book.seriesTitle,
          sequence: book.sequence ?? null,
          coverArtUrl: book.coverArtUrl,
          narrator: book.narrator,
          durationMinutes: book.durationMinutes,
          releaseDate: book.releaseDate,
          publicationDatetime: book.publicationDatetime,
        })
      }
    } catch {
      // Store rolls back optimistically; nothing else to do.
    } finally {
      setBusy(false)
    }
  }

  const metaParts = [
    book.durationMinutes ? formatDuration(book.durationMinutes * 60) : null,
    book.narrator ? `Narrated by ${book.narrator}` : null,
  ].filter(Boolean)

  return (
    <Screen>
      <Header onBack={() => router.back()} />
      <ScrollView contentContainerStyle={{ paddingBottom: spacing.xxl }}>
        <Animated.View entering={FadeIn.duration(DUR.base)} style={styles.hero}>
          <Touchable onPress={() => setLightbox(true)}>
            <Cover
              uri={book.coverArtUrl}
              size={180}
              radius={radius.card}
              fallback={{ hue, initial: book.title.charAt(0).toUpperCase(), title: book.title }}
            />
          </Touchable>

          {/* Release status pill */}
          {upcoming && countdown ? (
            <View style={styles.releasePill}>
              <Icon name={icons.newRelease} size={15} color={colors.onAccent} />
              <AppText variant="label" color={colors.onAccent}>
                {countdown === 'Out today' ? 'Out today' : `${countdown} until release`}
              </AppText>
            </View>
          ) : null}

          <AppText variant="hero" style={styles.title}>
            {book.title}
          </AppText>
          {seriesLine ? (
            <AppText variant="quote" color={colors.textMuted} style={{ textAlign: 'center' }}>
              {seriesLine}
            </AppText>
          ) : null}
          <AppText variant="label" color={colors.text} style={{ marginTop: spacing.xs }}>
            {book.author || 'Unknown author'}
          </AppText>
          {metaParts.length > 0 ? (
            <AppText variant="mono" color={colors.textMuted} style={{ marginTop: spacing.sm }}>
              {metaParts.join(' · ')}
            </AppText>
          ) : null}
          {book.releaseDate ? (
            <View style={styles.dateRow}>
              <Icon name={icons.calendar} size={15} color={colors.textMuted} />
              <AppText variant="meta" color={colors.textMuted}>
                Releases {formatReleaseDate(book.publicationDatetime || book.releaseDate)}
              </AppText>
            </View>
          ) : null}
        </Animated.View>

        {/* Follow (notify) + Buy on Audible */}
        <View style={styles.actions}>
          <Touchable
            style={[styles.followBtn, followed && styles.followBtnOn]}
            onPress={toggleFollow}
            disabled={busy}
          >
            <Icon
              name={followed ? icons.bellActive : icons.bell}
              size={20}
              color={followed ? colors.onAccent : colors.accent}
            />
            <AppText variant="label" color={followed ? colors.onAccent : colors.accent}>
              {followed
                ? days != null && days > 0
                  ? "We'll notify you"
                  : 'Following'
                : 'Notify me when it’s out'}
            </AppText>
          </Touchable>
          <Touchable
            style={styles.buyBtn}
            onPress={() => Linking.openURL(audibleStoreUrl(book))}
          >
            <AppText variant="label" color={colors.text}>
              View on Audible
            </AppText>
            <Icon name={icons.chevronRight} size={18} color={colors.textMuted} />
          </Touchable>
        </View>

        {book.description ? (
          <View style={styles.descBlock}>
            <AppText variant="body" color={colors.textMuted}>
              {stripHtml(book.description)}
            </AppText>
          </View>
        ) : null}
      </ScrollView>

      <CoverLightbox
        visible={lightbox}
        uri={book.coverArtUrl}
        title={book.title}
        author={book.author}
        hue={hue}
        onClose={() => setLightbox(false)}
      />
    </Screen>
  )
}

function Header({ onBack }: { onBack: () => void }) {
  const styles = useStyles()
  const { colors } = useTheme()
  return (
    <View style={styles.header}>
      <IconButton name={icons.back} size={24} color={colors.text} onPress={onBack} />
    </View>
  )
}

/** "July 14, 2026" from a date or ISO string. Falls back to the raw string. */
function formatReleaseDate(raw: string): string {
  const t = Date.parse(raw)
  if (Number.isNaN(t)) return raw
  return new Date(t).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

/** Strip HTML tags from Audible's publisher_summary for plain display. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
    },
    hero: { alignItems: 'center', paddingHorizontal: spacing.xl, paddingTop: spacing.md },
    releasePill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginTop: spacing.lg,
      paddingVertical: 6,
      paddingHorizontal: spacing.md,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    title: { textAlign: 'center', marginTop: spacing.lg },
    dateRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: spacing.sm },
    actions: { paddingHorizontal: spacing.xl, marginTop: spacing.xl, gap: spacing.md },
    followBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.md + 2,
      borderRadius: radius.card,
      borderWidth: 1.5,
      borderColor: colors.accent,
      backgroundColor: colors.accentWash,
    },
    followBtnOn: { backgroundColor: colors.accent, borderColor: colors.accent },
    buyBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.fill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
    },
    descBlock: { paddingHorizontal: spacing.xl, marginTop: spacing.xl },
  })

function useStyles() {
  const { colors } = useTheme()
  return useMemo(() => makeStyles(colors), [colors])
}
