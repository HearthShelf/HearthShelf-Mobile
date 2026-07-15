/**
 * Stats tab. A full listening-stats screen backed by the HearthShelf server,
 * ported from the web app (HearthShelf-DesignSystem/planning/stats-and-
 * achievements.md is the source of truth). Every number is server-computed via
 * /hs/stats, /hs/stats/history and /hs/social/compare so mobile, web, and any
 * other client show identical figures - this screen never reimplements streak,
 * average, or day-of-week math (the core helpers exist only for the ABS-native
 * fallback path when /hs/stats is unavailable).
 *
 * Sections, top to bottom: hero total, stat tiles, reading-goal card, highlight
 * badges, one toggled bar chart (Last 7 / Total / Average), a listening heatmap,
 * a by-month card, a compare card, and the leaderboard. Each section renders
 * only when its data exists, so a slim server or a fresh user sees fewer
 * sections rather than a wall of zeros or empty frames.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ScrollView, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native'
import Animated, { FadeIn } from 'react-native-reanimated'
import Svg, { Circle } from 'react-native-svg'
import {
  formatDuration,
  dayKey,
  coverHue,
  dayOfWeekAverages,
  avgPerActiveDay,
  avgSession,
  type HSListeningStats,
  type HSStatsHistory,
  type HSStatsHighlights,
  type HSStatsMonth,
  type HSCompareResponse,
  type HSLeaderboardEntry,
  type LeaderboardWindow,
} from '@hearthshelf/core'
import { useRouter } from 'expo-router'
import { getHSStats, getStatsHistory, avatarUrl, coverUrl } from '@/api/abs'
import { getLeaderboard, getCompare } from '@/api/social'
import { getSettingsState, setSetting, subscribeSettings } from '@/store/settings'
import { useSyncExternalStore } from 'react'
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
import { onTabReselect } from '@/ui/tabReselect'
import { useContentInset } from '@/ui/useContentInset'
import { useBackHandler } from '@/ui/useBackHandler'
import { adaptiveContentMaxWidth } from '@/ui/responsive'

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_SHORT = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

type DowMode = 'last7' | 'total' | 'average'
const DOW_OPTIONS: { value: DowMode; label: string }[] = [
  { value: 'last7', label: 'Last 7' },
  { value: 'total', label: 'Total' },
  { value: 'average', label: 'Average' },
]

// --- label helpers (mirror the web app's formatters) -----------------------

/** Bar value from hours: whole/decimal hours >= 1h, minutes below that so a 0.4h
 *  average reads "24m" not "0.4h". "" for empty bars (no floating "0"). */
function barValueLabel(hours: number): string {
  if (hours <= 0) return ''
  if (hours >= 1) return `${Math.round(hours * 10) / 10}h`
  return `${Math.round(hours * 60)}m`
}

/** Compact "3h 20m" / "45m" from seconds, for stat tiles. */
function hmLabel(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

/** Hours for badge sub-stats: one decimal under 10h, whole hours above. */
function hoursOnly(seconds: number): string {
  const h = seconds / 3600
  return h < 10 ? `${Math.round(h * 10) / 10}h` : `${Math.round(h)}h`
}

function bookCountLabel(n: number): string {
  return `${n} ${n === 1 ? 'book' : 'books'}`
}

// --- view model ------------------------------------------------------------
// One shape both the /hs/stats path and the ABS-native fallback produce, so the
// screen renders identically regardless of source. Fields the fallback can't
// reach (finished counts, session count, highlights) stay null.

interface StatsVM {
  totalTimeSec: number
  todaySec: number
  activeDays: number
  byDay: Record<string, number>
  byDayOfWeek: Record<string, number>
  byWeekdayAvg: Record<string, number>
  mostListened: HSListeningStats['mostListened']
  bookCount: number
  dayStreak: number
  booksThisYear: number | null
  sessionCount: number | null
  highlights: HSStatsHighlights | null
}

function vmFromHs(s: HSListeningStats): StatsVM {
  return {
    totalTimeSec: s.totalTimeSec,
    todaySec: s.todaySec,
    activeDays: s.activeDays,
    byDay: s.byDay,
    byDayOfWeek: s.byDayOfWeek,
    byWeekdayAvg: s.byWeekdayAvg ?? dayOfWeekAverages(s.byDay),
    mostListened: s.mostListened,
    bookCount: s.mostListened.length,
    dayStreak: s.dayStreak,
    booksThisYear: s.booksThisYear,
    sessionCount: s.sessionCount,
    highlights: s.highlights ?? null,
  }
}

type Status =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; stats: StatsVM; history: HSStatsHistory }

