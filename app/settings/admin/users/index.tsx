/** Server Admin > Users: the people on this server, with live presence. Machine
 *  logins are kept out of this list. */
import { useCallback, useMemo, useState } from 'react'
import { FlatList, Pressable, View } from 'react-native'
import { router, useFocusEffect } from 'expo-router'
import { humanUsers, type ABSAdminUser } from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminCard } from '@/admin/AdminCard'
import { AdminField } from '@/admin/AdminField'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { UserCard } from '@/admin/UserCard'
import { takeBulkFinished, useMachineCheck } from '@/admin/UserGuards'
import { getInviteState, recoverAdmins } from '@/api/admin/hosted'
import { getLastSeenByUser, getOnlineUserIds, getUsers } from '@/api/admin/users'
import { useConnection } from '@/api/ConnectionProvider'
import { confirm } from '@/ui/confirm'
import { icons } from '@/ui/icons'
import { AppText } from '@/ui/primitives'
import { SettingsGroup, SettingsRow } from '@/ui/settingsControls'
import { EmptyState, SkeletonRow } from '@/ui/states'
import { showToast } from '@/ui/Toast'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'
import { useBackHandler } from '@/ui/useBackHandler'
import { useBookSelection } from '@/ui/useBookSelection'
import { useContentInset } from '@/ui/useContentInset'

const PRESENCE_POLL_MS = 30000

export default function UsersScreen() {
  return (
    <AdminGate>
      <Users />
    </AdminGate>
  )
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many
}

