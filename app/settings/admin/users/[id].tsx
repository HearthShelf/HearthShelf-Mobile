/** One account: who they are, what they may do, what they've listened to, and
 *  the actions on the account. */
import { useMemo, useRef } from 'react'
import { View } from 'react-native'
import { router, useLocalSearchParams } from 'expo-router'
import {
  PERM_TOGGLES,
  computeListeningStats,
  fmtSessDate,
  type ABSUserMediaProgress,
} from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { StatusPill } from '@/admin/StatusPill'
import { TypedConfirm } from '@/admin/TypedConfirm'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { UserNotFound } from '@/admin/UserEditLoader'
import { useMachineCheck, useSelfAccount, userGuards } from '@/admin/UserGuards'
import { UserFinishedBooks, UserStats } from '@/admin/UserListening'
import { UserSessionRow } from '@/admin/UserSessionRow'
import { adminErrorKind } from '@/api/admin/errors'
import { getLinkedAbsUserIds, removeUser } from '@/api/admin/hosted'
import {
  getUserDetail,
  getUserListeningSessions,
  getUserListeningStats,
  progressKey,
  updateUser,
} from '@/api/admin/users'
import { avatarUrl } from '@/api/abs'
import { confirm } from '@/ui/confirm'
import { AppText, Avatar, type SheetRef } from '@/ui/primitives'
import { SettingsGroup, SettingsLabel, SettingsPanel, SettingsRow } from '@/ui/settingsControls'
import { SkeletonRow } from '@/ui/states'
import { showToast } from '@/ui/Toast'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'
import { usePagedList } from '@/ui/usePagedList'

const SESSIONS_PAGE_SIZE = 10

export default function UserDetailScreen() {
  return (
    <AdminGate>
      <UserDetail />
    </AdminGate>
  )
}