export default function StatsTab() {
  const router = useRouter()
  const { colors, shadow } = useTheme()
  const styles = useMemo(() => makeStyles(colors, shadow), [colors, shadow])
  const [status, setStatus] = useState<Status>({ phase: 'loading' })
  const [dowMode, setDowMode] = useState<DowMode>('last7')
  const contentInset = useContentInset()
  const { width } = useWindowDimensions()
  const contentMaxWidth = adaptiveContentMaxWidth(width)

  const settings = useSyncExternalStore(subscribeSettings, getSettingsState)
  const yearlyBookGoal = settings.yearlyBookGoal

  const scrollRef = useRef<ScrollView>(null)
  // Re-tapping the Stats tab while already on it scrolls back to the top.
  useEffect(
    () => onTabReselect('stats', () => scrollRef.current?.scrollTo({ y: 0, animated: true })),
    [],
  )

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
      // Stats + durable history in parallel; history degrades to unavailable on
      // its own, so a failure there never blocks the core stats.
      const [statsRes, historyRes] = await Promise.all([
        getHSStats(),
        getStatsHistory('year').catch(() => ({ available: false, days: [], months: [] })),
      ])
      setStatus({ phase: 'ready', stats: vmFromHs(statsRes), history: historyRes })
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

  const { stats, history } = status
  const hasAnyListening = stats.totalTimeSec > 0

  return (
    <Screen>
      <Animated.ScrollView
        ref={scrollRef}
        entering={FadeIn.duration(DUR.base)}
        contentContainerStyle={{
          alignSelf: 'center',
          maxWidth: contentMaxWidth,
          padding: spacing.lg,
          paddingBottom: contentInset,
          width: '100%',
          gap: spacing.lg,
        }}
        showsVerticalScrollIndicator={false}
      >
        <View>
          <AppText variant="eyebrow" color={colors.textMuted}>
            Insights
          </AppText>
          <AppText variant="hero">Your stats</AppText>
        </View>

        {hasAnyListening ? (
          <>
            <HeroTotal stats={stats} styles={styles} colors={colors} />
            <StatTiles stats={stats} styles={styles} colors={colors} />
          </>
        ) : (
          <View style={[styles.card, { alignItems: 'center', paddingVertical: spacing.xl }]}>
            <AppText variant="title">Nothing yet</AppText>
            <AppText
              variant="meta"
              color={colors.textMuted}
              style={{ textAlign: 'center', marginTop: spacing.xs }}
            >
              Start a book and your streak, hours, and highlights will show up here.
            </AppText>
          </View>
        )}

        <GoalCard
          goal={yearlyBookGoal}
          booksThisYear={stats.booksThisYear}
          onSetGoal={(n) => setSetting('yearlyBookGoal', n)}
          styles={styles}
          colors={colors}
        />

        {hasAnyListening && (
          <>
            <HighlightsSection
              highlights={stats.highlights}
              mostListened={stats.mostListened}
              styles={styles}
              colors={colors}
              onOpen={(id) => router.push(`/item/${id}?from=stats`)}
            />

            <BarChart
              stats={stats}
              mode={dowMode}
              onMode={setDowMode}
              styles={styles}
              colors={colors}
            />

            <Heatmap stats={stats} history={history} styles={styles} colors={colors} />

            {history.available && (history.months?.length ?? 0) > 0 && (
              <MonthCard months={history.months ?? []} styles={styles} colors={colors} />
            )}

            <CompareCard styles={styles} colors={colors} />
          </>
        )}

        <Leaderboard styles={styles} colors={colors} />
      </Animated.ScrollView>
    </Screen>
  )
}

type Styles = ReturnType<typeof makeStyles>

// Heads a section with a small icon + title, matching the web section-head.
function SectionHead({
  icon,
  title,
  colors,
  accent,
}: {
  icon: keyof typeof icons
  title: string
  colors: Palette
  accent?: boolean
}) {
  return (
    <View style={rowGap8}>
      <Icon name={icons[icon]} size={18} color={accent ? colors.accent : colors.textMuted} />
      <AppText variant="label">{title}</AppText>
    </View>
  )
}

const rowGap8 = { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 8 }

// --- 1. Hero ---------------------------------------------------------------

function HeroTotal({ stats, styles, colors }: { stats: StatsVM; styles: Styles; colors: Palette }) {
  const h = Math.floor(stats.totalTimeSec / 3600)
  const m = Math.floor((stats.totalTimeSec % 3600) / 60)
  return (
    <View style={[styles.card, styles.hero]}>
      <AppText variant="caption" color={colors.textMuted}>
        Total listening time
      </AppText>
      <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>
        <AppText style={styles.heroNum}>{h}</AppText>
        <AppText style={styles.heroUnit}>h </AppText>
        <AppText style={styles.heroNum}>{m}</AppText>
        <AppText style={styles.heroUnit}>m</AppText>
      </View>
      <AppText variant="meta" color={colors.textMuted}>
        across {bookCountLabel(stats.bookCount)}
      </AppText>
    </View>
  )
}

// --- 2. Stat tiles ---------------------------------------------------------

