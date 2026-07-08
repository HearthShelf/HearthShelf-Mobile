/**
 * Stats tab. Real listening stats from /hs/stats (plan section 6.5): a hero
 * total, day-streak + today cards, a this-week bar chart, and a most-listened
 * list. All numbers come from HSListeningStats - no client-side streak/week
 * math outside the getHSStats() fallback path, so this screen and the Home
 * stats strip always agree.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ScrollView, StyleSheet, View } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import {
  formatDuration,
  dayKey,
  coverHue,
  type HSListeningStats,
  type HSLeaderboardEntry,
  type LeaderboardWindow,
} from '@hearthshelf/core'
import { useRouter } from 'expo-router'
import { getHSStats, avatarUrl, coverUrl } from '@/api/abs'
import { getLeaderboard } from '@/api/social'
import {
  AppText,
  Avatar,
  Centered,
  Cover,
  Loading,
  PrimaryButton,
  Screen,
  Touchable,
} from '@/ui/primitives'
import { Seg } from '@/ui/settingsControls'
import { radius, spacing, fonts, type Palette } from '@/ui/theme'
import { useTheme } from '@/ui/ThemeProvider'
import { Icon, icons } from '@/ui/icons'
import { DUR } from '@/ui/motion'
import { useContentInset } from '@/ui/useContentInset'
import { useBackHandler } from '@/ui/useBackHandler'

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

type Status =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; stats: HSListeningStats }

export default function StatsTab() {
  const router = useRouter()
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  const [status, setStatus] = useState<Status>({ phase: 'loading' })
  const contentInset = useContentInset()

  // Non-home tab: hardware back returns to Home rather than exiting the app.
  useBackHandler(
    useCallback(() => {
      router.replace('/(tabs)')
      return true
    }, [router]),
  )

  const load = useCallback(async () => {
    setStatus({ phase: 'loading' })
    try {
      const stats = await getHSStats()
      setStatus({ phase: 'ready', stats })
    } catch (e) {
      setStatus({ phase: 'error', message: (e as Error).message })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (status.phase === 'loading') {
    return (
      <Screen>
        <Loading label="Loading your stats..." />
      </Screen>
    )
  }

  if (status.phase === 'error') {
    return (
      <Screen>
        <Centered>
          <AppText variant="meta" color={colors.destructive} style={{ textAlign: 'center' }}>
            {status.message}
          </AppText>
          <PrimaryButton label="Retry" icon={icons.retry} onPress={load} />
        </Centered>
      </Screen>
    )
  }

  const { stats } = status
  const week = lastSevenDays(stats.byDay)
  const weekMax = Math.max(0.1, ...week.map((d) => d.hours))
  const hasAnyListening = stats.totalTimeSec > 0

  return (
    <Screen>
      <Animated.ScrollView
        entering={FadeIn.duration(DUR.base)}
        contentContainerStyle={{
          padding: spacing.lg,
          paddingBottom: contentInset,
          gap: spacing.lg,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <AppText variant="hero">Your listening</AppText>
          <AppText variant="meta" color={colors.textMuted} style={{ marginTop: 2 }}>
            All time
          </AppText>
        </View>

        {!hasAnyListening ? (
          <Centered>
            <AppText variant="title">Nothing yet</AppText>
            <AppText variant="meta" color={colors.textMuted} style={{ textAlign: 'center' }}>
              Start a book and your streak, hours, and most-listened titles will show up here.
            </AppText>
          </Centered>
        ) : (
          <>
            {/* Day streak + hours listened */}
            <View style={styles.tileRow}>
              <StatCard
                icon={icons.flame}
                value={String(stats.dayStreak)}
                label="Day streak"
                tint={colors.brandHearth}
              />
              <StatCard
                icon={icons.schedule}
                value={formatDuration(stats.totalTimeSec)}
                label="Total listened"
              />
            </View>

            {/* This week */}
            <View style={styles.card}>
              <View style={styles.weekHeader}>
                <AppText variant="label">This week</AppText>
                <AppText variant="mono" color={colors.textMuted}>
                  {formatDuration(stats.weekSec)}
                </AppText>
              </View>
              <View style={styles.weekBars}>
                {week.map((d) => (
                  <View key={d.key} style={styles.weekBarCol}>
                    <View style={styles.weekBarTrack}>
                      <View
                        style={[
                          styles.weekBarFill,
                          {
                            height: `${Math.max(4, (d.hours / weekMax) * 100)}%`,
                            opacity: d.hours > 0 ? 0.4 + (d.hours / weekMax) * 0.6 : 0.15,
                          },
                        ]}
                      />
                    </View>
                    <AppText variant="mono" color={colors.textMuted} style={styles.weekBarLabel}>
                      {d.label}
                    </AppText>
                  </View>
                ))}
              </View>
            </View>

            {/* Most listened */}
            {stats.mostListened.length > 0 && (
              <View>
                <AppText variant="label" style={{ marginBottom: spacing.sm }}>
                  Most listened to
                </AppText>
                <View style={{ gap: spacing.sm }}>
                  {stats.mostListened.slice(0, 8).map((item) => (
                    <Touchable
                      key={item.id}
                      style={styles.listenedRow}
                      onPress={() => router.push(`/item/${item.id}`)}
                    >
                      <Cover
                        uri={coverUrl(item.id)}
                        itemId={item.id}
                        size={44}
                        radius={radius.tile}
                        fallback={{
                          hue: coverHue(item.id),
                          initial: (item.title || '?').charAt(0).toUpperCase(),
                        }}
                      />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <AppText variant="label" numberOfLines={1}>
                          {item.title}
                        </AppText>
                        <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                          {item.author}
                        </AppText>
                      </View>
                      <AppText variant="mono" color={colors.textMuted}>
                        {formatDuration(item.timeSec)}
                      </AppText>
                    </Touchable>
                  ))}
                </View>
              </View>
            )}
          </>
        )}

        {/* Server leaderboard - independent of personal stats above, so it
            renders even for a listener with zero time of their own. Hides
            itself entirely when the server has no ABS db mounted. */}
        <Leaderboard />
      </Animated.ScrollView>
    </Screen>
  )
}

