/**
 * Live status on the admin home. Each tile loads on its own, so one failing shows a
 * dash there and leaves the rest of the home working.
 */
import { useRouter } from 'expo-router'
import { fmtSessDate, onlineUserIds } from '@hearthshelf/core'
import { getJobs } from '@/api/admin/jobs'
import { getAdminLibraryList, getLastBackupAt, getOnlineStatus } from '@/api/admin/stats'
import { ActivityTile, ActivityTileGrid } from './ActivityTile'
import { useAdminResource } from './useAdminResource'

const LIVE_POLL_MS = 30_000

export function ActivityHomeTiles() {
  const router = useRouter()
  const online = useAdminResource(getOnlineStatus, { pollMs: LIVE_POLL_MS })
  const libraries = useAdminResource(getAdminLibraryList)
  const backup = useAdminResource(getLastBackupAt)
  const jobs = useAdminResource(getJobs, { pollMs: LIVE_POLL_MS })

  const failedTasks = jobs.data?.filter((job) => job.lastRun?.status === 'error').length ?? null
  const lastBackup = backup.data ? fmtSessDate(backup.data).day : backup.error ? null : 'None yet'

  return (
    <ActivityTileGrid>
      <ActivityTile
        icon="group"
        label="Users online"
        value={online.data ? String(onlineUserIds(online.data).size) : null}
        loading={online.loading}
        onPress={() => router.push('/settings/admin/users')}
      />
      <ActivityTile
        icon="graphic-eq"
        label="Active sessions"
        value={online.data ? String(online.data.openSessions?.length ?? 0) : null}
        loading={online.loading}
        onPress={() => router.push('/settings/admin/sessions')}
      />
      <ActivityTile
        icon="video-library"
        label="Libraries"
        value={libraries.data ? String(libraries.data.length) : null}
        loading={libraries.loading}
        onPress={() => router.push('/settings/admin/libraries')}
      />
      <ActivityTile
        icon="cloud-sync"
        label="Last backup"
        value={lastBackup}
        loading={backup.loading}
        onPress={() => router.push('/settings/admin/backups')}
      />
      <ActivityTile
        icon={failedTasks ? 'error' : 'schedule'}
        label="Failed tasks"
        value={failedTasks === null ? null : failedTasks === 0 ? 'None' : String(failedTasks)}
        loading={jobs.loading}
        alert={Boolean(failedTasks)}
        onPress={() => router.push('/settings/admin/tasks')}
      />
    </ActivityTileGrid>
  )
}
