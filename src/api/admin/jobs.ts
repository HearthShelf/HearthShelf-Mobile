/** The server's background tasks. Unlike web, failures reach the screen. */
import { HS_ENDPOINTS, type JobLogLine, type JobSummary } from '@hearthshelf/core'
import { adminRequest } from '@/api/abs'

export async function getJobs(): Promise<JobSummary[]> {
  const res = await adminRequest<{ jobs?: JobSummary[] }>(HS_ENDPOINTS.jobs)
  return res.jobs ?? []
}

export function runJobNow(jobId: string): Promise<{ runId: string | null }> {
  return adminRequest<{ runId: string | null }>(HS_ENDPOINTS.jobRun(encodeURIComponent(jobId)), {
    method: 'POST',
  })
}

export function cancelJob(jobId: string): Promise<{ runId: string | null }> {
  return adminRequest<{ runId: string | null }>(HS_ENDPOINTS.jobCancel(encodeURIComponent(jobId)), {
    method: 'POST',
  })
}

export async function getRunLogs(runId: string): Promise<JobLogLine[]> {
  const res = await adminRequest<{ logs?: JobLogLine[] }>(
    HS_ENDPOINTS.jobRunLogs(encodeURIComponent(runId)),
  )
  return res.logs ?? []
}
