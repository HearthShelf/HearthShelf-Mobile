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
  daysUntilRelease,
  isUpcoming,
  nextSeriesBook,
  releaseMs,
  type HSAudibleSeriesBook,
  type HSAudibleSeriesResponse,
  type HSSubscription,
} from '@hearthshelf/core'
import { LinearGradient } from 'expo-linear-gradient'
import { useSeriesRosters } from '@/player/seriesRosters'
import { getDismissalsState, subscribeDismissals } from '@/store/dismissals'
import {
  getSubscriptionsState,
  subscribeSubscriptions,
  refreshSubscriptions,
  unsubscribe,
} from '@/player/subscriptions'
import { AppText, Cover, Loading, Screen, Touchable, icons, IconButton } from '@/ui/primitives'
import { AppTabBar, useGoToTab, useNavActiveName } from '@/ui/AppTabBar'
import { CoverGlow } from '@/ui/CoverGlow'
import { haptics } from '@/ui/haptics'
import { Icon } from '@/ui/icons'
import { showToast } from '@/ui/Toast'
import { useColors, useTheme } from '@/ui/ThemeProvider'
import { fonts, radius, spacing, withAlpha, type Palette } from '@/ui/theme'
import { upcomingBookPath } from '@/lib/upcomingBookRoute'

