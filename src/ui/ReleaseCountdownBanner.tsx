/**
 * Home countdown banner: "X days until <book>" for whatever the listener is
 * waiting on whose release falls within their countdown window (settings:
 * notifyCountdownWindowDays, default 14). Renders nothing when nothing
 * qualifies, so it is safe to always mount.
 *
 * Fed from BOTH follow kinds: a book followed directly, and the next book of a
 * followed series. A series subscription carries no date of its own, so this
 * resolves each followed series' roster first - without that, someone who only
 * follows series saw an empty banner, which is the state this screen was in
 * before. Core does the flattening/windowing (pendingReleases + bannerReleases)
 * and the label (countdownLabel), so web, mobile and the notifications job all
 * agree on what "coming soon" means.
 */
import { useMemo, useSyncExternalStore } from 'react'
import { StyleSheet, View } from 'react-native'
import { useRouter } from 'expo-router'
import {
  bannerReleases,
  countdownLabel,
  coverHue,
  daysUntilRelease,
  pendingReleases,
  releaseMs,
} from '@hearthshelf/core'
import { getSubscriptionsState, subscribeSubscriptions } from '@/player/subscriptions'
import { useNextBySeriesAsin, useSeriesRosters } from '@/player/seriesRosters'
import { getDismissalsState, subscribeDismissals } from '@/store/dismissals'
import { getSettingsState, subscribeSettings } from '@/store/settings'
import { AppText, Cover, Touchable } from '@/ui/primitives'
import { fonts, radius, spacing, type Palette } from '@/ui/theme'
import { useTheme } from '@/ui/ThemeProvider'

export function ReleaseCountdownBanner() {
  const router = useRouter()
  const { subscriptions } = useSyncExternalStore(subscribeSubscriptions, getSubscriptionsState)
  const { notifyCountdownWindowDays } = useSyncExternalStore(subscribeSettings, getSettingsState)
  const styles = useStyles()
  const { colors } = useTheme()

  const ignoredAsins = useSyncExternalStore(subscribeDismissals, getDismissalsState).rosterAsins

  // Bucketed to the minute so a roster resolve or a settings change re-derives,
  // but an unrelated re-render does not churn the memo below on every frame.
  const now = useMemo(() => Math.floor(Date.now() / 60_000) * 60_000, [])

  // A series follow has no date of its own - resolve its roster so its next book
  // can reach the banner alongside directly followed books.
  const seriesSubs = useMemo(() => subscriptions.filter((s) => s.kind === 'series'), [subscriptions])
  const rosters = useSeriesRosters(seriesSubs)
  const nextBySeries = useNextBySeriesAsin(seriesSubs, rosters, ignoredAsins ?? [], now)

  // Core does the pure flattening/windowing/sorting.
  const upcoming = useMemo(
    () =>
      bannerReleases(
        pendingReleases(subscriptions, nextBySeries, ignoredAsins ?? []),
        { countdownWindowDays: notifyCountdownWindowDays },
        now,
      ),
    [subscriptions, nextBySeries, ignoredAsins, notifyCountdownWindowDays, now],
  )

  if (upcoming.length === 0) return null
  const soonest = upcoming[0]
  const label = countdownLabel(soonest, now)
  const days = daysUntilRelease(soonest, now)
  const date = releaseDateParts(soonest)
  const series = soonest.seriesTitle
    ? `${soonest.seriesTitle}${soonest.sequence ? ` · Book ${soonest.sequence}` : ''}`
    : null

  return (
    <Touchable
      style={styles.spotlight}
      accessibilityRole="button"
      accessibilityLabel={`Your next release, ${soonest.title}, ${label === 'Out today' ? 'out today' : `${label} until release`}`}
      accessibilityHint="Opens release details"
      onPress={() =>
        router.push(
          soonest.asin
            ? `/upcoming/${encodeURIComponent(soonest.asin)}?from=home`
            : '/settings/notifications',
        )
      }
    >
      {/* Portrait and slightly tilted, as on the web spotlight: square audiobook
          art reads as a book when it's cropped to a portrait card. */}
      <Cover
        uri={soonest.coverArtUrl}
        width={46}
        aspectRatio={2 / 3}
        radius={6}
        fallback={{
          hue: coverHue(soonest.asin ?? soonest.key),
          initial: soonest.title.charAt(0).toUpperCase(),
        }}
        style={styles.cover}
      />

      <View style={styles.copy}>
        <View style={styles.eyebrowRow}>
          <View style={styles.pulse} />
          <AppText variant="eyebrow" color={colors.brandHearth} numberOfLines={1}>
            Your next release
          </AppText>
        </View>
        <AppText numberOfLines={1} style={styles.title}>
          {soonest.title}
        </AppText>
        {soonest.author ? (
          <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
            {soonest.author}
          </AppText>
        ) : null}
        {series ? (
          <AppText variant="caption" color={colors.textFaint} numberOfLines={1}>
            {series}
          </AppText>
        ) : null}
      </View>

      {/* The countdown rail, on its own hairline-separated column. The web
          spotlight stacks the calendar tile above the day count; at this height
          there is only room for one, so the day count wins (it's the thing the
          band exists to answer) and the calendar tile stands in when there is
          no date to count to. */}
      <View style={styles.clock}>
        {days === null ? (
          date ? (
            <View style={styles.calendar}>
              <View style={styles.calendarMonth}>
                <AppText style={[styles.calendarMonthText, { color: colors.onAccent }]}>
                  {date.month}
                </AppText>
              </View>
              <AppText style={styles.calendarDay}>{date.day}</AppText>
            </View>
          ) : (
            // Announced but unscheduled: say so rather than showing a number
            // that would be a lie.
            <>
              <AppText style={[styles.tbd, { color: colors.textMuted }]}>TBD</AppText>
              <AppText variant="caption" color={colors.textMuted}>
                no date yet
              </AppText>
            </>
          )
        ) : (
          <View style={styles.daysWrap}>
            {/* Word, not numeral, on release day - so it renders at the smaller
                size the rail can actually fit. */}
            <AppText style={days === 0 ? styles.word : styles.daysNumber} numberOfLines={2}>
              {days === 0 ? 'Out today' : days}
            </AppText>
            {days === 0 ? null : (
              <AppText variant="caption" color={colors.textMuted}>
                {days === 1 ? 'day away' : 'days away'}
              </AppText>
            )}
          </View>
        )}
      </View>
    </Touchable>
  )
}