function StatTiles({ stats, styles, colors }: { stats: StatsVM; styles: Styles; colors: Palette }) {
  const todayMin = Math.round(stats.todaySec / 60)
  const avgDaySec = avgPerActiveDay(stats.totalTimeSec, stats.activeDays)
  const avgSessSec = stats.sessionCount ? avgSession(stats.totalTimeSec, stats.sessionCount) : 0

  const tiles: { icon: keyof typeof icons; value: string; label: string; accent?: boolean }[] = []
  tiles.push({ icon: 'book', value: String(stats.bookCount), label: 'Books listened' })
  if (stats.booksThisYear != null)
    tiles.push({ icon: 'calendar', value: String(stats.booksThisYear), label: 'Books this year' })
  tiles.push({ icon: 'today', value: String(stats.activeDays), label: 'Active days' })
  if (stats.dayStreak > 0)
    tiles.push({ icon: 'flame', value: String(stats.dayStreak), label: 'Day streak', accent: true })
  tiles.push({ icon: 'hourglass', value: hmLabel(avgDaySec), label: 'Avg / active day' })
  if (stats.sessionCount != null && stats.sessionCount > 0)
    tiles.push({ icon: 'play', value: hmLabel(avgSessSec), label: 'Avg session' })
  tiles.push({
    icon: 'today',
    value: `${todayMin}m`,
    label: 'Today',
    accent: todayMin > 0,
  })

  return (
    <View style={styles.tileGrid}>
      {tiles.map((t, i) => (
        <View key={`${t.label}-${i}`} style={[styles.card, styles.tile]}>
          <View style={[styles.tileIcon, t.accent && styles.tileIconAccent]}>
            <Icon name={icons[t.icon]} size={18} color={t.accent ? colors.accent : colors.text} />
          </View>
          <AppText style={styles.tileNum}>{t.value}</AppText>
          <AppText variant="caption" color={colors.textMuted}>
            {t.label}
          </AppText>
        </View>
      ))}
    </View>
  )
}

// --- 3. Reading goal -------------------------------------------------------

/** Fraction of the current calendar year elapsed (0..1), for the pace hint. */
function yearElapsedFraction(): number {
  const now = new Date()
  const start = new Date(now.getFullYear(), 0, 1).getTime()
  const end = new Date(now.getFullYear() + 1, 0, 1).getTime()
  return (now.getTime() - start) / (end - start)
}

function ProgressRing({
  frac,
  label,
  sub,
  colors,
}: {
  frac: number
  label: string
  sub: string
  colors: Palette
}) {
  const size = 116
  const stroke = 10
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(1, frac))
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size}>
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.fillStrong}
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={colors.accent}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - clamped)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={{ position: 'absolute', alignItems: 'center' }}>
        <AppText style={{ fontFamily: fonts.mono, fontSize: 22, fontWeight: '700' }}>
          {label}
        </AppText>
        <AppText variant="caption" color={colors.textMuted}>
          {sub}
        </AppText>
      </View>
    </View>
  )
}

function GoalCard({
  goal,
  booksThisYear,
  onSetGoal,
  styles,
  colors,
}: {
  goal: number
  booksThisYear: number | null
  onSetGoal: (n: number) => void
  styles: Styles
  colors: Palette
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(goal || ''))

  const startEdit = () => {
    setDraft(goal ? String(goal) : '')
    setEditing(true)
  }
  const commit = () => {
    const n = Math.max(0, Math.min(1000, Math.round(Number(draft) || 0)))
    onSetGoal(n)
    setEditing(false)
  }

  const editor = (
    <View style={{ gap: spacing.sm }}>
      <AppText variant="caption" color={colors.textMuted}>
        Books to finish this year
      </AppText>
      <View style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'center' }}>
        <TextInput
          style={styles.goalInput}
          keyboardType="number-pad"
          value={draft}
          onChangeText={setDraft}
          autoFocus
          placeholder="0"
          placeholderTextColor={colors.textFaint}
          onSubmitEditing={commit}
        />
        <PrimaryButton label="Save" onPress={commit} />
        {goal > 0 && (
          <SecondaryTextButton label="Cancel" onPress={() => setEditing(false)} colors={colors} />
        )}
      </View>
    </View>
  )

  // No goal yet: invite the user to set one.
  if (goal <= 0) {
    return (
      <View style={{ gap: spacing.sm }}>
        <SectionHead icon="flag" title="Reading goal" colors={colors} />
        <View style={[styles.card, { gap: spacing.md }]}>
          {editing ? (
            editor
          ) : (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
              <View style={styles.tileIcon}>
                <Icon name={icons.flag} size={18} color={colors.text} />
              </View>
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="label">Set a reading goal</AppText>
                <AppText variant="caption" color={colors.textMuted}>
                  Pick how many books you want to finish this year and track your progress.
                </AppText>
              </View>
              <PrimaryButton label="Set" onPress={startEdit} />
            </View>
          )}
        </View>
      </View>
    )
  }

  const done = booksThisYear ?? 0
  const frac = goal > 0 ? done / goal : 0
  const pct = Math.round(frac * 100)
  const remaining = Math.max(0, goal - done)
  const expected = goal * yearElapsedFraction()
  const ahead = done - expected
  let paceText: string
  let paceColor: string
  if (done >= goal) {
    paceText = 'Goal reached - nice work!'
    paceColor = colors.success
  } else if (ahead >= 0.5) {
    paceText = `${Math.round(ahead)} ahead of schedule`
    paceColor = colors.success
  } else if (ahead <= -0.5) {
    paceText = `${Math.round(-ahead)} behind schedule`
    paceColor = colors.brandHearth
  } else {
    paceText = 'Right on pace'
    paceColor = colors.success
  }

  return (
    <View style={{ gap: spacing.sm }}>
      <SectionHead icon="flag" title="Reading goal" colors={colors} />
      <View style={styles.card}>
        {editing ? (
          editor
        ) : (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.lg }}>
            <ProgressRing
              frac={frac}
              label={booksThisYear == null ? '--' : `${pct}%`}
              sub={`of ${goal}`}
              colors={colors}
            />
            <View style={{ flex: 1, minWidth: 0, gap: spacing.xs }}>
              {booksThisYear == null ? (
                <>
                  <AppText variant="label">Goal: {goal} books</AppText>
                  <AppText variant="caption" color={colors.textMuted}>
                    Progress needs the library database - it isn't available on this server.
                  </AppText>
                </>
              ) : (
                <>
                  <AppText variant="label">
                    {done} of {goal} books this year
                  </AppText>
                  <AppText variant="meta" color={paceColor}>
                    {paceText}
                  </AppText>
                  {remaining > 0 && (
                    <AppText variant="caption" color={colors.textMuted}>
                      {remaining} to go
                    </AppText>
                  )}
                </>
              )}
              <Touchable onPress={startEdit} style={styles.goalEditBtn}>
                <Icon name={icons.edit} size={14} color={colors.textMuted} />
                <AppText variant="caption" color={colors.textMuted}>
                  Edit goal
                </AppText>
              </Touchable>
            </View>
          </View>
        )}
      </View>
    </View>
  )
}

