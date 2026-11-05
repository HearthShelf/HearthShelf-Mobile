/** One background task: what it is, how it last went, and what can be done to it. */
import { View } from 'react-native'
import {
  JOB_STATUS_META,
  fmtJobDuration,
  fmtJobInterval,
  fmtJobWhen,
  type JobStatusTone,
  type JobSummary,
} from '@hearthshelf/core'
import { AppText, ProgressBar } from '@/ui/primitives'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'
import { AdminButton } from './AdminButton'
import { AdminCard } from './AdminCard'
import type { StatusTone } from './StatusPill'

const PILL_TONE: Record<JobStatusTone, StatusTone> = {
  info: 'neutral',
  success: 'good',
  danger: 'bad',
}

export function JobCard({
  job,
  busy,
  onRun,
  onStop,
  onLogs,
}: {
  job: JobSummary
  busy: boolean
  onRun: () => void
  onStop: () => void
  onLogs: () => void
}) {
  const colors = useColors()
  const run = job.lastRun
  const running = job.running || run?.status === 'running'
  const meta = run ? JOB_STATUS_META[run.status] : null
  const progress = running && run && run.itemsTotal > 0 ? run.itemsProcessed / run.itemsTotal : null
  const facts = [
    fmtJobInterval(job.intervalMs),
    `Last run: ${fmtJobWhen(run?.startedAt ?? null)}`,
    run?.finishedAt ? fmtJobDuration(run) : '',
    progress !== null ? `${Math.round(progress * 100)}%` : '',
  ].filter(Boolean)

  return (
    <AdminCard
      title={job.name}
      subtitle={job.description}
      status={meta?.label}
      statusTone={meta ? PILL_TONE[meta.tone] : undefined}
    >
      <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
        <AppText variant="caption" color={colors.textMuted}>
          {facts.join(' · ')}
        </AppText>
        {progress !== null ? <ProgressBar progress={progress} /> : null}
        {run?.summary && run.status === 'ok' ? (
          <AppText variant="meta" color={colors.textMuted}>
            {run.summary}
          </AppText>
        ) : null}
        {run?.error ? (
          <AppText variant="meta" color={colors.destructive}>
            {run.error}
          </AppText>
        ) : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {running ? (
            <AdminButton label="Stop" icon="stop" kind="danger" onPress={onStop} disabled={busy} />
          ) : (
            <AdminButton label="Run now" icon="play-arrow" onPress={onRun} disabled={busy} />
          )}
          {run ? (
            <AdminButton label="View log" icon="notes" kind="secondary" onPress={onLogs} />
          ) : null}
        </View>
      </View>
    </AdminCard>
  )
}