/** Month/day for the calendar tile, or null when the release has no date. */
function releaseDateParts(item: {
  publicationDatetime?: string
  releaseDate?: string
}): { month: string; day: string } | null {
  const ms = releaseMs(item)
  if (ms === null) return null
  const d = new Date(ms)
  return {
    month: d.toLocaleDateString(undefined, { month: 'short' }).toUpperCase(),
    day: String(d.getDate()),
  }
}

// Sized and inset to sit in the same rhythm as the dashboard's Up-next/stats
// cards directly above it (minHeight 96, spacing.md margins, radius.card), so
// the three read as one band rather than three unrelated widths.
const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    spotlight: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      minHeight: 96,
      marginHorizontal: spacing.md,
      marginTop: spacing.md,
      paddingHorizontal: 14,
      paddingVertical: spacing.md,
      borderRadius: radius.card,
      backgroundColor: colors.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      overflow: 'hidden',
    },
    cover: { transform: [{ rotate: '-1.2deg' }] },
    copy: { flex: 1, minWidth: 0 },
    eyebrowRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    pulse: {
      width: 7,
      height: 7,
      borderRadius: 4,
      backgroundColor: colors.accent,
    },
    title: {
      fontFamily: fonts.brand,
      fontSize: 15,
      letterSpacing: -0.3,
      marginTop: 3,
      marginBottom: 1,
      color: colors.text,
    },
    clock: {
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      paddingLeft: spacing.md,
      borderLeftWidth: StyleSheet.hairlineWidth,
      borderLeftColor: colors.hairline,
      alignSelf: 'stretch',
      minWidth: 74,
    },
    calendar: {
      width: 38,
      borderRadius: 7,
      overflow: 'hidden',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      backgroundColor: colors.fill,
    },
    calendarMonth: {
      backgroundColor: colors.accent,
      alignItems: 'center',
      paddingVertical: 1,
    },
    calendarMonthText: { fontSize: 8, fontWeight: '800', letterSpacing: 0.8 },
    calendarDay: {
      fontFamily: fonts.brand,
      fontSize: 16,
      textAlign: 'center',
      color: colors.text,
      paddingVertical: 1,
    },
    daysWrap: { alignItems: 'center' },
    daysNumber: {
      fontFamily: fonts.brand,
      fontSize: 22,
      lineHeight: 24,
      letterSpacing: -1,
      color: colors.text,
    },
    tbd: { fontFamily: fonts.brand, fontSize: 17 },
    // Words in the rail (release day) sit smaller and centered than a numeral
    // would - "Out today" at the day-count size would not fit the column.
    word: {
      fontFamily: fonts.brand,
      fontSize: 14,
      lineHeight: 17,
      textAlign: 'center',
      color: colors.text,
    },
  })

function useStyles() {
  const { colors } = useTheme()
  return useMemo(() => makeStyles(colors), [colors])
}