function SecondaryTextButton({
  label,
  onPress,
  colors,
}: {
  label: string
  onPress: () => void
  colors: Palette
}) {
  return (
    <Touchable
      onPress={onPress}
      style={{ paddingHorizontal: spacing.md, paddingVertical: spacing.sm }}
    >
      <AppText variant="label" color={colors.textMuted}>
        {label}
      </AppText>
    </Touchable>
  )
}

// --- 4. Highlights ---------------------------------------------------------

interface HighlightCard {
  key: string
  cap: string
  headline: string
  stat: string
  book?: { itemId: string; title: string } | null
  icon: keyof typeof icons
}

function HighlightsSection({
  highlights,
  mostListened,
  styles,
  colors,
  onOpen,
}: {
  highlights: HSStatsHighlights | null
  mostListened: HSListeningStats['mostListened']
  styles: Styles
  colors: Palette
  onOpen: (id: string) => void
}) {
  const cards: HighlightCard[] = []
  if (highlights) {
    const h = highlights
    const bookOf = (b: { title: string; libraryItemId: string | null }) =>
      b.libraryItemId ? { itemId: b.libraryItemId, title: b.title || 'Untitled' } : null
    if (h.longestBook)
      cards.push({
        key: 'longest',
        cap: 'Longest book finished',
        headline: h.longestBook.title || 'Untitled',
        stat: hoursOnly(h.longestBook.durationSec),
        book: bookOf(h.longestBook),
        icon: 'straighten',
      })
    if (h.shortestBook)
      cards.push({
        key: 'shortest',
        cap: 'Shortest book finished',
        headline: h.shortestBook.title || 'Untitled',
        stat: hoursOnly(h.shortestBook.durationSec),
        book: bookOf(h.shortestBook),
        icon: 'compress',
      })
    if (h.topAuthor)
      cards.push({
        key: 'author',
        cap: 'Most-read author',
        headline: h.topAuthor.name,
        stat: bookCountLabel(h.topAuthor.count),
        icon: 'edit',
      })
    if (h.topNarrator)
      cards.push({
        key: 'narrator',
        cap: 'Most-read narrator',
        headline: h.topNarrator.name,
        stat: bookCountLabel(h.topNarrator.count),
        icon: 'voice',
      })
    if (h.mostReRead)
      cards.push({
        key: 'reread',
        cap: 'Most re-read',
        headline: h.mostReRead.title || 'Untitled',
        stat: `${h.mostReRead.completions}x finished`,
        book: h.mostReRead.libraryItemId
          ? { itemId: h.mostReRead.libraryItemId, title: h.mostReRead.title || 'Untitled' }
          : null,
        icon: 'replay',
      })
  }

  // Fallback: the old "Most listened to" list when the server gives no highlights.
  if (cards.length === 0) {
    const top = mostListened.slice(0, 8)
    if (top.length === 0) return null
    const max = top[0].timeSec || 1
    return (
      <View style={{ gap: spacing.sm }}>
        <SectionHead icon="trending" title="Most listened to" colors={colors} />
        <View style={[styles.card, { gap: spacing.md }]}>
          {top.map((b, i) => (
            <Touchable
              key={b.id}
              style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
              onPress={() => onOpen(b.id)}
            >
              <AppText
                variant="mono"
                color={colors.textMuted}
                style={{ width: 18, textAlign: 'center' }}
              >
                {i + 1}
              </AppText>
              <Cover
                uri={coverUrl(b.id)}
                itemId={b.id}
                size={40}
                radius={radius.tile}
                fallback={{
                  hue: coverHue(b.id),
                  initial: (b.title || '?').charAt(0).toUpperCase(),
                }}
              />
              <View style={{ flex: 1, minWidth: 0 }}>
                <AppText variant="label" numberOfLines={1}>
                  {b.title}
                </AppText>
                <View style={styles.mlTrack}>
                  <View style={[styles.mlFill, { width: `${(b.timeSec / max) * 100}%` }]} />
                </View>
              </View>
              <AppText variant="mono" color={colors.textMuted}>
                {hoursOnly(b.timeSec)}
              </AppText>
            </Touchable>
          ))}
        </View>
      </View>
    )
  }

  return (
    <View style={{ gap: spacing.sm }}>
      <SectionHead icon="premium" title="Highlights" colors={colors} />
      <View style={{ gap: spacing.md }}>
        {cards.map((c) => (
          <BadgeRow key={c.key} card={c} styles={styles} colors={colors} onOpen={onOpen} />
        ))}
      </View>
    </View>
  )
}

