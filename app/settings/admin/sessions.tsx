/** Everyone's listening sessions, newest first. */
import { useState } from 'react'
import { ActivityIndicator, FlatList, View } from 'react-native'
import { fmtSessDate, formatTimestamp } from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminCard } from '@/admin/AdminCard'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { deleteAdminSession, getAdminSessions, type AdminSessionRow } from '@/api/admin/sessions'
import { confirm } from '@/ui/confirm'
import { icons } from '@/ui/icons'
import { AppText, IconButton } from '@/ui/primitives'
import { EmptyState, Skeleton } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'
import { useContentInset } from '@/ui/useContentInset'
import { usePagedList } from '@/ui/usePagedList'

export default function AdminSessionsScreen() {
  return (
    <AdminGate>
      <AdminSessions />
    </AdminGate>
  )
}

function sessionTitle(session: AdminSessionRow): string {
  return session.displayTitle || 'Unknown title'
}

function SessionCard({
  session,
  onDelete,
}: {
  session: AdminSessionRow
  onDelete: (session: AdminSessionRow) => void
}) {
  const colors = useColors()
  const when = fmtSessDate(session.startedAt)
  const who = session.user?.username ?? 'Deleted user'
  return (
    <AdminCard
      title={sessionTitle(session)}
      subtitle={[who, session.displayAuthor].filter(Boolean).join(' · ')}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          marginTop: spacing.sm,
        }}
      >
        <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
          {formatTimestamp(session.timeListening)} listened · {when.day}, {when.time}
        </AppText>
        <IconButton
          name={icons.delete}
          size={22}
          color={colors.textMuted}
          onPress={() => onDelete(session)}
          accessibilityLabel={`Delete session for ${sessionTitle(session)}`}
        />
      </View>
    </AdminCard>
  )
}

function AdminSessions() {
  const colors = useColors()
  const bottomInset = useContentInset()
  const { run } = useAdminWrite()
  // usePagedList keeps only a message, and the screen needs the cause to tell
  // "not on this server" from "no connection".
  const [loadError, setLoadError] = useState<unknown>(null)
  const list = usePagedList<AdminSessionRow>(
    (offset, limit) =>
      getAdminSessions(offset, limit).catch((e: unknown) => {
        setLoadError(e)
        throw e
      }),
    { keyOf: (session) => session.id, errorMessage: "Couldn't load sessions." },
  )

  const remove = async (session: AdminSessionRow) => {
    const yes = await confirm({
      title: 'Delete session',
      message: `Delete the listening session for "${sessionTitle(session)}"? This only removes the history record, not the book.`,
      confirmLabel: 'Delete session',
    })
    if (!yes) return
    const ok = await run(() => deleteAdminSession(session.id), {
      done: 'Session deleted.',
      failed: "Couldn't delete that session.",
    })
    if (ok) list.removeRow((row) => row.id === session.id)
    else list.reload()
  }

  if (list.firstLoad) {
    return (
      <View style={{ padding: spacing.lg, gap: spacing.md }}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={84} radius={16} />
        ))}
      </View>
    )
  }
  if (list.error && list.rows.length === 0) {
    return <AdminUnavailable error={loadError} onRetry={list.reload} />
  }

  return (
    <FlatList
      data={list.rows}
      keyExtractor={(session) => session.id}
      renderItem={({ item }) => <SessionCard session={item} onDelete={(s) => void remove(s)} />}
      onEndReached={list.onEndReached}
      onEndReachedThreshold={0.5}
      refreshing={false}
      onRefresh={list.reload}
      contentContainerStyle={{
        padding: spacing.lg,
        gap: spacing.md,
        paddingBottom: bottomInset,
        flexGrow: 1,
      }}
      ListHeaderComponent={
        list.rows.length > 0 ? (
          <AppText variant="meta" color={colors.textMuted}>
            {list.total === 1 ? '1 session' : `${list.total} sessions`} on this server
          </AppText>
        ) : null
      }
      ListEmptyComponent={
        <EmptyState
          icon={icons.history}
          title="No sessions yet"
          body="Listening shows up here once someone plays something."
        />
      }
      ListFooterComponent={
        list.error ? (
          <AdminButton label="Try again" kind="secondary" onPress={list.reload} />
        ) : list.loadingMore ? (
          <ActivityIndicator color={colors.textMuted} />
        ) : null
      }
    />
  )
}