function UserDetail() {
  const colors = useColors()
  const { id } = useLocalSearchParams<{ id: string }>()
  const self = useSelfAccount()
  const detail = useAdminResource(() => getUserDetail(id))
  const linked = useAdminResource(getLinkedAbsUserIds)
  const machine = useMachineCheck()
  const rawStats = useAdminResource(() => getUserListeningStats(id))
  const sessions = usePagedList(
    async (offset, limit) => {
      const res = await getUserListeningSessions(id, Math.floor(offset / limit), limit)
      return { rows: res.sessions, total: res.total }
    },
    {
      pageSize: SESSIONS_PAGE_SIZE,
      keyOf: (s) => s.id,
      errorMessage: "Couldn't load their sessions.",
    },
  )
  const { run, busy } = useAdminWrite()
  const deleteRef = useRef<SheetRef>(null)

  const stats = useMemo(
    () => (rawStats.data ? computeListeningStats(rawStats.data, new Date()) : null),
    [rawStats.data],
  )
  const progressByItem = useMemo(() => {
    const map = new Map<string, ABSUserMediaProgress>()
    for (const p of detail.data?.progress ?? [])
      map.set(progressKey(p.libraryItemId, p.episodeId), p)
    return map
  }, [detail.data])

  if (!detail.data) {
    if (detail.loading) {
      return (
        <SettingsPanel>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </SettingsPanel>
      )
    }
    if (adminErrorKind(detail.error) === 'missing') return <UserNotFound />
    return <AdminUnavailable error={detail.error} onRetry={detail.reload} />
  }

  const { user, permissions, progress } = detail.data
  const machineState = machine.stateOf(user)
  const guards = userGuards(user, self, machineState)
  const linkState = linked.data
    ? linked.data.has(user.id)
      ? 'Connected'
      : 'Not connected'
    : 'Unknown'
  const newest = sessions.rows[0]
  const lastActive = Math.max(
    user.lastSeen ?? 0,
    newest ? newest.updatedAt || newest.startedAt || 0 : 0,
  )
  const seen = lastActive > 0 ? fmtSessDate(lastActive) : null
  const grants = PERM_TOGGLES.filter((t) => permissions[t.key] === true)

  function openEditor(screen: 'account' | 'permissions' | 'password') {
    router.push({ pathname: `/settings/admin/users/${screen}`, params: { id: user.id } })
  }

  async function setActive(isActive: boolean) {
    if (!isActive) {
      const ok = await confirm({
        title: 'Disable user',
        message: `Disable ${user.username}? They can't sign in until you enable the account again.`,
        confirmLabel: 'Disable user',
      })
      if (!ok) return
    }
    await run(() => updateUser(user.id, { isActive }), {
      done: isActive ? `Enabled ${user.username}` : `Disabled ${user.username}`,
      failed: `Couldn't ${isActive ? 'enable' : 'disable'} ${user.username}.`,
      reload: detail.reload,
    })
  }

  async function doDelete() {
    const result: { unlinked: boolean; email: string | null } = { unlinked: true, email: null }
    const ok = await run(
      async () => {
        const res = await removeUser(user.id, user.email)
        result.unlinked = res.unlinked
        result.email = res.email
      },
      { failed: `Couldn't delete ${user.username}.` },
    )
    if (!ok) {
      detail.reload()
      return
    }
    // With no email on file there was never a link to remove.
    showToast(
      result.unlinked || !result.email
        ? `Deleted ${user.username}`
        : `Deleted ${user.username}, but they may still see this server in their list.`,
    )
    router.back()
  }

  return (
    <SettingsPanel>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <Avatar uri={avatarUrl(user.id) || undefined} size={56} name={user.username} />
        <View style={{ flex: 1 }}>
          <AppText variant="title" numberOfLines={1}>
            {user.username}
          </AppText>
          <AppText variant="meta" color={colors.textMuted}>
            {guards.isSelf ? `${user.type} · This is you` : user.type}
          </AppText>
        </View>
      </View>

      <SettingsGroup>
        <SettingsRow icon="email" title="Email" desc={user.email ?? 'None'} />
        <SettingsRow icon="toggle-on" title="Status" desc={user.isActive ? 'Active' : 'Disabled'} />
        <SettingsRow icon="lock" title="Locked" desc={user.isLocked ? 'Yes' : 'No'} />
        <SettingsRow icon="link" title="HearthShelf account" desc={linkState} />
        <SettingsRow
          icon="schedule"
          title="Last seen"
          desc={seen ? `${seen.day} · ${seen.time}` : 'Never'}
        />
        <SettingsRow
          icon="calendar-today"
          title="Created"
          desc={fmtSessDate(user.createdAt).day}
          last
        />
      </SettingsGroup>

      {machineState === 'machine' ? (
        <View style={{ gap: spacing.sm }}>
          <AppText variant="meta" color={colors.textMuted}>
            This is a machine account. Changes here could break the server.
          </AppText>
          <AdminButton
            label="Service accounts"
            kind="secondary"
            onPress={() => router.push('/settings/admin/service-accounts')}
          />
        </View>
      ) : machine.failed ? (
        <View style={{ gap: spacing.sm }}>
          <AppText variant="meta" color={colors.textMuted}>
            We couldn't check if this is a machine account, so changes are off.
          </AppText>
          <AdminButton label="Try again" kind="secondary" onPress={machine.reload} />
        </View>
      ) : guards.canEdit ? (
        <View>
          <SettingsLabel>Manage</SettingsLabel>
          <SettingsGroup>
            <SettingsRow
              icon="edit"
              title="Edit account"
              desc="Username and email."
              onPress={() => openEditor('account')}
            />
            <SettingsRow
              icon="key"
              title="Edit permissions"
              desc="Account type and what they can do."
              onPress={() => openEditor('permissions')}
            />
            <SettingsRow
              icon="lock-reset"
              title="Reset password"
              desc="Set a new password for them."
              onPress={() => openEditor('password')}
              last
            />
          </SettingsGroup>
        </View>
      ) : guards.isRoot && machineState === 'person' ? (
        <AppText variant="meta" color={colors.textMuted}>
          A root account can only be edited while signed in as root.
        </AppText>
      ) : null}

      {grants.length > 0 ? (
        <View>
          <SettingsLabel>Permissions</SettingsLabel>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {grants.map((t) => (
              <StatusPill key={t.key} label={t.label} />
            ))}
          </View>
        </View>
      ) : null}

      {stats && stats.totalTimeSec > 0 ? <UserStats stats={stats} /> : null}
      {rawStats.error && !rawStats.data ? (
        <AppText variant="meta" color={colors.textMuted}>
          Couldn't load their listening stats.
        </AppText>
      ) : null}

      <UserFinishedBooks progress={progress} />

      {sessions.rows.length > 0 ? (
        <View style={{ gap: spacing.sm }}>
          <View>
            <SettingsLabel>Recent sessions</SettingsLabel>
            <SettingsGroup>
              {sessions.rows.map((s, i) => (
                <UserSessionRow
                  key={s.id}
                  session={s}
                  progress={progressByItem.get(progressKey(s.libraryItemId, s.episodeId))}
                  last={i === sessions.rows.length - 1}
                />
              ))}
            </SettingsGroup>
          </View>
          {sessions.atEnd ? null : (
            <AdminButton
              label="Show older"
              kind="secondary"
              busy={sessions.loadingMore}
              onPress={sessions.onEndReached}
            />
          )}
        </View>
      ) : null}
      {sessions.error ? (
        <AppText variant="meta" color={colors.textMuted}>
          {sessions.error}
        </AppText>
      ) : null}

      {guards.canEdit && (!user.isActive || guards.canRemove) ? (
        <View style={{ gap: spacing.sm }}>
          <SettingsLabel>Account actions</SettingsLabel>
          {!user.isActive ? (
            <AdminButton
              label="Enable user"
              kind="secondary"
              icon="check-circle"
              busy={busy}
              onPress={() => void setActive(true)}
            />
          ) : guards.canRemove ? (
            <AdminButton
              label="Disable user"
              kind="secondary"
              icon="block"
              busy={busy}
              onPress={() => void setActive(false)}
            />
          ) : null}
          {guards.canRemove ? (
            <AdminButton
              label="Delete user"
              kind="danger"
              icon="delete"
              busy={busy}
              onPress={() => deleteRef.current?.present()}
            />
          ) : null}
        </View>
      ) : null}

      <TypedConfirm
        ref={deleteRef}
        title="Delete user"
        message={`This deletes ${user.username}'s account, playlists and progress, and removes their access to this server. It can't be undone.`}
        confirmText={user.username}
        confirmLabel="Delete user"
        onConfirm={() => void doDelete()}
      />
    </SettingsPanel>
  )
}
