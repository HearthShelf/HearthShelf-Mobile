/** Server and library totals, with all-time listening activity. */
import { useState } from 'react'
import { ScrollView, View } from 'react-native'
import { fmtBytes, formatTimestamp } from '@hearthshelf/core'
import { ActivityChart } from '@/admin/ActivityChart'
import { ActivityTile, ActivityTileGrid } from '@/admin/ActivityTile'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { useAdminResource } from '@/admin/useAdminResource'
import {
  getAdminLibraryList,
  getLibraryStats,
  getServerActivity,
  getServerStats,
} from '@/api/admin/stats'
import { AppText, Card, Chip } from '@/ui/primitives'
import { SettingsGroup, SettingsLabel, SettingsPanel, SettingsRow } from '@/ui/settingsControls'
import { SkeletonRow } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

export default function AdminStatsScreen() {
  return (
    <AdminGate>
      <AdminStats />
    </AdminGate>
  )
}

function AdminStats() {
  const colors = useColors()
  const stats = useAdminResource(getServerStats)
  const activity = useAdminResource(getServerActivity)
  const data = stats.data

  if (stats.error && !data) {
    return <AdminUnavailable error={stats.error} onRetry={stats.reload} />
  }

  return (
    <SettingsPanel>
      <SettingsLabel>This server</SettingsLabel>
      <ActivityTileGrid>
        <ActivityTile
          icon="menu-book"
          label="Books"
          value={data ? String(data.books.numItems) : null}
          loading={stats.loading}
        />
        <ActivityTile
          icon="podcasts"
          label="Podcasts"
          value={data ? String(data.podcasts.numItems) : null}
          loading={stats.loading}
        />
        <ActivityTile
          icon="audio-file"
          label="Audio files"
          value={data ? String(data.total.numAudioFiles) : null}
          loading={stats.loading}
        />
        <ActivityTile
          icon="storage"
          label="Total size"
          value={data ? fmtBytes(data.total.totalSize) : null}
          loading={stats.loading}
        />
      </ActivityTileGrid>

      <SettingsLabel>Overall activity</SettingsLabel>
      <Card>
        <View style={{ gap: spacing.md }}>
          <AppText variant="caption" color={colors.textMuted}>
            All listening by everyone, in your local time.
          </AppText>
          {activity.data ? (
            <ActivityChart data={activity.data} />
          ) : activity.error ? (
            <AdminUnavailable error={activity.error} onRetry={activity.reload} />
          ) : (
            <SkeletonRow />
          )}
        </View>
      </Card>

      <LibrarySection />
    </SettingsPanel>
  )
}

function LibrarySection() {
  const colors = useColors()
  const libraries = useAdminResource(getAdminLibraryList)
  const [picked, setPicked] = useState<string | null>(null)
  const list = libraries.data ?? []
  const active = list.find((library) => library.id === picked) ?? list[0]

  return (
    <>
      <SettingsLabel>Library</SettingsLabel>
      {libraries.error && !libraries.data ? (
        <AdminUnavailable error={libraries.error} onRetry={libraries.reload} />
      ) : libraries.loading ? (
        <SkeletonRow />
      ) : !active ? (
        <AppText variant="meta" color={colors.textMuted}>
          This server has no libraries yet.
        </AppText>
      ) : (
        <>
          {list.length > 1 ? (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: spacing.sm }}
            >
              {list.map((library) => (
                <Chip
                  key={library.id}
                  label={library.name}
                  active={library.id === active.id}
                  onPress={() => setPicked(library.id)}
                />
              ))}
            </ScrollView>
          ) : null}
          <LibraryStats key={active.id} libraryId={active.id} />
        </>
      )}
    </>
  )
}

function LibraryStats({ libraryId }: { libraryId: string }) {
  const stats = useAdminResource(() => getLibraryStats(libraryId))
  const data = stats.data

  if (stats.error && !data) {
    return <AdminUnavailable error={stats.error} onRetry={stats.reload} />
  }

  const longest = data?.longestItems.slice(0, 10) ?? []
  return (
    <>
      <ActivityTileGrid>
        <ActivityTile
          icon="menu-book"
          label="Items"
          value={data ? String(data.totalItems) : null}
          loading={stats.loading}
        />
        {data && data.totalAuthors === undefined ? null : (
          <ActivityTile
            icon="person"
            label="Authors"
            value={data ? String(data.totalAuthors) : null}
            loading={stats.loading}
          />
        )}
        <ActivityTile
          icon="category"
          label="Genres"
          value={data ? String(data.totalGenres) : null}
          loading={stats.loading}
        />
        <ActivityTile
          icon="schedule"
          label="Total length"
          value={data ? `${Math.round(data.totalDuration / 3600)}h` : null}
          loading={stats.loading}
        />
        <ActivityTile
          icon="audio-file"
          label="Audio tracks"
          value={data ? String(data.numAudioTracks) : null}
          loading={stats.loading}
        />
        <ActivityTile
          icon="storage"
          label="Total size"
          value={data ? fmtBytes(data.totalSize) : null}
          loading={stats.loading}
        />
      </ActivityTileGrid>

      {longest.length > 0 ? (
        <>
          <SettingsLabel>Longest items</SettingsLabel>
          <SettingsGroup>
            {longest.map((item, i) => (
              <SettingsRow
                key={item.id}
                title={item.title}
                desc={formatTimestamp(item.duration ?? 0)}
                last={i === longest.length - 1}
              />
            ))}
          </SettingsGroup>
        </>
      ) : null}
    </>
  )
}
