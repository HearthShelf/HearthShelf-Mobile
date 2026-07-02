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
import { formatDuration, dayKey, coverHue, type HSListeningStats } from '@hearthshelf/core'
import { getHSStats } from '@/api/abs'
import { AppText, Centered, Cover, Loading, PrimaryButton, Screen } from '@/ui/primitives'
import { radius, spacing, fonts, type Palette } from '@/ui/theme'
import { useTheme } from '@/ui/ThemeProvider'
import { Icon, icons } from '@/ui/icons'
import { DUR } from '@/ui/motion'

const DAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

type Status =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; stats: HSListeningStats }

export default function StatsTab() {
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  const [status, setStatus] = useState<Status>({ phase: 'loading' })

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
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: 140, gap: spacing.lg }}
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
                    <View key={item.id} style={styles.listenedRow}>
                      <Cover
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
                    </View>
                  ))}
                </View>
              </View>
            )}
          </>
        )}
      </Animated.ScrollView>
    </Screen>
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
  })
