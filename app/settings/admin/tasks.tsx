/** The server's background tasks: run one now, stop it, or read its log. */
import { useState } from 'react'
import { FlatList, View } from 'react-native'
import type { JobSummary } from '@hearthshelf/core'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { JobCard } from '@/admin/JobCard'
import { JobLogSheet } from '@/admin/JobLogSheet'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { cancelJob, getJobs, runJobNow } from '@/api/admin/jobs'
import { confirm } from '@/ui/confirm'
import { AppText } from '@/ui/primitives'
import { EmptyState, Skeleton } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'
import { useContentInset } from '@/ui/useContentInset'

const JOBS_POLL_MS = 5000

export default function AdminTasksScreen() {
  return (
    <AdminGate>
      <AdminTasks />
    </AdminGate>
  )
}

function AdminTasks() {
  const colors = useColors()
  const bottomInset = useContentInset()
  const jobs = useAdminResource(getJobs, { pollMs: JOBS_POLL_MS })
  const { run, busy } = useAdminWrite()
  const [openLog, setOpenLog] = useState<{ runId: string; title: string } | null>(null)

  const start = (job: JobSummary) => {
    void run(
      async () => {
        const { runId } = await runJobNow(job.id)
        if (runId) setOpenLog({ runId, title: job.name })
      },
      {
        done: 'Task started.',
        failed: "Couldn't start that task. It may already be running.",
        reload: jobs.reload,
      },
    )
  }

  const stop = async (job: JobSummary) => {
    const yes = await confirm({
      title: 'Stop task',
      message: `Stop "${job.name}"? Its work may be left half done until the next run.`,
      confirmLabel: 'Stop task',
    })
    if (!yes) return
    await run(() => cancelJob(job.id), {
      done: 'Task stopped.',
      failed: "Couldn't stop that task. It may have already finished.",
      reload: jobs.reload,
    })
  }

  if (jobs.error && !jobs.data) {
    return <AdminUnavailable error={jobs.error} onRetry={jobs.reload} />
  }
  if (jobs.loading) {
    return (
      <View style={{ padding: spacing.lg, gap: spacing.md }}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={132} radius={16} />
        ))}
      </View>
    )
  }

  return (
    <>
      <FlatList
        data={jobs.data ?? []}
        keyExtractor={(job) => job.id}
        renderItem={({ item }) => {
          const runId = item.lastRun?.id
          return (
            <JobCard
              job={item}
              busy={busy}
              onRun={() => start(item)}
              onStop={() => void stop(item)}
              onLogs={() => {
                if (runId) setOpenLog({ runId, title: item.name })
              }}
            />
          )
        }}
        contentContainerStyle={{
          padding: spacing.lg,
          gap: spacing.md,
          paddingBottom: bottomInset,
          flexGrow: 1,
        }}
        ListHeaderComponent={
          <AppText variant="meta" color={colors.textMuted}>
            {jobs.error
              ? "Couldn't refresh. This may be out of date."
              : 'These keep your library data fresh. They run on a schedule, or you can run one now.'}
          </AppText>
        }
        ListEmptyComponent={<EmptyState title="No tasks" body="This server has no tasks to run." />}
      />
      {openLog ? (
        <JobLogSheet
          key={openLog.runId}
          runId={openLog.runId}
          title={openLog.title}
          onClose={() => setOpenLog(null)}
        />
      ) : null}
    </>
  )
}
