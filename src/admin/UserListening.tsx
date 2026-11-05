/** The listening half of a user's page: totals, top books and finished books. */
import { useState } from 'react'
import { Pressable, View } from 'react-native'
import { router } from 'expo-router'
import {
  fmtSessDate,
  formatDuration,
  type ABSUserMediaProgress,
  type HSListeningStats,
} from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { coverUrl } from '@/api/abs'
import { AppText, Cover, ProgressBar } from '@/ui/primitives'
import { SettingsGroup, SettingsLabel } from '@/ui/settingsControls'
import { useColors } from '@/ui/ThemeProvider'
import { radius, spacing } from '@/ui/theme'

const FINISHED_PAGE_SIZE = 10

function Tile({ value, label }: { value: string; label: string }) {
  const colors = useColors()
  return (
    <View
      style={{
        flexGrow: 1,
        flexBasis: '30%',
        padding: spacing.md,
        borderRadius: radius.row,
        backgroundColor: colors.fill,
      }}
    >
      <AppText variant="body" numberOfLines={1}>
        {value}
      </AppText>
      <AppText variant="caption" color={colors.textMuted}>
        {label}
      </AppText>
    </View>
  )
}

function BookRow({
  itemId,
  title,
  subtitle,
  trailing,
  bar,
  last,
}: {
  itemId: string
  title: string
  subtitle: string
  trailing?: string
  /** 0..1 share of the top book. */
  bar?: number
  last: boolean
}) {
  const colors = useColors()
  return (
    <Pressable
      onPress={() => router.push(`/item/${itemId}`)}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        padding: spacing.md,
        opacity: pressed ? 0.8 : 1,
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: colors.hairline,
      })}
    >
      <Cover uri={coverUrl(itemId, 120)} size={44} />
      <View style={{ flex: 1, gap: 2 }}>
        <AppText variant="body" numberOfLines={1}>
          {title}
        </AppText>
        <AppText variant="caption" color={colors.textMuted} numberOfLines={1}>
          {subtitle}
        </AppText>
        {bar === undefined ? null : <ProgressBar progress={bar} />}
      </View>
      {trailing ? (
        <AppText variant="caption" color={colors.textMuted}>
          {trailing}
        </AppText>
      ) : null}
    </Pressable>
  )
}

export function UserStats({ stats }: { stats: HSListeningStats }) {
  const top = stats.mostListened.slice(0, 5)
  const topMax = top[0]?.timeSec || 1
  return (
    <>
      <View>
        <SettingsLabel>Listening stats</SettingsLabel>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          <Tile value={formatDuration(stats.totalTimeSec)} label="Total time" />
          <Tile value={String(stats.mostListened.length)} label="Books listened" />
          <Tile value={String(stats.activeDays)} label="Active days" />
          {stats.dayStreak > 0 ? <Tile value={String(stats.dayStreak)} label="Day streak" /> : null}
          <Tile value={formatDuration(stats.weekSec)} label="This week" />
          <Tile value={formatDuration(stats.todaySec)} label="Today" />
        </View>
      </View>
      {top.length > 0 ? (
        <View>
          <SettingsLabel>Most listened to</SettingsLabel>
          <SettingsGroup>
            {top.map((b, i) => (
              <BookRow
                key={b.id}
                itemId={b.id}
                title={b.title}
                subtitle={[b.author, b.narrator].filter(Boolean).join(' · ')}
                trailing={`${(b.timeSec / 3600).toFixed(1)}h`}
                bar={b.timeSec / topMax}
                last={i === top.length - 1}
              />
            ))}
          </SettingsGroup>
        </View>
      ) : null}
    </>
  )
}

export function UserFinishedBooks({ progress }: { progress: ABSUserMediaProgress[] }) {
  const [shown, setShown] = useState(FINISHED_PAGE_SIZE)
  // Rows ABS finished without stamping a date sort last.
  const finished = progress
    .filter((p) => p.isFinished)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
  if (finished.length === 0) return null
  const visible = finished.slice(0, shown)
  return (
    <View style={{ gap: spacing.sm }}>
      <View>
        <SettingsLabel>{`Finished books (${finished.length})`}</SettingsLabel>
        <SettingsGroup>
          {visible.map((p, i) => (
            <BookRow
              key={p.id}
              itemId={p.libraryItemId}
              title={p.displayTitle ?? 'Unknown book'}
              subtitle={[
                p.duration > 0 ? formatDuration(p.duration) : 'No length recorded',
                p.finishedAt ? fmtSessDate(p.finishedAt).day : 'Date unknown',
              ].join(' · ')}
              last={i === visible.length - 1}
            />
          ))}
        </SettingsGroup>
      </View>
      {shown < finished.length ? (
        <AdminButton
          label="Show more"
          kind="secondary"
          onPress={() => setShown((n) => n + FINISHED_PAGE_SIZE)}
        />
      ) : null}
    </View>
  )
}
