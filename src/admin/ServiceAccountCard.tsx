/** One service account, with its actions and, when open, its API tokens. */
import { Pressable, View } from 'react-native'
import { fmtSessDate, type ABSAdminUser, type ABSApiKey } from '@hearthshelf/core'
import { canRevokeKey, isProtectedKey } from '@/api/admin/apikeys'
import { Icon } from '@/ui/icons'
import { AppText } from '@/ui/primitives'
import { SkeletonRow } from '@/ui/states'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'
import { AdminButton } from './AdminButton'
import { AdminCard } from './AdminCard'
import { StatusPill } from './StatusPill'

function dayLabel(when: string | number | null): string {
  return when ? fmtSessDate(new Date(when).getTime()).day : 'never'
}

interface ServiceTokensState {
  keys: ABSApiKey[] | null
  loading: boolean
  onRetry: () => void
}

function TokenList({
  account,
  tokens,
  canCreate,
  callerType,
  onNew,
  onRevoke,
}: {
  account: ABSAdminUser
  tokens: ServiceTokensState
  canCreate: boolean
  callerType: string
  onNew: () => void
  onRevoke: (key: ABSApiKey) => void
}) {
  const colors = useColors()
  const keys = tokens.keys?.filter((k) => k.userId === account.id)
  return (
    <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
      {canCreate ? (
        <AdminButton label="New token" icon="add" kind="secondary" onPress={onNew} />
      ) : (
        <AppText variant="meta" color={colors.textMuted}>
          This is a root account. Only a root user can make tokens for it.
        </AppText>
      )}
      {tokens.loading ? <SkeletonRow /> : null}
      {!tokens.loading && !keys ? (
        <AdminButton
          label="Couldn't load tokens. Try again"
          icon="refresh"
          kind="secondary"
          onPress={tokens.onRetry}
        />
      ) : null}
      {keys?.length === 0 ? (
        <AppText variant="meta" color={colors.textMuted}>
          No tokens yet. Make one to let another app sign in as this account.
        </AppText>
      ) : null}
      {keys?.map((key) => (
        <View
          key={key.id}
          style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 44 }}
        >
          <View style={{ flex: 1 }}>
            <AppText variant="body" numberOfLines={1}>
              {key.name}
            </AppText>
            <AppText variant="meta" color={colors.textMuted}>
              Made {dayLabel(key.createdAt)}. Last used {dayLabel(key.lastUsedAt)}.
              {isProtectedKey(key)
                ? " HearthShelf needs this key, so it can't be revoked here."
                : canRevokeKey(key, account.type, callerType)
                  ? ''
                  : ' Only a root user can revoke this key.'}
            </AppText>
          </View>
          <StatusPill
            label={key.isActive ? 'Active' : 'Inactive'}
            tone={key.isActive ? 'good' : 'neutral'}
          />
          {canRevokeKey(key, account.type, callerType) ? (
            <Pressable
              onPress={() => onRevoke(key)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={`Revoke ${key.name}`}
            >
              <Icon name="delete" size={22} color={colors.destructive} />
            </Pressable>
          ) : null}
        </View>
      ))}
    </View>
  )
}

export function ServiceAccountCard({
  account,
  owned,
  open,
  canEdit,
  canCreateTokens,
  callerType,
  canDelete,
  tokens,
  onToggleTokens,
  onEdit,
  onUntag,
  onDelete,
  onNewToken,
  onRevokeToken,
}: {
  account: ABSAdminUser
  /** The box's own auto-created account. */
  owned: boolean
  open: boolean
  canEdit: boolean
  canCreateTokens: boolean
  callerType: string
  canDelete: boolean
  tokens: ServiceTokensState
  onToggleTokens: () => void
  onEdit: () => void
  onUntag: () => void
  onDelete: () => void
  onNewToken: () => void
  onRevokeToken: (key: ABSApiKey) => void
}) {
  const colors = useColors()
  return (
    <AdminCard
      title={account.username}
      subtitle={`${owned ? 'HearthShelf' : 'Service'} account. Last seen ${dayLabel(account.lastSeen)}.`}
      status={account.isActive ? 'Active' : 'Disabled'}
      statusTone={account.isActive ? 'good' : 'neutral'}
    >
      <View
        style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md }}
      >
        <AdminButton
          label={open ? 'Hide tokens' : 'Tokens'}
          icon="key"
          kind="secondary"
          onPress={onToggleTokens}
        />
        {canEdit ? (
          <AdminButton label="Edit" icon="edit" kind="secondary" onPress={onEdit} />
        ) : null}
        {owned ? null : (
          <AdminButton
            label="Move to Users"
            icon="playlist-remove"
            kind="secondary"
            onPress={onUntag}
          />
        )}
        {canDelete ? (
          <AdminButton label="Delete" icon="delete" kind="danger" onPress={onDelete} />
        ) : null}
      </View>
      {owned ? (
        <AppText variant="meta" color={colors.textMuted} style={{ marginTop: spacing.sm }}>
          HearthShelf runs on this account, so it can't be changed here.
        </AppText>
      ) : null}
      {open ? (
        <TokenList
          account={account}
          tokens={tokens}
          canCreate={canCreateTokens}
          callerType={callerType}
          onNew={onNewToken}
          onRevoke={onRevokeToken}
        />
      ) : null}
    </AdminCard>
  )
}