function BadgeRow({
  card,
  styles,
  colors,
  onOpen,
}: {
  card: HighlightCard
  styles: Styles
  colors: Palette
  onOpen: (id: string) => void
}) {
  const body = (
    <View style={[styles.card, styles.badgeCard]}>
      {card.book ? (
        <Cover
          uri={coverUrl(card.book.itemId)}
          itemId={card.book.itemId}
          size={52}
          radius={radius.tile}
          fallback={{
            hue: coverHue(card.book.itemId),
            initial: (card.book.title || '?').charAt(0).toUpperCase(),
          }}
        />
      ) : (
        <View style={styles.badgeIcon}>
          <Icon name={icons[card.icon]} size={22} color={colors.text} />
        </View>
      )}
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={styles.badgeTop}>
          <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
            {card.cap}
          </AppText>
          <AppText variant="mono" color={colors.accent}>
            {card.stat}
          </AppText>
        </View>
        {/* Name flows on as many lines as it needs - no truncation. */}
        <AppText variant="label" style={{ marginTop: 2 }}>
          {card.headline}
        </AppText>
      </View>
    </View>
  )
  if (card.book) {
    const id = card.book.itemId
    return <Touchable onPress={() => onOpen(id)}>{body}</Touchable>
  }
  return body
}

// --- 5. Bar chart ----------------------------------------------------------