function Users() {
  const colors = useColors()
  const bottomInset = useContentInset()
  const { serverName } = useConnection()
  const accounts = useAdminResource(getUsers)
  const online = useAdminResource(getOnlineUserIds, { pollMs: PRESENCE_POLL_MS })
  const lastSeen = useAdminResource(getLastSeenByUser)
  const machine = useMachineCheck()
  const invites = useAdminResource(getInviteState)
  const selection = useBookSelection()
  const { run, busy } = useAdminWrite()
  const [query, setQuery] = useState('')

  const { clear } = selection
  useFocusEffect(
    useCallback(() => {
      if (takeBulkFinished()) clear()
    }, [clear]),
  )
  useBackHandler(
    useCallback(() => {
      clear()
      return true
    }, [clear]),
    selection.selecting,
  )

  const allUsers = useMemo(() => accounts.data?.users ?? [], [accounts.data])
  const users = useMemo(
    () => humanUsers(allUsers, machine.serviceIds ?? new Set<string>(), machine.serviceUsername),
    [allUsers, machine.serviceIds, machine.serviceUsername],
  )
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return users
    return users.filter(
      (u) => u.username.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q),
    )
  }, [users, query])

  if (accounts.error && !accounts.data) {
    return <AdminUnavailable error={accounts.error} onRetry={accounts.reload} />
  }

  // Wait for all three, or machine accounts appear as people and then vanish.
  const settling = accounts.loading || machine.settling
  // Without the machine list, one could be sitting in this list as a person.
  const selecting = selection.selecting && machine.known
  const serviceCount = allUsers.length - users.length
  const disabledAdmins = users.filter(
    (u) => (u.type === 'admin' || u.type === 'root') && !u.isActive,
  )
  const paired = invites.data?.paired ?? false
  const invitesFailed = Boolean(invites.error) && !invites.data
  const pendingCount = invites.data?.invites.length ?? 0
  const selectedIds = users.filter((u) => selection.isSelected(u.id)).map((u) => u.id)

  async function recover() {
    const ok = await confirm({
      title: 'Recover admin access',
      message: `Turn every disabled admin account on "${
        serverName ?? 'this server'
      }" back on? This uses the server's HearthShelf connection.`,
      confirmLabel: 'Recover admins',
      destructive: false,
    })
    if (!ok) return
    const result = { count: 0 }
    const done = await run(
      async () => {
        result.count = (await recoverAdmins()).count
      },
      { failed: "Couldn't recover admin access.", reload: accounts.reload },
    )
    if (!done) return
    showToast(
      result.count > 0
        ? `Turned ${result.count} admin ${plural(result.count, 'account', 'accounts')} back on`
        : 'No disabled admins to recover',
    )
  }

  const header = (
    <View style={{ gap: spacing.md }}>
      {disabledAdmins.length > 0 ? (
        <AdminCard
          title="Recover admin access"
          subtitle={`${disabledAdmins.length} admin ${plural(
            disabledAdmins.length,
            'account is',
            'accounts are',
          )} disabled. This turns all of them back on.`}
        >
          <View style={{ marginTop: spacing.sm }}>
            <AdminButton
              label="Recover admins"
              icon="lock-reset"
              busy={busy}
              onPress={() => void recover()}
            />
          </View>
        </AdminCard>
      ) : null}

      {machine.failed ? (
        <AdminCard
          title="Some of these may be machine accounts"
          subtitle="We couldn't check which accounts are machines, so selecting is off, and so is changing any account."
        >
          <View style={{ marginTop: spacing.sm }}>
            <AdminButton label="Try again" kind="secondary" onPress={machine.reload} />
          </View>
        </AdminCard>
      ) : null}

      {selecting ? (
        <View style={{ gap: spacing.sm }}>
          <AppText variant="label">{selectedIds.length} selected</AppText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            <AdminButton
              label="Edit permissions"
              icon="key"
              disabled={selectedIds.length === 0}
              onPress={() =>
                router.push({
                  pathname: '/settings/admin/users/bulk',
                  params: { ids: selectedIds.join(',') },
                })
              }
            />
            <AdminButton
              label="Select all"
              kind="secondary"
              onPress={() => selection.selectAll(visible.map((u) => u.id))}
            />
            <AdminButton label="Done" kind="secondary" onPress={selection.clear} />
          </View>
        </View>
      ) : (
        <>
          <SettingsGroup>
            {paired || invitesFailed ? (
              <SettingsRow
                icon="send"
                title="Invites"
                desc={
                  invitesFailed
                    ? "Couldn't load invites. Tap to try again."
                    : pendingCount > 0
                      ? `${pendingCount} waiting. Invite someone by email.`
                      : 'Invite someone by email.'
                }
                descColor={invitesFailed ? colors.destructive : undefined}
                onPress={() => router.push('/settings/admin/users/invite')}
              />
            ) : null}
            <SettingsRow
              icon={icons.personAdd}
              title="Add a user"
              desc="Set up an account with a password."
              onPress={() => router.push('/settings/admin/users/add')}
              last
            />
          </SettingsGroup>
          {invites.data && !paired ? (
            <AppText variant="caption" color={colors.textMuted}>
              Connect this server to HearthShelf to invite people by email.
            </AppText>
          ) : null}
        </>
      )}

      <AdminField
        label="Search"
        placeholder="Name or email"
        value={query}
        onChangeText={setQuery}
        returnKeyType="search"
      />

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        {serviceCount > 0 ? (
          <Pressable
            style={{ flex: 1 }}
            accessibilityRole="link"
            onPress={() => router.push('/settings/admin/service-accounts')}
          >
            <AppText variant="caption" color={colors.textMuted}>
              {`${serviceCount} machine ${plural(
                serviceCount,
                'account is',
                'accounts are',
              )} hidden here. Tap to manage them.`}
            </AppText>
          </Pressable>
        ) : (
          <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
            Press and hold a person to select more than one.
          </AppText>
        )}
        {selecting || !machine.known ? null : (
          <AdminButton label="Select" kind="secondary" onPress={() => selection.begin()} />
        )}
      </View>
    </View>
  )

  function renderUser({ item }: { item: ABSAdminUser }) {
    return (
      <UserCard
        user={item}
        online={online.data ? online.data.has(item.id) : null}
        lastSeen={
          lastSeen.data
            ? Math.max(item.lastSeen ?? 0, lastSeen.data.get(item.id) ?? 0)
            : item.lastSeen || null
        }
        selecting={selecting}
        selected={selection.isSelected(item.id)}
        onPress={() =>
          selecting ? selection.toggle(item.id) : router.push(`/settings/admin/users/${item.id}`)
        }
        onLongPress={() => {
          if (machine.known) selection.begin(item.id)
        }}
      />
    )
  }

  return (
    <FlatList
      data={settling ? [] : visible}
      keyExtractor={(u) => u.id}
      renderItem={renderUser}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={header}
      ListEmptyComponent={
        settling ? (
          <View style={{ gap: spacing.sm }}>
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </View>
        ) : (
          <EmptyState
            icon={icons.person}
            title={query ? 'No one matches that' : 'No users yet'}
            body={query ? 'Try a different name or email.' : undefined}
          />
        )
      }
      contentContainerStyle={{ padding: spacing.lg, gap: spacing.md, paddingBottom: bottomInset }}
    />
  )
}
