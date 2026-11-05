/** Open RSS feeds, and closing them. */
import { FlatList, View } from 'react-native'
import type { ABSRssFeed } from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminCard } from '@/admin/AdminCard'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { closeRssFeed, getRssFeeds } from '@/api/admin/rss'
import { confirm } from '@/ui/confirm'
import { AppText } from '@/ui/primitives'
import { EmptyState, Skeleton } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'
import { useContentInset } from '@/ui/useContentInset'

const ENTITY_LABELS: Record<string, string> = {
  libraryItem: 'Book or podcast',
  series: 'Series',
  collection: 'Collection',
  playlist: 'Playlist',
}

export default function AdminRssScreen() {
  return (
    <AdminGate>
      <AdminRss />
    </AdminGate>
  )
}

function feedTitle(feed: ABSRssFeed): string {
  return feed.meta?.title || feed.feedUrl
}

function AdminRss() {
  const colors = useColors()
  const bottomInset = useContentInset()
  const feeds = useAdminResource(getRssFeeds)
  const { run, busy } = useAdminWrite()

  const close = async (feed: ABSRssFeed) => {
    const yes = await confirm({
      title: 'Close feed',
      message: `Close the feed for "${feedTitle(feed)}"? Anyone using its link will stop getting updates.`,
      confirmLabel: 'Close feed',
    })
    if (!yes) return
    await run(() => closeRssFeed(feed.id), {
      done: 'Feed closed.',
      failed: "Couldn't close that feed.",
      reload: feeds.reload,
    })
  }

  if (feeds.error && !feeds.data) {
    return <AdminUnavailable error={feeds.error} onRetry={feeds.reload} />
  }
  if (feeds.loading) {
    return (
      <View style={{ padding: spacing.lg, gap: spacing.md }}>
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={96} radius={16} />
        ))}
      </View>
    )
  }

  const list = feeds.data ?? []
  return (
    <FlatList
      data={list}
      keyExtractor={(feed) => feed.id}
      renderItem={({ item }) => (
        <AdminCard
          title={feedTitle(item)}
          subtitle={ENTITY_LABELS[item.entityType] ?? item.entityType}
        >
          <View style={{ marginTop: spacing.sm, alignSelf: 'flex-start' }}>
            <AdminButton
              label="Close feed"
              icon="close"
              kind="danger"
              onPress={() => void close(item)}
              disabled={busy}
            />
          </View>
        </AdminCard>
      )}
      contentContainerStyle={{
        padding: spacing.lg,
        gap: spacing.md,
        paddingBottom: bottomInset,
        flexGrow: 1,
      }}
      ListHeaderComponent={
        list.length > 0 ? (
          <AppText variant="meta" color={colors.textMuted}>
            {list.length === 1 ? '1 open feed' : `${list.length} open feeds`}
          </AppText>
        ) : null
      }
      ListEmptyComponent={
        <EmptyState
          icon="rss-feed"
          title="No open RSS feeds"
          body="Feeds opened from a book, series, or collection show up here."
        />
      }
    />
  )
}