function BarChart({
  stats,
  mode,
  onMode,
  styles,
  colors,
}: {
  stats: StatsVM
  mode: DowMode
  onMode: (m: DowMode) => void
  styles: Styles
  colors: Palette
}) {
  const bars = useMemo(() => {
    if (mode === 'last7') {
      const out: { d: string; v: number }[] = []
      const now = new Date()
      for (let i = 6; i >= 0; i--) {
        const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
        out.push({
          d: DAY_SHORT[day.getDay()],
          v: Math.round(((stats.byDay[dayKey(day)] ?? 0) / 3600) * 10) / 10,
        })
      }
      return out
    }
    const src = mode === 'average' ? stats.byWeekdayAvg : stats.byDayOfWeek
    return DAY_LABELS.map((label, i) => ({
      d: DAY_SHORT[i],
      v: Math.round(((src[String(i)] ?? 0) / 3600) * 10) / 10,
    }))
  }, [stats, mode])
  const max = Math.max(0.1, ...bars.map((d) => d.v))
  const hot = bars.length ? bars.reduce((m, d, i) => (d.v > bars[m].v ? i : m), 0) : 0
  const empty = !bars.some((d) => d.v > 0)

  const subtitle =
    mode === 'last7'
      ? 'Hours listened each of the last 7 days'
      : mode === 'total'
        ? 'Total hours listened on each weekday'
        : 'Average hours per weekday'

  return (
    <View style={styles.card}>
      <View style={styles.chartHead}>
        <SectionHead
          icon="barChart"
          title={mode === 'last7' ? 'Last 7 days' : 'By day of week'}
          colors={colors}
        />
        <Seg value={mode} onChange={onMode} options={DOW_OPTIONS} />
      </View>
      <AppText variant="caption" color={colors.textMuted} style={{ marginTop: spacing.xs }}>
        {subtitle}
      </AppText>
      {empty ? (
        <View style={{ paddingVertical: spacing.xl, alignItems: 'center' }}>
          <AppText variant="meta" color={colors.textMuted}>
            No listening yet.
          </AppText>
        </View>
      ) : (
        <View style={styles.barRow}>
          {bars.map((d, i) => (
            <View key={i} style={styles.barCol}>
              <AppText
                variant="caption"
                color={i === hot ? colors.accent : colors.textMuted}
                style={{ fontFamily: fonts.mono, fontSize: 9 }}
              >
                {barValueLabel(d.v)}
              </AppText>
              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.barFill,
                    {
                      height: `${Math.max(3, (d.v / max) * 100)}%`,
                      backgroundColor: i === hot ? colors.accent : colors.accentTile,
                    },
                  ]}
                />
              </View>
              <AppText variant="caption" color={colors.textMuted} style={{ fontSize: 10 }}>
                {d.d}
              </AppText>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

// --- 6. Heatmap ------------------------------------------------------------

function Heatmap({
  stats,
  history,
  styles,
  colors,
}: {
  stats: StatsVM
  history: HSStatsHistory
  styles: Styles
  colors: Palette
}) {
  // Full-year from durable history when available; else the trailing 26 weeks
  // from byDay. Both render as week columns (Sun..Sat top to bottom).
  const model = useMemo(() => {
    const now = new Date()
    const useYear = history.available && history.days.length > 0
    const byDate = new Map<string, number>()
    let start: Date
    if (useYear) {
      for (const d of history.days) byDate.set(d.date, d.secondsListened)
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7 * 52)
    } else {
      for (const [k, v] of Object.entries(stats.byDay)) byDate.set(k, v)
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 7 * 26)
    }
    // Back up to the Sunday on/before start so each column is a whole week.
    start.setDate(start.getDate() - start.getDay())
    const cells: { key: string; mins: number; ratio: number; month: number }[] = []
    let max = 1
    const cur = new Date(start)
    while (cur <= now) {
      const key = dayKey(cur)
      const mins = Math.round((byDate.get(key) ?? 0) / 60)
      max = Math.max(max, mins)
      cells.push({ key, mins, ratio: 0, month: cur.getMonth() })
      cur.setDate(cur.getDate() + 1)
    }
    for (const c of cells) c.ratio = c.mins / max
    const weeks = Math.ceil(cells.length / 7)
    // Month labels at the first column landing in a new month.
    const monthCols: { col: number; label: string }[] = []
    let lastMonth = -1
    for (let col = 0; col < weeks; col++) {
      const first = cells[col * 7]
      if (first && first.month !== lastMonth) {
        monthCols.push({ col, label: MONTH_LABELS[first.month] })
        lastMonth = first.month
      }
    }
    return { cells, weeks, monthCols, title: useYear ? 'This year' : 'Last 6 months' }
  }, [stats, history])

  const cellColor = (ratio: number) =>
    ratio > 0 ? mixAccent(colors, Math.round(18 + ratio * 82)) : colors.fill

  return (
    <View style={styles.card}>
      <SectionHead icon="monthView" title={model.title} colors={colors} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ marginTop: spacing.md }}
        contentContainerStyle={{ gap: 3 }}
      >
        {Array.from({ length: model.weeks }).map((_, col) => (
          <View key={col} style={{ gap: 3 }}>
            {Array.from({ length: 7 }).map((_, row) => {
              const c = model.cells[col * 7 + row]
              if (!c) return <View key={row} style={styles.heatCell} />
              return (
                <View
                  key={row}
                  style={[styles.heatCell, { backgroundColor: cellColor(c.ratio) }]}
                />
              )
            })}
          </View>
        ))}
      </ScrollView>
    </View>
  )
}

// --- 7. By month -----------------------------------------------------------

function MonthCard({
  months,
  styles,
  colors,
}: {
  months: HSStatsMonth[]
  styles: Styles
  colors: Palette
}) {
  const totalHours = months.reduce((s, m) => s + m.seconds / 3600, 0)
  const totalBooks = months.reduce((s, m) => s + m.books, 0)
  const avgHours = totalHours / months.length
  const avgBooks = totalBooks / months.length
  const recent = months.slice(-12).map((m) => ({
    label: MONTH_LABELS[Math.max(0, Math.min(11, Number(m.month.slice(5, 7)) - 1))],
    hours: Math.round((m.seconds / 3600) * 10) / 10,
  }))
  const max = Math.max(0.1, ...recent.map((r) => r.hours))

  return (
    <View style={styles.card}>
      <SectionHead icon="calendar" title="By month" colors={colors} />
      <AppText variant="caption" color={colors.textMuted} style={{ marginTop: spacing.xs }}>
        Averages across {months.length} {months.length === 1 ? 'month' : 'months'} of history
      </AppText>
      <View style={{ flexDirection: 'row', gap: spacing.lg, marginTop: spacing.md }}>
        <View style={{ flex: 1 }}>
          <AppText style={styles.monthAvgNum}>{avgHours.toFixed(1)}h</AppText>
          <AppText variant="caption" color={colors.textMuted}>
            Avg hours / month
          </AppText>
        </View>
        <View style={{ flex: 1 }}>
          <AppText style={styles.monthAvgNum}>{avgBooks.toFixed(1)}</AppText>
          <AppText variant="caption" color={colors.textMuted}>
            Avg books / month
          </AppText>
        </View>
      </View>
      {recent.length > 1 && (
        <View style={[styles.barRow, { marginTop: spacing.md }]}>
          {recent.map((r, i) => (
            <View key={i} style={styles.barCol}>
              <AppText
                variant="caption"
                color={colors.textMuted}
                style={{ fontFamily: fonts.mono, fontSize: 9 }}
              >
                {r.hours >= 1 ? `${r.hours}h` : ''}
              </AppText>
              <View style={styles.barTrack}>
                <View
                  style={[
                    styles.barFill,
                    {
                      height: `${Math.max(3, (r.hours / max) * 100)}%`,
                      backgroundColor: colors.accentTile,
                    },
                  ]}
                />
              </View>
              <AppText variant="caption" color={colors.textMuted} style={{ fontSize: 9 }}>
                {r.label}
              </AppText>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

// --- 8. Compare ------------------------------------------------------------

type CompareStatus =
  { phase: 'loading' } | { phase: 'hidden' } | { phase: 'ready'; compare: HSCompareResponse }

function CompareCard({ styles, colors }: { styles: Styles; colors: Palette }) {
  const [userId, setUserId] = useState<string>('')
  const [roster, setRoster] = useState<HSLeaderboardEntry[]>([])
  const [status, setStatus] = useState<CompareStatus>({ phase: 'loading' })

  // Roster for the user picker: draw from the leaderboard (already privacy-
  // filtered server-side), fetched once.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const lb = await getLeaderboard('all')
      if (!cancelled && lb.available) setRoster(lb.entries.filter((e) => !e.isMe))
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const res = await getCompare(userId ? { userId } : {})
      if (cancelled) return
      setStatus(res.available ? { phase: 'ready', compare: res } : { phase: 'hidden' })
    })()
    return () => {
      cancelled = true
    }
  }, [userId])

  if (status.phase === 'hidden') return null
  if (status.phase === 'loading') return null

  const { compare } = status
  const targetLabel =
    compare.scope === 'user' ? compare.username || 'That listener' : 'Server average'

  // Every shared stat, side by side. Include a row only when BOTH sides carry
  // the value (older servers omit newer fields; the aggregate has no activeDays).
  const roundInt = (n: number) => String(Math.round(n))
  const hoursFmt = (n: number) => `${n.toFixed(1)}h`
  const specs: {
    label: string
    me: number | null | undefined
    target: number | null | undefined
    fmt: (n: number) => string
  }[] = [
    {
      label: 'Books finished',
      me: compare.me.booksFinished,
      target: compare.target.booksFinished,
      fmt: roundInt,
    },
    {
      label: 'Hours listened',
      me: compare.me.secondsListened / 3600,
      target: compare.target.secondsListened / 3600,
      fmt: hoursFmt,
    },
    {
      label: 'Books this year',
      me: compare.me.booksThisYear,
      target: compare.target.booksThisYear,
      fmt: roundInt,
    },
    {
      label: 'Active days',
      me: compare.me.activeDays,
      target: compare.target.activeDays,
      fmt: roundInt,
    },
    {
      label: 'Avg / active day',
      me: compare.me.avgPerActiveDaySec != null ? compare.me.avgPerActiveDaySec / 3600 : undefined,
      target:
        compare.target.avgPerActiveDaySec != null
          ? compare.target.avgPerActiveDaySec / 3600
          : undefined,
      fmt: hoursFmt,
    },
  ]
  const rows = specs.filter(
    (s): s is { label: string; me: number; target: number; fmt: (n: number) => string } =>
      typeof s.me === 'number' && typeof s.target === 'number',
  )

  return (
    <View style={{ gap: spacing.sm }}>
      <SectionHead icon="compare" title="Compare" colors={colors} />
      {/* Server-average / user toggle. The picker is a horizontal chip row of the
          privacy-filtered roster, native-friendlier than a <select>. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: spacing.sm }}
      >
        <CompareChip
          label="Server average"
          on={!userId}
          onPress={() => setUserId('')}
          colors={colors}
        />
        {roster.map((u) => (
          <CompareChip
            key={u.userId}
            label={u.username}
            on={userId === u.userId}
            onPress={() => setUserId(u.userId)}
            colors={colors}
          />
        ))}
      </ScrollView>
      <View style={[styles.card, { gap: spacing.md }]}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <AppText variant="caption" color={colors.accent}>
            You
          </AppText>
          <AppText variant="caption" color={colors.textMuted}>
            {targetLabel}
          </AppText>
        </View>
        {rows.map((r) => {
          const max = Math.max(r.me, r.target, 0.001)
          return (
            <View key={r.label} style={{ gap: spacing.xs }}>
              <AppText variant="caption" color={colors.textMuted}>
                {r.label}
              </AppText>
              <View style={styles.cmpBars}>
                <View style={styles.cmpTrack}>
                  <View
                    style={[
                      styles.cmpFill,
                      { width: `${(r.me / max) * 100}%`, backgroundColor: colors.accent },
                    ]}
                  />
                  <AppText variant="caption" style={styles.cmpVal}>
                    {r.fmt(r.me)}
                  </AppText>
                </View>
                <View style={styles.cmpTrack}>
                  <View
                    style={[
                      styles.cmpFill,
                      { width: `${(r.target / max) * 100}%`, backgroundColor: colors.fillStrong },
                    ]}
                  />
                  <AppText variant="caption" color={colors.textMuted} style={styles.cmpVal}>
                    {r.fmt(r.target)}
                  </AppText>
                </View>
              </View>
            </View>
          )
        })}
      </View>
    </View>
  )
}

function CompareChip({
  label,
  on,
  onPress,
  colors,
}: {
  label: string
  on: boolean
  onPress: () => void
  colors: Palette
}) {
  return (
    <Touchable
      onPress={onPress}
      style={{
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.pill,
        backgroundColor: on ? colors.accent : colors.fill,
      }}
    >
      <AppText variant="caption" color={on ? colors.onAccent : colors.textMuted}>
        {label}
      </AppText>
    </Touchable>
  )
}

// --- 9. Leaderboard --------------------------------------------------------

const WINDOW_OPTIONS: { value: LeaderboardWindow; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'all', label: 'All time' },
]

type LeaderboardStatus =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'hidden' }
  | { phase: 'ready'; entries: HSLeaderboardEntry[]; windowsAvailable: boolean }

function Leaderboard({ styles, colors }: { styles: Styles; colors: Palette }) {
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
    <View style={{ gap: spacing.sm }}>
      <View style={styles.chartHead}>
        <SectionHead icon="people" title="Leaderboard" colors={colors} />
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
            <View key={entry.userId} style={[styles.lbRow, entry.isMe && styles.lbRowMe]}>
              <AppText
                variant="mono"
                color={entry.isMe ? colors.accent : colors.textMuted}
                style={{ width: 22, textAlign: 'center' }}
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

// Blend the accent over the neutral surface at `pct`% for a heatmap cell. RN has
// no color-mix(), so we alpha-composite the ember over the card fill manually.
function mixAccent(colors: Palette, pct: number): string {
  const a = hexToRgb(colors.accent)
  const b = hexToRgb(colors.highest ?? colors.fillStrong)
  if (!a || !b) return colors.accent
  const t = pct / 100
  const mix = (x: number, y: number) => Math.round(x * t + y * (1 - t))
  return `rgb(${mix(a.r, b.r)}, ${mix(a.g, b.g)}, ${mix(a.b, b.b)})`
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim())
  if (!m) return null
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
}

const makeStyles = (colors: Palette, shadow: ReturnType<typeof useTheme>['shadow']) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.card,
      borderRadius: radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      padding: spacing.lg,
      ...shadow.card,
    },
    hero: { alignItems: 'flex-start', gap: 2 },
    heroNum: { fontFamily: fonts.mono, fontSize: 40, fontWeight: '700', color: colors.text },
    heroUnit: { fontFamily: fonts.sans, fontSize: 20, fontWeight: '600', color: colors.textMuted },

    tileGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
    tile: {
      // Two per row: (100% - gap) / 2. flexBasis handles the wrap.
      flexGrow: 1,
      flexBasis: '46%',
      alignItems: 'flex-start',
      gap: spacing.xs,
      padding: spacing.md,
    },
    tileIcon: {
      width: 34,
      height: 34,
      borderRadius: radius.tile,
      backgroundColor: colors.fill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    tileIconAccent: { backgroundColor: colors.accentWash },
    tileNum: {
      fontFamily: fonts.mono,
      fontSize: 22,
      fontWeight: '700',
      color: colors.text,
      marginTop: 2,
    },

    goalInput: {
      flex: 1,
      backgroundColor: colors.fill,
      borderRadius: radius.row,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      color: colors.text,
      fontFamily: fonts.mono,
      fontSize: 16,
    },
    goalEditBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      marginTop: spacing.xs,
    },

    mlTrack: {
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.fill,
      marginTop: spacing.xs,
      overflow: 'hidden',
    },
    mlFill: { height: '100%', borderRadius: 2, backgroundColor: colors.accent },

    badgeCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.md },
    badgeIcon: {
      width: 52,
      height: 52,
      borderRadius: radius.tile,
      backgroundColor: colors.fill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeTop: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },

    chartHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    barRow: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: spacing.xs,
      height: 120,
      marginTop: spacing.md,
    },
    barCol: { flex: 1, alignItems: 'center', gap: 2, height: '100%', justifyContent: 'flex-end' },
    barTrack: { width: '100%', flex: 1, justifyContent: 'flex-end' },
    barFill: { width: '100%', borderRadius: 6, minHeight: 3 },

    heatCell: { width: 11, height: 11, borderRadius: 2, backgroundColor: colors.fill },

    monthAvgNum: { fontFamily: fonts.mono, fontSize: 22, fontWeight: '700', color: colors.text },

    cmpBars: { gap: 4 },
    cmpTrack: {
      height: 20,
      borderRadius: radius.row,
      backgroundColor: colors.fill,
      overflow: 'hidden',
      justifyContent: 'center',
    },
    cmpFill: {
      position: 'absolute',
      left: 0,
      top: 0,
      bottom: 0,
      borderRadius: radius.row,
      minWidth: 2,
    },
    cmpVal: { paddingHorizontal: spacing.sm, alignSelf: 'flex-end' },

    lbRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: colors.card,
      borderRadius: radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.hairline,
      padding: spacing.md,
    },
    lbRowMe: { borderColor: colors.accent },
  })