function releaseDateLabel(item: {
  publicationDatetime?: string
  releaseDate?: string
}): string | null {
  const ms = releaseMs(item)
  if (ms === null) return null
  return new Date(ms).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

type FollowingSectionKind = 'upcoming' | 'arrived' | 'series'

type Dated = { publicationDatetime?: string; releaseDate?: string }

interface ResolvedSeries {
  sub: HSSubscription
  roster: HSAudibleSeriesResponse | null | undefined
  next: HSAudibleSeriesBook | null
  cover?: string
}

/** One upcoming book flattened from either source. `sub` remains the follow
 *  that produced it, so the UI can distinguish "Following series" from a
 *  directly followed book. */
interface UpcomingRelease {
  key: string
  title: string
  author?: string
  narrator?: string
  cover?: string
  seriesTitle?: string
  sequence?: string
  asin?: string
  dates: Dated
  sub: HSSubscription
}

type FollowingRow =
  | { type: 'upcoming'; release: UpcomingRelease }
  | { type: 'arrived'; sub: HSSubscription }
  | { type: 'series'; resolved: ResolvedSeries }

interface FollowingSection {
  title: string
  kind: FollowingSectionKind
  data: FollowingRow[]
}

function releaseDateParts(item: {
  publicationDatetime?: string
  releaseDate?: string
}): { month: string; day: string; full: string } | null {
  const ms = releaseMs(item)
  if (ms === null) return null
  const date = new Date(ms)
  return {
    month: date.toLocaleDateString(undefined, { month: 'short' }).toUpperCase(),
    day: date.toLocaleDateString(undefined, { day: 'numeric' }),
    full: date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
  }
}

function NextReleaseHero({ release, onPress }: { release: UpcomingRelease; onPress: () => void }) {
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const now = Date.now()
  const date = releaseDateParts(release.dates)
  const days = daysUntilRelease(release.dates, now)
  const hue = coverHue(release.asin ?? release.key)
  const series = release.seriesTitle
    ? `${release.seriesTitle}${release.sequence ? ` · Book ${release.sequence}` : ''}`
    : null
  const followsSeries = release.sub.kind === 'series'

  return (
    <Touchable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Next release, ${release.title}${date ? `, ${date.full}` : ''}`}
      accessibilityHint="Opens release details"
      style={[styles.heroCard, shadow.card]}
    >
      <LinearGradient
        pointerEvents="none"
        colors={[withAlpha(hue, 0.34), withAlpha(colors.accent, 0.07), colors.high]}
        locations={[0, 0.56, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <Cover
        uri={release.cover}
        width={116}
        aspectRatio={2 / 3}
        radius={radius.tile}
        fallback={{
          hue,
          initial: release.title.charAt(0).toUpperCase(),
          kicker: release.author,
          title: release.title,
        }}
        style={styles.heroCover}
      />
      <View style={styles.heroBody}>
        <View style={styles.heroKicker}>
          <Icon name={icons.newRelease} size={14} color={colors.accent} />
          <AppText style={styles.heroKickerText}>Next release</AppText>
        </View>
        <AppText numberOfLines={3} maxFontSizeMultiplier={1.15} style={styles.heroTitle}>
          {release.title}
        </AppText>
        <AppText
          variant="caption"
          color={colors.textMuted}
          numberOfLines={1}
          style={styles.heroMeta}
        >
          {release.author ?? 'Author not listed'}
        </AppText>
        {series ? (
          <AppText variant="caption" color={colors.textFaint} numberOfLines={1}>
            {series}
          </AppText>
        ) : null}

        <View style={styles.countdownRow}>
          {date ? (
            <View style={styles.dateTile}>
              <View style={[styles.dateMonth, { backgroundColor: colors.accent }]}>
                <AppText style={[styles.dateMonthText, { color: colors.onAccent }]}>
                  {date.month}
                </AppText>
              </View>
              <AppText style={styles.dateDay}>{date.day}</AppText>
            </View>
          ) : (
            <View style={styles.dateUnknown}>
              <Icon name={icons.calendar} size={20} color={colors.textMuted} />
            </View>
          )}
          {days === null ? (
            <AppText variant="label" color={colors.textMuted}>
              Date to be announced
            </AppText>
          ) : (
            <>
              <AppText style={styles.countdownNumber}>{days}</AppText>
              <AppText style={[styles.countdownUnit, { color: colors.textMuted }]}>
                {days === 1 ? 'day' : 'days'}
                {'\n'}away
              </AppText>
            </>
          )}
        </View>

        <View style={[styles.followingStatus, { backgroundColor: colors.accent }]}>
          <Icon name={icons.bellActive} size={18} color={colors.onAccent} />
          <AppText style={[styles.followingStatusText, { color: colors.onAccent }]}>
            {followsSeries ? 'Following series' : 'Following'}
          </AppText>
        </View>
      </View>
    </Touchable>
  )
}

type BookReleaseCardProps =
  | { kind: 'upcoming'; release: UpcomingRelease; onPress: () => void }
  | { kind: 'arrived'; sub: HSSubscription; onPress: () => void }

function BookReleaseCard(props: BookReleaseCardProps) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const now = Date.now()
  const arrived = props.kind === 'arrived'
  const title = arrived ? props.sub.title : props.release.title
  const author = arrived ? props.sub.author : props.release.author
  const narrator = arrived ? props.sub.narrator : props.release.narrator
  const cover = arrived ? props.sub.coverArtUrl : props.release.cover
  const asin = arrived ? props.sub.asin : props.release.asin
  const fallbackKey = arrived ? props.sub.id : props.release.key
  const countdown = arrived ? null : countdownLabel(props.release.dates, now)
  const subtitle = [author, narrator].filter(Boolean).join(' · ')
  const status = arrived ? 'Available' : (countdown ?? 'Date TBD')
  const icon = arrived ? icons.checkCircle : countdown ? icons.schedule : icons.calendar
  const statusColor = arrived || countdown ? colors.accent : colors.textFaint

  return (
    <Touchable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${status}`}
      accessibilityHint="Opens release details"
      style={styles.releaseCard}
    >
      <Cover
        uri={cover}
        width={54}
        aspectRatio={0.77}
        radius={radius.tile}
        fallback={{
          hue: coverHue(asin ?? fallbackKey),
          initial: title.charAt(0).toUpperCase(),
        }}
      />
      <View style={styles.releaseCopy}>
        <AppText variant="label" numberOfLines={1}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText
            variant="caption"
            color={colors.textMuted}
            numberOfLines={1}
            style={{ marginTop: 3 }}
          >
            {subtitle}
          </AppText>
        ) : null}
        {arrived ? (
          <AppText
            variant="caption"
            color={colors.textFaint}
            numberOfLines={1}
            style={{ marginTop: 2 }}
          >
            In your library
          </AppText>
        ) : null}
      </View>
      <View
        style={[
          styles.releaseStatus,
          arrived && { backgroundColor: colors.accentWash, borderLeftWidth: 0 },
        ]}
      >
        <Icon name={icon} size={16} color={statusColor} />
        <AppText style={[styles.releaseStatusText, { color: statusColor }]}>{status}</AppText>
      </View>
    </Touchable>
  )
}

