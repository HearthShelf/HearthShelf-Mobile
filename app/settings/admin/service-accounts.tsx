/**
 * Machine logins: regular admin accounts given to other apps, grouped here by a tag
 * HearthShelf keeps. A create or delete can finish on ABS and fail on the tag, so
 * each flow says what actually happened and reloads.
 */
import { useRef, useState, useSyncExternalStore } from 'react'
import { FlatList, View } from 'react-native'
import type { ABSAdminUser, ABSApiKey } from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminCard } from '@/admin/AdminCard'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { SecretReveal } from '@/admin/SecretReveal'
import { ServiceAccountCard } from '@/admin/ServiceAccountCard'
import {
  EditServiceAccountForm,
  NewServiceAccountForm,
  NewServiceTokenForm,
} from '@/admin/ServiceAccountForms'
import { TypedConfirm } from '@/admin/TypedConfirm'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { createApiKey, deleteApiKey, getApiKeys } from '@/api/admin/apikeys'
import {
  createServiceAccount,
  deleteServiceAccount,
  getServiceAccounts,
  tagServiceAccount,
  untagServiceAccount,
  updateServiceAccount,
  type ServiceAccountPatch,
} from '@/api/admin/serviceAccounts'
import { getMeId, getMeType, subscribeMeId, subscribeMeType } from '@/api/me'
import { confirm } from '@/ui/confirm'
import { AppText, Sheet, type SheetRef } from '@/ui/primitives'
import { EmptyState, SkeletonRow } from '@/ui/states'
import { showToast } from '@/ui/Toast'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'
import { useContentInset } from '@/ui/useContentInset'

interface Reveal {
  title: string
  message: string
  secret: string
}

