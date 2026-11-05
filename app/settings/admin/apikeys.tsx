/** API keys: see who holds one, make a new one, and revoke one. */
import { useMemo, useRef, useState } from 'react'
import { FlatList, Pressable, View } from 'react-native'
import { BottomSheetFlatList } from '@gorhom/bottom-sheet'
import {
  API_KEY_EXPIRY_OPTIONS,
  apiKeyOwnerName,
  fmtSessDate,
  isServiceAccount,
  type ABSAdminUser,
  type ABSApiKey,
} from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminCard } from '@/admin/AdminCard'
import { AdminField } from '@/admin/AdminField'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { HttpWarning } from '@/admin/HttpWarning'
import { SecretReveal } from '@/admin/SecretReveal'
import { StatusPill } from '@/admin/StatusPill'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import {
  createApiKey,
  deleteApiKey,
  getApiKeys,
  getKeyOwners,
  isProtectedKey,
} from '@/api/admin/apikeys'
import { getServerRuntime } from '@/api/admin/server'
import { tagServiceAccount } from '@/api/admin/serviceAccounts'
import { getServiceAccountIds } from '@/api/admin/users'
import { getMeId, getMeType } from '@/api/me'
import { confirm } from '@/ui/confirm'
import { Icon } from '@/ui/icons'
import { AppText, IconButton, Sheet, type SheetRef } from '@/ui/primitives'
import { ChannelChips, SettingsGroup, SettingsRow, SettingsToggle } from '@/ui/settingsControls'
import { EmptyState, SkeletonRow } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'
import { showToast } from '@/ui/Toast'
import { useContentInset } from '@/ui/useContentInset'

export default function ApiKeysScreen() {
  return (
    <AdminGate>
      <ApiKeys />
    </AdminGate>
  )
}

/** ABS sends these dates as ISO strings, whatever the shared type says. */
function timeOf(value: string | number): number {
  return new Date(value).getTime()
}

function keyDates(key: ABSApiKey): string {
  const made = `Made ${fmtSessDate(timeOf(key.createdAt)).day}`
  const used = key.lastUsedAt
    ? `Last used ${fmtSessDate(timeOf(key.lastUsedAt)).day}`
    : 'Never used'
  return `${made} · ${used}`
}

function keyStatus(key: ABSApiKey): { label: string; tone: 'good' | 'bad' | 'neutral' } {
  if (key.expiresAt && timeOf(key.expiresAt) < Date.now()) return { label: 'Expired', tone: 'bad' }
  return key.isActive ? { label: 'Active', tone: 'good' } : { label: 'Inactive', tone: 'neutral' }
}