function SeriesCoverStack({
  sub,
  roster,
}: {
  sub: HSSubscription
  roster: HSAudibleSeriesResponse | null | undefined
}) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const urls = [sub.coverArtUrl, ...(roster?.books.map((b) => b.coverArtUrl) ?? [])].filter(
    (url, index, all): url is string => Boolean(url) && all.indexOf(url) === index,
  )

  return (
    <View style={styles.coverStack}>
      {[0, 1, 2].map((index) => (
        <View
          key={`${sub.id}-${index}`}
          style={[
            styles.stackCover,
            {
              left: index * 14,
              zIndex: index + 1,
              transform: [{ rotate: index === 0 ? '-5deg' : index === 2 ? '4deg' : '0deg' }],
            },
          ]}
        >
          <Cover
            uri={urls[index]}
            width={42}
            aspectRatio={2 / 3}
            radius={6}
            fallback={{
              hue: coverHue(`${sub.seriesAsin ?? sub.id}-${index}`),
              initial: sub.title.charAt(0).toUpperCase(),
            }}
          />
        </View>
      ))}
    </View>
  )
}

function SeriesFollowCard({ resolved }: { resolved: ResolvedSeries }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const { sub, roster, next } = resolved
  let nextLine =
    roster === undefined ? 'Checking for the next book…' : 'Next book not announced yet'
  if (next) {
    const upcoming = next.upcoming ?? isUpcoming(next, Date.now())
    const countdown = upcoming ? countdownLabel(next, Date.now()) : null
    nextLine = upcoming
      ? `Next: ${next.title} · ${countdown ?? releaseDateLabel(next) ?? 'coming soon'}`
      : `Next: ${next.title} · out now, not in your library`
  }

  const onUnfollow = () => {
    haptics.warn()
    void unsubscribe(sub.id).catch(() => showToast('Could not unfollow that series'))
  }

  return (
    <View style={styles.seriesCard}>
      <SeriesCoverStack sub={sub} roster={roster} />
      <View style={styles.seriesCopy}>
        <AppText variant="label" numberOfLines={1}>
          {sub.title}
        </AppText>
        <View style={styles.trackingLine}>
          <Icon name={icons.bellActive} size={13} color={colors.brandHearth} />
          <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
            Every new book tracked
          </AppText>
        </View>
        <AppText
          variant="caption"
          color={next ? colors.text : colors.textFaint}
          numberOfLines={1}
          style={{ marginTop: spacing.xs }}
        >
          {nextLine}
        </AppText>
      </View>
      <Touchable
        onPress={onUnfollow}
        accessibilityRole="button"
        accessibilityLabel={`Unfollow ${sub.title}`}
        accessibilityHint="Stops tracking new books in this series"
        style={styles.unfollowButton}
      >
        <Icon name={icons.bellOff} size={19} color={colors.textMuted} />
      </Touchable>
    </View>
  )
}