const WINDOW_OPTIONS: { value: LeaderboardWindow; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'all', label: 'All time' },
]

type LeaderboardStatus =
  | { phase: 'loading' }
  | { phase: 'error' }
  | {
      phase: 'ready'
      me: HSLeaderboardEntry | null
      entries: HSLeaderboardEntry[]
      windowsAvailable: boolean
    }
  | { phase: 'hidden' }

function Leaderboard() {
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  const [window, setWindow] = useState<LeaderboardWindow>('month')
  const [status, setStatus] = useState<LeaderboardStatus>({ phase: 'loading' })

  useEffect(() => {
    let cancelled = false
    setStatus((prev) => (prev.phase === 'ready' ? prev : { phase: 'loading' }))
    void (async () => {
      try {
        const res = await getLeaderboard(window)
        if (cancelled) return
        if (!res.available) {
          setStatus({ phase: 'hidden' })
          return
        }
        setStatus({
          phase: 'ready',
          me: res.me,
          entries: res.entries,
          windowsAvailable: res.windowsAvailable ?? false,
        })
      } catch {
        if (!cancelled) setStatus({ phase: 'error' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [window])

  if (status.phase === 'hidden' || status.phase === 'error') return null

  return (
    <View>
      <View style={styles.leaderboardHeader}>
        <AppText variant="label">Leaderboard</AppText>
        {status.phase === 'ready' && status.windowsAvailable ? (
          <Seg value={window} onChange={setWindow} options={WINDOW_OPTIONS} />
        ) : null}
      </View>
      {status.phase === 'loading' ? (
        <View style={[styles.card, { alignItems: 'center', paddingVertical: spacing.xl }]}>
          <Loading label="Loading leaderboard..." />
        </View>
      ) : status.entries.length === 0 ? (
        <View style={styles.card}>
          <AppText variant="meta" color={colors.textMuted} style={{ textAlign: 'center' }}>
            No one on the leaderboard yet.
          </AppText>
        </View>
      ) : (
        <View style={{ gap: spacing.sm }}>
          {status.entries.slice(0, 20).map((entry) => (
            <View
              key={entry.userId}
              style={[styles.leaderboardRow, entry.isMe && styles.leaderboardRowMe]}
            >
              <AppText
                variant="mono"
                color={entry.isMe ? colors.accent : colors.textMuted}
                style={styles.leaderboardRank}
              >
                {entry.rank}
              </AppText>
              <Avatar
                uri={avatarUrl(entry.userId)}
                size={36}
                name={entry.username}
                hue={coverHue(entry.userId)}
              />
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="label" numberOfLines={1}>
                  {entry.username}
                  {entry.isMe ? ' (you)' : ''}
                </AppText>
                <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
                  {entry.booksFinished} finished
                </AppText>
              </View>
              <AppText variant="mono" color={colors.textMuted}>
                {formatDuration(entry.secondsListened)}
              </AppText>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

function StatCard({
  icon,
  value,
  label,
  tint,
}: {
  icon: (typeof icons)[keyof typeof icons]
  value: string
  label: string
  tint?: string
}) {
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  const iconTint = tint ?? colors.text
  return (
    <View style={[styles.card, styles.statCard]}>
      <Icon name={icon} size={22} color={iconTint} />
      <AppText variant="hero" style={{ marginTop: spacing.sm, fontFamily: fonts.mono }}>
        {value}
      </AppText>
      <AppText variant="caption" color={colors.textMuted}>
        {label}
      </AppText>
    </View>
  )
}

/** Last 7 local days (oldest -> newest) from a byDay map, in hours. */
function lastSevenDays(byDay: Record<string, number>) {
  const now = new Date()
  const out: { key: string; label: string; hours: number }[] = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = dayKey(d)
    out.push({ key, label: DAY_LABELS[d.getDay()], hours: (byDay[key] ?? 0) / 3600 })
  }
  return out
}

const makeStyles = (colors: Palette, shadow: ReturnType<typeof useTheme>['shadow']) =>
  StyleSheet.create({
    tileRow: { flexDirection: 'row', gap: spacing.md },
    card: {
      backgroundColor: colors.card,
      borderRadius: radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      padding: spacing.lg,
      ...shadow.card,
    },
    statCard: { flex: 1, alignItems: 'flex-start' },
    weekHeader: {
      flexDirection: 'row',
      alignItems: 'baseline',
      justifyContent: 'space-between',
      marginBottom: spacing.md,
    },
    weekBars: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm, height: 90 },
    weekBarCol: {
      flex: 1,
      alignItems: 'center',
      gap: spacing.xs,
      height: '100%',
      justifyContent: 'flex-end',
    },
    weekBarTrack: { width: '100%', flex: 1, justifyContent: 'flex-end' },
    weekBarFill: { width: '100%', borderRadius: 6, backgroundColor: colors.accent },
    weekBarLabel: { fontSize: 10 },
    listenedRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    leaderboardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: spacing.sm,
    },
    leaderboardRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: colors.card,
      borderRadius: radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      padding: spacing.md,
    },
    leaderboardRowMe: { borderColor: colors.accent },
    leaderboardRank: { width: 22, textAlign: 'center' },
  })
