/**
 * Following: everything the listener is waiting on, in one place.
 *
 * Settings > Notifications also lists follows, but that list exists to explain
 * what the notification toggles act on - it is a settings surface. This is the
 * destination you actually visit to ask "what's coming?", so it groups by state
 * (counting down / arrived / series) and, for a followed series, resolves which
 * book is next in it - a series follow carries no release date of its own.
 *
 * Tapping a book opens its upcoming page (app/upcoming/[asin]), which owns the
 * follow toggle and the buy link.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { SectionList, StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import {
  countdownLabel,
  coverHue,
  nextSeriesBook,
  releaseMs,
  type HSAudibleSeriesBook,
  type HSSubscription,
} from '@hearthshelf/core'
import { fetchAudibleSeriesByAsin } from '@/api/absAudible'
import {
  getSubscriptionsState,
  subscribeSubscriptions,
  refreshSubscriptions,
} from '@/player/subscriptions'
import { AppText, Cover, Loading, Screen, Touchable, icons, IconButton } from '@/ui/primitives'
import { AppTabBar } from '@/ui/AppTabBar'
import { useColors } from '@/ui/ThemeProvider'
import { radius, spacing, type Palette } from '@/ui/theme'

function releaseDateLabel(item: { publicationDatetime?: string; releaseDate?: string }): string | null {
  const ms = releaseMs(item)
  if (ms === null) return null
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/** The next book in a followed series, resolved from its roster. Null until it
 *  loads, on a server that can't answer, or when nothing is left. */
function useNextInSeries(seriesAsin: string | undefined): HSAudibleSeriesBook | null {
  const [next, setNext] = useState<HSAudibleSeriesBook | null>(null)
  useEffect(() => {
    let alive = true
    if (!seriesAsin) return
    void (async () => {
      const roster = await fetchAudibleSeriesByAsin(seriesAsin)
      if (!alive || !roster.seriesAsin) return
      setNext(nextSeriesBook(roster.books, Date.now()))
    })()
    return () => {
      alive = false
    }
  }, [seriesAsin])
  return next
}

function SeriesNextLine({ seriesAsin }: { seriesAsin: string }) {
  const colors = useColors()
  const next = useNextInSeries(seriesAsin)
  if (!next) return null
  // "Next" is the first gap in reading order, which may already be out (a book
  // you haven't picked up) or still unreleased - say which.
  const upcoming = next.upcoming ?? false
  const countdown = upcoming ? countdownLabel(next, Date.now()) : null
  const when = upcoming
    ? `coming ${releaseDateLabel(next) ?? 'soon'}${countdown ? ` · ${countdown}` : ''}`
    : 'out now, not in your library'
  return (
    <AppText variant="caption" color={colors.textFaint} numberOfLines={1} style={{ marginTop: 2 }}>
      Next: {next.title} · {when}
    </AppText>
  )
}

function FollowRow({ sub, onPress }: { sub: HSSubscription; onPress: () => void }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const isSeries = sub.kind === 'series'
  const now = Date.now()

  let status: string
  if (isSeries) status = 'Every new book tracked'
  else if (sub.available) status = 'Available now'
  else {
    const d = releaseDateLabel(sub)
    const c = countdownLabel(sub, now)
    status = d ? `Coming ${d}${c ? ` · ${c}` : ''}` : 'Coming soon'
  }

  return (
    <Touchable onPress={onPress} style={styles.row}>
      <Cover
        uri={sub.coverArtUrl}
        size={52}
        radius={radius.tile}
        fallback={{
          hue: coverHue(sub.asin ?? sub.seriesAsin ?? sub.id),
          initial: (sub.title || '?').charAt(0).toUpperCase(),
        }}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <AppText variant="label" numberOfLines={1}>
          {sub.title}
        </AppText>
        <AppText
          variant="caption"
          color={sub.available ? colors.accent : colors.textMuted}
          numberOfLines={1}
          style={{ marginTop: 2 }}
        >
          {status}
        </AppText>
        {isSeries && sub.seriesAsin ? <SeriesNextLine seriesAsin={sub.seriesAsin} /> : null}
      </View>
      <IconButton
        name={isSeries ? icons.collections : sub.available ? icons.check : icons.newRelease}
        size={16}
        color={colors.textFaint}
      />
    </Touchable>
  )
}

export default function FollowingScreen() {
  const router = useRouter()
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { subscriptions, loaded } = useSyncExternalStore(
    subscribeSubscriptions,
    getSubscriptionsState,
  )

  useEffect(() => {
    void refreshSubscriptions()
  }, [])

  const sections = useMemo(() => {
    const byRelease = (a: HSSubscription, b: HSSubscription) =>
      (releaseMs(a) ?? Infinity) - (releaseMs(b) ?? Infinity)
    const books = subscriptions.filter((s) => s.kind === 'book')
    const out = [
      { title: 'Counting down', data: books.filter((s) => !s.available).sort(byRelease) },
      { title: 'Arrived', data: books.filter((s) => s.available).sort(byRelease) },
      { title: 'Series you follow', data: subscriptions.filter((s) => s.kind === 'series') },
    ]
    return out.filter((s) => s.data.length > 0)
  }, [subscriptions])

  const goToTab = (tabName: string) => {
    router.dismissAll?.()
    router.replace(tabName === 'index' ? '/(tabs)' : `/(tabs)/${tabName}`)
  }

  if (!loaded) return <Loading label="Loading what you follow" />

  return (
    <Screen tabBar={<AppTabBar activeName="more" onPressTab={goToTab} />}>
      <View style={styles.header}>
        <IconButton name={icons.back} onPress={() => router.back()} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText variant="hero" numberOfLines={1}>
            Following
          </AppText>
          <AppText variant="caption" color={colors.textMuted}>
            Books and series you are waiting on
          </AppText>
        </View>
      </View>

      {sections.length === 0 ? (
        <View style={styles.empty}>
          <AppText variant="title">Nothing followed yet</AppText>
          <AppText variant="meta" color={colors.textMuted} style={{ textAlign: 'center' }}>
            Follow a series to track every future book, or an upcoming book to be told the
            moment it lands.
          </AppText>
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(s) => s.id}
          contentContainerStyle={{ paddingBottom: spacing.xxl }}
          renderSectionHeader={({ section }) => (
            <AppText variant="meta" color={colors.textMuted} style={styles.sectionHead}>
              {section.title}
            </AppText>
          )}
          renderItem={({ item }) => (
            <FollowRow
              sub={item}
              onPress={() => {
                // Only a book has its own page; a series follow opens nothing
                // until we know which ABS series it maps to.
                if (item.kind === 'book' && item.asin) {
                  router.push(`/upcoming/${encodeURIComponent(item.asin)}`)
                }
              }}
            />
          )}
        />
      )}
    </Screen>
  )
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.md,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.sm + 2,
      paddingHorizontal: spacing.lg,
    },
    sectionHead: {
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.lg,
      paddingBottom: spacing.xs,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
    },
    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.xl,
    },
  })
}