function FollowingSectionHeader({ section }: { section: FollowingSection }) {
  const colors = useColors()
  const styles = useMemo(() => makeStyles(colors), [colors])
  const icon =
    section.kind === 'upcoming'
      ? icons.newRelease
      : section.kind === 'arrived'
        ? icons.checkCircle
        : icons.collections

  return (
    <View style={styles.sectionHead}>
      <Icon name={icon} size={18} color={colors.accent} />
      <AppText variant="label" style={styles.sectionTitle}>
        {section.title}
      </AppText>
      <View style={[styles.sectionCount, { backgroundColor: colors.fill }]}>
        <AppText style={[styles.sectionCountText, { color: colors.textFaint }]}>
          {section.data.length}
        </AppText>
      </View>
    </View>
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

  // Ignored books (an ebook-only side story, a print edition) never surface as
  // something you're waiting on.
  const ignoredAsins = useSyncExternalStore(subscribeDismissals, getDismissalsState).rosterAsins
  const isIgnored = (asin?: string) =>
    Boolean(asin && (ignoredAsins ?? []).some((a) => a.toLowerCase() === asin.toLowerCase()))

  const seriesSubs = useMemo(
    () => subscriptions.filter((sub) => sub.kind === 'series'),
    [subscriptions],
  )
  const seriesRosters = useSeriesRosters(seriesSubs)

  const { hero, sections } = useMemo(() => {
    const books = subscriptions.filter((s) => s.kind === 'book' && !isIgnored(s.asin))
    const resolvedSeries: ResolvedSeries[] = seriesSubs.map((sub) => {
      const roster = seriesRosters[sub.id]
      return {
        sub,
        roster,
        next: roster ? nextSeriesBook(roster.books, Date.now(), ignoredAsins) : null,
        cover: sub.coverArtUrl ?? roster?.books.find((book) => book.coverArtUrl)?.coverArtUrl,
      }
    })

    // Build one release list from BOTH sources. Direct book follows go first so
    // an explicitly followed book owns the row when it is also the next book of
    // a followed series; the ASIN de-dupe prevents showing it twice.
    const directReleases: UpcomingRelease[] = books
      .filter((sub) => !sub.available)
      .map((sub) => ({
        key: sub.id,
        title: sub.title,
        author: sub.author,
        narrator: sub.narrator,
        cover: sub.coverArtUrl,
        seriesTitle: sub.seriesTitle,
        sequence: sub.sequence ?? undefined,
        asin: sub.asin,
        dates: sub,
        sub,
      }))
    const seriesReleases: UpcomingRelease[] = resolvedSeries
      .filter(
        (resolved) =>
          resolved.next && (resolved.next.upcoming ?? isUpcoming(resolved.next, Date.now())),
      )
      .map((resolved) => {
        const next = resolved.next!
        return {
          key: `${resolved.sub.id}:${next.asin}`,
          title: next.title,
          author: next.author || resolved.sub.author,
          narrator: next.narrator,
          cover: next.coverArtUrl ?? resolved.cover,
          seriesTitle: resolved.sub.seriesTitle ?? resolved.sub.title,
          sequence: next.sequence ?? undefined,
          asin: next.asin,
          dates: next,
          sub: resolved.sub,
        }
      })
    const byIdentity = new Map<string, UpcomingRelease>()
    for (const release of [...directReleases, ...seriesReleases]) {
      const identity = release.asin
        ? `asin:${release.asin}`
        : `title:${release.title.trim().toLowerCase()}:${releaseMs(release.dates) ?? 'undated'}`
      const existing = byIdentity.get(identity)
      if (!existing) {
        byIdentity.set(identity, release)
        continue
      }
      // A legacy direct follow can be sparse while the freshly fetched series
      // roster has the date/art. Keep the direct subscription as the owner but
      // fill its missing display fields from the series-derived candidate.
      byIdentity.set(identity, {
        ...existing,
        author: existing.author ?? release.author,
        narrator: existing.narrator ?? release.narrator,
        cover: existing.cover ?? release.cover,
        seriesTitle: existing.seriesTitle ?? release.seriesTitle,
        sequence: existing.sequence ?? release.sequence,
        dates: releaseMs(existing.dates) === null ? release.dates : existing.dates,
      })
    }
    const releases = [...byIdentity.values()].sort(
      (a, b) => (releaseMs(a.dates) ?? Infinity) - (releaseMs(b.dates) ?? Infinity),
    )

    // A countdown hero needs a real date. Undated follows still remain visible
    // in Also coming rather than claiming the star position with no countdown.
    const next = releases.find((release) => releaseMs(release.dates) !== null) ?? null
    const rest = releases.filter((release) => release !== next)
    const arrived = books
      .filter((sub) => sub.available)
      .sort((a, b) => (releaseMs(a) ?? Infinity) - (releaseMs(b) ?? Infinity))
    const out: FollowingSection[] = [
      {
        title: 'Also coming',
        kind: 'upcoming',
        data: rest.map((release) => ({ type: 'upcoming', release })),
      },
      {
        title: 'Arrived',
        kind: 'arrived',
        data: arrived.map((sub) => ({ type: 'arrived', sub })),
      },
      {
        title: 'Series you follow',
        kind: 'series',
        data: resolvedSeries.map((resolved) => ({ type: 'series', resolved })),
      },
    ]
    return { hero: next, sections: out.filter((section) => section.data.length > 0) }
  }, [seriesRosters, seriesSubs, subscriptions])

  const goToTab = useGoToTab()
  // Lights up its own bar icon when pinned there, otherwise More.
  const active = useNavActiveName('following')

  const openRelease = (release: UpcomingRelease) => {
    if (!release.asin) return
    router.push(
      upcomingBookPath(
        {
          asin: release.asin,
          title: release.title,
          author: release.author ?? '',
          narrator: release.narrator,
          coverArtUrl: release.cover,
          seriesTitle: release.seriesTitle,
          seriesAsin: release.sub.seriesAsin,
          sequence: release.sequence,
          releaseDate: release.dates.releaseDate,
          publicationDatetime: release.dates.publicationDatetime,
          upcoming: true,
        },
        'more',
      ),
    )
  }

  const openFollowedBook = (sub: HSSubscription) => {
    if (sub.asin) router.push(`/upcoming/${encodeURIComponent(sub.asin)}?from=more`)
  }

  if (!loaded) return <Loading label="Loading what you follow" />

  return (
    <Screen tabBar={<AppTabBar activeName={active} onPressTab={goToTab} />}>
      {hero ? <CoverGlow hue={coverHue(hero.asin ?? hero.key)} strength={38} height={310} /> : null}
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

      {subscriptions.length === 0 ? (
        <View style={styles.empty}>
          <AppText variant="title">Nothing followed yet</AppText>
          <AppText variant="meta" color={colors.textMuted} style={{ textAlign: 'center' }}>
            Follow a series to track every future book, or an upcoming book to be told the moment it
            lands.
          </AppText>
        </View>
      ) : (
        <SectionList<FollowingRow, FollowingSection>
          sections={sections}
          keyExtractor={(row) =>
            row.type === 'upcoming'
              ? row.release.key
              : row.type === 'arrived'
                ? row.sub.id
                : row.resolved.sub.id
          }
          ListHeaderComponent={
            hero ? <NextReleaseHero release={hero} onPress={() => openRelease(hero)} /> : null
          }
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          stickySectionHeadersEnabled={false}
          renderSectionHeader={({ section }) => <FollowingSectionHeader section={section} />}
          renderItem={({ item }) => {
            if (item.type === 'series') return <SeriesFollowCard resolved={item.resolved} />
            if (item.type === 'arrived') {
              return (
                <BookReleaseCard
                  kind="arrived"
                  sub={item.sub}
                  onPress={() => openFollowedBook(item.sub)}
                />
              )
            }
            return (
              <BookReleaseCard
                kind="upcoming"
                release={item.release}
                onPress={() => openRelease(item.release)}
              />
            )
          }}
        />
      )}
    </Screen>
  )
}

function makeStyles(colors: Palette) {
  return StyleSheet.create({
    header: {
      zIndex: 2,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 62,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
    },
    listContent: {
      paddingTop: spacing.xs,
      paddingBottom: spacing.xxl,
    },
    heroCard: {
      position: 'relative',
      flexDirection: 'row',
      gap: spacing.lg,
      minHeight: 244,
      overflow: 'hidden',
      marginHorizontal: spacing.lg,
      marginTop: spacing.xs,
      padding: spacing.lg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: withAlpha(colors.accent, 0.28),
      borderRadius: radius.card + 6,
      backgroundColor: colors.high,
    },
    heroCover: {
      alignSelf: 'center',
    },
    heroBody: {
      flex: 1,
      minWidth: 0,
      justifyContent: 'center',
    },
    heroKicker: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginBottom: spacing.sm,
    },
    heroKickerText: {
      color: colors.accent,
      fontSize: 10,
      fontWeight: '800',
      letterSpacing: 1.2,
      textTransform: 'uppercase',
    },
    heroTitle: {
      color: colors.text,
      fontFamily: fonts.brand,
      fontSize: 24,
      fontWeight: '700',
      lineHeight: 26,
      letterSpacing: -0.8,
    },
    heroMeta: {
      marginTop: spacing.sm,
      color: colors.textMuted,
    },
    countdownRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    dateTile: {
      width: 42,
      height: 48,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: radius.tile,
      backgroundColor: colors.fill,
    },
    dateMonth: {
      height: 16,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dateMonthText: {
      fontSize: 7,
      fontWeight: '800',
      letterSpacing: 0.8,
    },
    dateDay: {
      flex: 1,
      color: colors.text,
      fontFamily: fonts.brand,
      fontSize: 18,
      lineHeight: 30,
      textAlign: 'center',
    },
    dateUnknown: {
      width: 44,
      height: 48,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.tile,
      backgroundColor: colors.fill,
    },
    countdownNumber: {
      color: colors.text,
      fontFamily: fonts.brand,
      fontSize: 36,
      lineHeight: 40,
      letterSpacing: -2,
    },
    countdownUnit: {
      fontSize: 9,
      fontWeight: '800',
      lineHeight: 12,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
    },
    followingStatus: {
      minHeight: 46,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.sm,
      marginTop: spacing.md,
      borderRadius: radius.row,
    },
    followingStatusText: {
      fontSize: 12,
      fontWeight: '700',
    },
    sectionHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: 48,
      paddingHorizontal: spacing.lg + 2,
      paddingTop: spacing.lg,
      paddingBottom: spacing.sm,
      backgroundColor: 'transparent',
    },
    sectionTitle: {
      flex: 1,
      letterSpacing: -0.1,
    },
    sectionCount: {
      minWidth: 24,
      height: 24,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 7,
      borderRadius: radius.pill,
    },
    sectionCountText: {
      fontFamily: fonts.mono,
      fontSize: 9,
    },
    releaseCard: {
      minHeight: 90,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginHorizontal: spacing.lg,
      marginBottom: spacing.sm,
      paddingVertical: 10,
      paddingHorizontal: 11,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: radius.card,
      backgroundColor: colors.high,
    },
    releaseCopy: {
      flex: 1,
      minWidth: 0,
    },
    releaseStatus: {
      minWidth: 66,
      minHeight: 48,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 3,
      paddingHorizontal: spacing.sm,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: colors.hairline,
      borderRadius: radius.pill,
    },
    releaseStatusText: {
      fontFamily: fonts.mono,
      fontSize: 9,
      fontWeight: '700',
      textAlign: 'center',
    },
    seriesCard: {
      minHeight: 102,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      marginHorizontal: spacing.lg,
      marginBottom: spacing.sm,
      padding: spacing.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      borderRadius: radius.card,
      backgroundColor: colors.high,
    },
    coverStack: {
      position: 'relative',
      width: 70,
      height: 72,
    },
    stackCover: {
      position: 'absolute',
      top: 3,
      overflow: 'hidden',
      borderWidth: 2,
      borderColor: colors.high,
      borderRadius: 8,
      backgroundColor: colors.highest,
    },
    seriesCopy: {
      flex: 1,
      minWidth: 0,
    },
    trackingLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginTop: spacing.xs,
    },
    unfollowButton: {
      width: 48,
      height: 48,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
      backgroundColor: colors.fill,
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