function ApiKeys() {
  const colors = useColors()
  const bottomInset = useContentInset()
  const { run, busy } = useAdminWrite()

  const keys = useAdminResource(getApiKeys)
  const owners = useAdminResource(getKeyOwners)
  const tagged = useAdminResource(getServiceAccountIds)
  const runtime = useAdminResource(getServerRuntime)

  const serviceUserIds = useMemo(() => tagged.data ?? new Set<string>(), [tagged.data])
  const serviceUsername = runtime.data?.serviceUsername ?? null
  const users = useMemo(() => {
    const isRoot = getMeType() === 'root'
    // ABS refuses a key for the root user unless root is asking.
    return (owners.data ?? []).filter((u) => u.type !== 'guest' && (isRoot || u.type !== 'root'))
  }, [owners.data])
  const userById = useMemo(() => new Map((owners.data ?? []).map((u) => [u.id, u])), [owners.data])

  // Tagged ids alone miss the server's own service root, which is only known by
  // its username, so the two checks have to run together.
  const isServiceOwned = (key: ABSApiKey) =>
    isServiceAccount(
      { id: key.userId, username: apiKeyOwnerName(key, userById) },
      serviceUserIds,
      serviceUsername,
    )

  const allKeys = keys.data ?? []
  const [showService, setShowService] = useState(false)
  const hiddenCount = allKeys.filter(isServiceOwned).length
  const shownKeys = showService ? allKeys : allKeys.filter((k) => !isServiceOwned(k))

  const createSheet = useRef<SheetRef>(null)
  const ownerSheet = useRef<SheetRef>(null)
  const [name, setName] = useState('')
  const [ownerId, setOwnerId] = useState('')
  const [expiryIndex, setExpiryIndex] = useState(0)
  const [asService, setAsService] = useState(false)
  const [token, setToken] = useState<string | null>(null)

  const owner = users.find((u) => u.id === ownerId)
  const ownerIsService = owner ? isServiceAccount(owner, serviceUserIds, serviceUsername) : false

  function ownerLabel(user: ABSAdminUser): string {
    const you = user.id === getMeId() ? ' (you)' : ''
    if (isServiceAccount(user, serviceUserIds, serviceUsername)) {
      return `${user.username}${you} - service account`
    }
    const role = user.type === 'root' || user.type === 'admin' ? ` - ${user.type}` : ''
    return `${user.username}${you}${role}`
  }

  function openCreate() {
    setName('')
    setOwnerId(users.some((u) => u.id === getMeId()) ? getMeId() : '')
    setExpiryIndex(0)
    setAsService(false)
    setToken(null)
    createSheet.current?.present()
  }

  async function create() {
    const created: { key?: ABSApiKey } = {}
    const ok = await run(
      async () => {
        created.key = await createApiKey(
          name.trim(),
          ownerId,
          API_KEY_EXPIRY_OPTIONS[expiryIndex]?.seconds ?? null,
        )
      },
      { failed: "Couldn't create the key.", reload: keys.reload },
    )
    if (!ok) return
    // The token can't be fetched again, so a failed tag must not get in its way.
    if (asService && !ownerIsService) {
      await run(() => tagServiceAccount(ownerId), {
        failed: "The key was made, but it isn't marked as a service account.",
        reload: tagged.reload,
      })
    }
    const secret = created.key?.apiKey
    if (secret) {
      setToken(secret)
    } else {
      createSheet.current?.dismiss()
      showToast("The server didn't return the new key. Revoke it and make another.")
    }
  }

  async function revoke(key: ABSApiKey) {
    const yes = await confirm({
      title: 'Revoke this key?',
      message: `This revokes "${key.name}". Anything using this key stops working right away. You can't undo this.`,
      confirmLabel: 'Revoke key',
    })
    if (!yes) return
    await run(() => deleteApiKey(key.id), {
      done: `Revoked ${key.name}`,
      failed: "Couldn't revoke that key.",
      reload: keys.reload,
    })
  }

  if (keys.error && !keys.data) return <AdminUnavailable error={keys.error} onRetry={keys.reload} />

  return (
    <View style={{ flex: 1 }}>
      {keys.loading ? (
        <View style={{ padding: spacing.lg, gap: spacing.sm }}>
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </View>
      ) : (
        <FlatList
          data={shownKeys}
          keyExtractor={(key) => key.id}
          contentContainerStyle={{
            padding: spacing.lg,
            paddingBottom: bottomInset,
            gap: spacing.md,
          }}
          ListHeaderComponent={
            <View style={{ gap: spacing.md }}>
              <AdminButton
                label="New key"
                icon="add"
                disabled={users.length === 0}
                onPress={openCreate}
              />
              {owners.error && !owners.data ? (
                <AppText variant="meta" color={colors.textMuted}>
                  Couldn't load the user list, so you can't make a key right now.
                </AppText>
              ) : null}
              {hiddenCount > 0 ? (
                <SettingsGroup>
                  <SettingsRow
                    title="Show service account keys"
                    desc={showService ? undefined : `${hiddenCount} hidden`}
                    control={<SettingsToggle on={showService} onChange={setShowService} />}
                    last
                  />
                </SettingsGroup>
              ) : null}
            </View>
          }
          ListEmptyComponent={
            <EmptyState
              icon="key"
              title="No keys here"
              body="Make a key so a script or another app can use this server."
            />
          }
          renderItem={({ item }) => {
            const status = keyStatus(item)
            const isProtected = isProtectedKey(item)
            return (
              <AdminCard
                title={item.name}
                subtitle={apiKeyOwnerName(item, userById)}
                status={status.label}
                statusTone={status.tone}
              >
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.md,
                    marginTop: spacing.sm,
                  }}
                >
                  <AppText variant="caption" color={colors.textMuted} style={{ flex: 1 }}>
                    {isProtected
                      ? `${keyDates(item)}. HearthShelf needs this key to connect people, so it can't be revoked here.`
                      : keyDates(item)}
                  </AppText>
                  {isProtected ? null : (
                    <IconButton
                      name="delete"
                      size={22}
                      color={colors.textMuted}
                      accessibilityLabel={`Revoke ${item.name}`}
                      onPress={() => void revoke(item)}
                    />
                  )}
                </View>
              </AdminCard>
            )
          }}
        />
      )}

      <Sheet
        ref={createSheet}
        title={token ? 'Key created' : 'New API key'}
        onDismiss={() => setToken(null)}
      >
        {token ? (
          <View style={{ gap: spacing.md }}>
            <SecretReveal value={token} label="Copy key" />
            <AdminButton label="Done" onPress={() => createSheet.current?.dismiss()} />
          </View>
        ) : (
          <View style={{ gap: spacing.md }}>
            <HttpWarning />
            <AdminField
              inSheet
              label="Key name"
              placeholder="My script"
              autoCapitalize="sentences"
              value={name}
              onChangeText={setName}
            />
            <SettingsGroup>
              <SettingsRow
                title="User"
                desc={owner ? ownerLabel(owner) : 'Choose who this key acts as'}
                onPress={() => ownerSheet.current?.present()}
              />
              <SettingsRow
                title="Service account"
                desc={
                  ownerIsService
                    ? 'This user is already one.'
                    : 'Group this user with machine logins.'
                }
                control={
                  ownerIsService ? (
                    <StatusPill label="On" />
                  ) : (
                    <SettingsToggle on={asService} onChange={setAsService} />
                  )
                }
                last
              />
            </SettingsGroup>
            <View style={{ gap: spacing.xs }}>
              <AppText variant="label">Expires</AppText>
              <ChannelChips
                options={API_KEY_EXPIRY_OPTIONS.map((o, i) => ({ id: String(i), label: o.label }))}
                selected={{ [String(expiryIndex)]: true }}
                onToggle={(id) => setExpiryIndex(Number(id))}
              />
            </View>
            <AdminButton
              label="Create key"
              icon="key"
              busy={busy}
              disabled={!name.trim() || !owner}
              onPress={() => void create()}
            />
          </View>
        )}
      </Sheet>

      <Sheet ref={ownerSheet} title="Choose a user" stackBehavior="push" snapPoints={['60%']}>
        <BottomSheetFlatList
          data={users}
          keyExtractor={(user: ABSAdminUser) => user.id}
          renderItem={({ item }: { item: ABSAdminUser }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: item.id === ownerId }}
              onPress={() => {
                setOwnerId(item.id)
                ownerSheet.current?.dismiss()
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.sm,
                paddingVertical: spacing.md,
              }}
            >
              <AppText variant="body" style={{ flex: 1 }}>
                {ownerLabel(item)}
              </AppText>
              {item.id === ownerId ? <Icon name="check" size={20} color={colors.accent} /> : null}
            </Pressable>
          )}
        />
      </Sheet>
    </View>
  )
}