function ServiceAccounts() {
  const colors = useColors()
  const bottomInset = useContentInset()
  const meId = useSyncExternalStore(subscribeMeId, getMeId)
  const callerIsRoot = useSyncExternalStore(subscribeMeType, getMeType) === 'root'
  const { data, loading, error, reload } = useAdminResource(getServiceAccounts)
  const tokens = useAdminResource(getApiKeys)
  const { run, busy } = useAdminWrite()

  const [expanded, setExpanded] = useState<string | null>(null)
  const [editing, setEditing] = useState<ABSAdminUser | null>(null)
  const [tokenFor, setTokenFor] = useState<ABSAdminUser | null>(null)
  const [deleting, setDeleting] = useState<ABSAdminUser | null>(null)
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [untagged, setUntagged] = useState<{ id: string; username: string } | null>(null)

  const addSheet = useRef<SheetRef>(null)
  const editSheet = useRef<SheetRef>(null)
  const tokenSheet = useRef<SheetRef>(null)
  const revealSheet = useRef<SheetRef>(null)
  const deleteSheet = useRef<SheetRef>(null)

  if (!data && error) return <AdminUnavailable error={error} onRetry={reload} />

  // A tag call that timed out may have worked, so the server's list decides.
  const needsTag = untagged && data && !data.trackedIds.has(untagged.id) ? untagged : null

  function showReveal(next: Reveal) {
    setReveal(next)
    revealSheet.current?.present()
  }

  function create(input: { username: string; password: string; email: string | null }) {
    // On failure the sheet stays open, so a generated password isn't lost.
    void run(
      async () => {
        const { user, tagged } = await createServiceAccount(input)
        setUntagged(tagged ? null : { id: user.id, username: user.username })
        addSheet.current?.dismiss()
        showReveal({
          title: 'Account created',
          message: tagged
            ? `${user.username} is ready. Open Tokens on its card to make one.`
            : `${user.username} was created, but we couldn't add it to this list. It shows in Users for now. Save the password, then tap Try again on this screen.`,
          secret: input.password,
        })
      },
      { failed: "Couldn't create the account.", reload },
    )
  }

  function retryTag(account: { id: string; username: string }) {
    void run(
      async () => {
        await tagServiceAccount(account.id)
        setUntagged(null)
      },
      {
        done: `${account.username} is on this list now`,
        failed: `Couldn't add ${account.username} to this list.`,
        reload,
      },
    )
  }

  async function saveEdit(account: ABSAdminUser, patch: ServiceAccountPatch) {
    const risks: string[] = []
    if (patch.password) risks.push('Its password will change, and it will be signed out.')
    if (patch.isActive === false) {
      risks.push('It will be turned off, and apps using its tokens will stop working.')
    }
    if (
      risks.length > 0 &&
      !(await confirm({
        title: `Change ${account.username}?`,
        message: risks.join(' '),
        confirmLabel: 'Save changes',
      }))
    ) {
      return
    }
    const ok = await run(() => updateServiceAccount(account.id, patch), {
      done: 'Saved',
      failed: "Couldn't save those changes.",
      reload,
    })
    if (ok) editSheet.current?.dismiss()
  }

  async function untag(account: ABSAdminUser) {
    const ok = await confirm({
      title: 'Move to Users?',
      message: `${account.username} moves back to the Users list. The account and its tokens are kept.`,
      confirmLabel: 'Move',
      destructive: false,
    })
    if (!ok) return
    void run(() => untagServiceAccount(account.id), {
      done: `Moved ${account.username} to Users`,
      failed: `Couldn't move ${account.username}.`,
      reload,
    })
  }

  function remove(account: ABSAdminUser) {
    void run(
      async () => {
        const { tagCleared } = await deleteServiceAccount(account.id)
        showToast(
          tagCleared
            ? `Deleted ${account.username}`
            : `Deleted ${account.username}. An old list entry stayed behind, which does no harm.`,
        )
      },
      {
        failed: `Couldn't delete ${account.username}.`,
        reload: () => {
          reload()
          tokens.reload()
        },
      },
    )
  }

  function createToken(account: ABSAdminUser, name: string) {
    void run(
      async () => {
        const { apiKey: token } = await createApiKey(name, account.id, null)
        tokenSheet.current?.dismiss()
        if (token) {
          showReveal({
            title: 'Token created',
            message: `Give this to the app that signs in as ${account.username}.`,
            secret: token,
          })
        } else {
          showToast("The token was made, but the server didn't send it. Revoke it and try again.")
        }
      },
      { failed: "Couldn't create the token.", reload: tokens.reload },
    )
  }

  async function revoke(account: ABSAdminUser, key: ABSApiKey) {
    const ok = await confirm({
      title: `Revoke ${key.name}?`,
      message:
        account.id === meId
          ? 'Anything using this token stops working right away. You are signed in as this account, so this app may be one of them.'
          : 'Anything using this token stops working right away.',
      confirmLabel: 'Revoke',
    })
    if (!ok) return
    void run(() => deleteApiKey(key.id), {
      done: `Revoked ${key.name}`,
      failed: `Couldn't revoke ${key.name}.`,
      reload: tokens.reload,
    })
  }

  const header = (
    <View style={{ gap: spacing.md, marginBottom: spacing.md }}>
      <AppText variant="meta" color={colors.textMuted}>
        Machine logins, not people. Give another app its own token instead of sharing yours. These
        are regular admin accounts on your server.
      </AppText>
      <AdminButton
        label="New service account"
        icon="add"
        onPress={() => addSheet.current?.present()}
      />
      {needsTag ? (
        <AdminCard
          title={`${needsTag.username} isn't on this list yet`}
          subtitle="The account exists and shows in Users until this works."
          status="Half done"
          statusTone="bad"
        >
          <View style={{ marginTop: spacing.md }}>
            <AdminButton
              label="Try again"
              icon="refresh"
              kind="secondary"
              busy={busy}
              onPress={() => retryTag(needsTag)}
            />
          </View>
        </AdminCard>
      ) : null}
    </View>
  )

  return (
    <>
      <FlatList
        data={data?.accounts ?? []}
        keyExtractor={(u) => u.id}
        extraData={[expanded, tokens.data, tokens.loading, meId, callerIsRoot]}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: bottomInset }}
        ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
        ListHeaderComponent={header}
        ListEmptyComponent={
          loading || !data ? (
            <View style={{ gap: spacing.md }}>
              <SkeletonRow />
              <SkeletonRow width="80%" />
            </View>
          ) : (
            <EmptyState
              icon="smart-toy"
              title="No service accounts"
              body="Make one to give another app its own token."
            />
          )
        }
        renderItem={({ item }) => {
          const isRoot = item.type === 'root'
          const owned = data?.serviceUsername === item.username
          return (
            <ServiceAccountCard
              account={item}
              owned={owned}
              open={expanded === item.id}
              canEdit={!owned && (!isRoot || callerIsRoot)}
              canCreateTokens={!isRoot || callerIsRoot}
              canDelete={!isRoot && !owned && item.id !== meId}
              tokens={{ keys: tokens.data, loading: tokens.loading, onRetry: tokens.reload }}
              onToggleTokens={() => setExpanded(expanded === item.id ? null : item.id)}
              onEdit={() => {
                setEditing(item)
                editSheet.current?.present()
              }}
              onUntag={() => void untag(item)}
              onDelete={() => {
                setDeleting(item)
                deleteSheet.current?.present()
              }}
              onNewToken={() => {
                setTokenFor(item)
                tokenSheet.current?.present()
              }}
              onRevokeToken={(key) => void revoke(item, key)}
            />
          )
        }}
      />

      <Sheet ref={addSheet} title="New service account">
        <NewServiceAccountForm busy={busy} onSubmit={create} />
      </Sheet>

      <Sheet ref={editSheet} title={editing ? `Edit ${editing.username}` : 'Edit account'}>
        {editing ? (
          <EditServiceAccountForm
            key={editing.id}
            account={editing}
            isSelf={editing.id === meId}
            busy={busy}
            onSubmit={(patch) => void saveEdit(editing, patch)}
          />
        ) : null}
      </Sheet>

      <Sheet ref={tokenSheet} title="New API token">
        {tokenFor ? (
          <NewServiceTokenForm
            key={tokenFor.id}
            account={tokenFor}
            busy={busy}
            onSubmit={(name) => createToken(tokenFor, name)}
          />
        ) : null}
      </Sheet>

      <Sheet ref={revealSheet} title={reveal?.title} onDismiss={() => setReveal(null)}>
        {reveal ? (
          <View style={{ gap: spacing.md }}>
            <AppText variant="meta" color={colors.textMuted}>
              {reveal.message}
            </AppText>
            <SecretReveal value={reveal.secret} />
            <AdminButton label="Done" onPress={() => revealSheet.current?.dismiss()} />
          </View>
        ) : null}
      </Sheet>

      <TypedConfirm
        ref={deleteSheet}
        title="Delete service account"
        message={`This deletes ${deleting?.username ?? 'this account'} and every token under it. Apps using those tokens stop working right away. This can't be undone.`}
        confirmText={deleting?.username ?? ''}
        confirmLabel="Delete account"
        onConfirm={() => {
          if (deleting) remove(deleting)
        }}
      />
    </>
  )
}

export default function ServiceAccountsScreen() {
  return (
    <AdminGate>
      <ServiceAccounts />
    </AdminGate>
  )
}
