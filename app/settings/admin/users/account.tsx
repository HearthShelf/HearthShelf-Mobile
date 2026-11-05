/** Edit a username and email. Changing the email of a linked account breaks the
 *  match that links it, so that takes a second, deliberate step. */
import { useState } from 'react'
import { View } from 'react-native'
import { router } from 'expo-router'
import { AdminButton } from '@/admin/AdminButton'
import { AdminField } from '@/admin/AdminField'
import { AdminGate } from '@/admin/AdminGate'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { UserEditLoader } from '@/admin/UserEditLoader'
import { getLinkedAbsUserIds } from '@/api/admin/hosted'
import { updateUser, type AdminUserDetail, type UserPatch } from '@/api/admin/users'
import { AppText, Loading } from '@/ui/primitives'
import { SettingsPanel } from '@/ui/settingsControls'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

export default function EditAccountScreen() {
  return (
    <AdminGate>
      <UserEditLoader>{(detail) => <AccountForm user={detail.user} />}</UserEditLoader>
    </AdminGate>
  )
}

function AccountForm({ user }: { user: AdminUserDetail['user'] }) {
  const colors = useColors()
  const linked = useAdminResource(getLinkedAbsUserIds)
  const { run, busy } = useAdminWrite()
  const [username, setUsername] = useState(user.username)
  const [email, setEmail] = useState(user.email ?? '')
  const [unlocked, setUnlocked] = useState(false)

  if (linked.loading) return <Loading />
  // Unknown counts as linked: the cost is one extra tap, not a broken link.
  const isLinked = linked.data?.has(user.id) ?? true
  const name = username.trim()
  const address = email.trim()
  // ABS ignores a blank email on update, so it would look saved and not be.
  const clearing = Boolean(user.email) && !address

  async function save() {
    const patch: UserPatch = {}
    if (name !== user.username) patch.username = name
    if (address && address !== user.email) patch.email = address
    if (Object.keys(patch).length === 0) {
      router.back()
      return
    }
    const ok = await run(() => updateUser(user.id, patch), {
      done: 'Changes saved',
      failed: "Couldn't save. That username may already be taken.",
    })
    if (ok) router.back()
  }

  return (
    <SettingsPanel>
      <AdminField
        label="Username"
        value={username}
        onChangeText={setUsername}
        placeholder="e.g. listener"
      />
      <AdminField
        label="Email"
        value={email}
        onChangeText={setEmail}
        editable={!isLinked || unlocked}
        keyboardType="email-address"
        placeholder="Optional"
        error={clearing ? 'An email can be changed here, but not removed.' : undefined}
      />
      {isLinked ? (
        <View style={{ gap: spacing.sm }}>
          <AppText variant="meta" color={colors.textMuted}>
            This account is linked to HearthShelf. If you change the email, the link breaks and
            you'll need to invite them again.
          </AppText>
          {unlocked ? null : (
            <AdminButton
              label="Change anyway"
              kind="secondary"
              icon="warning"
              onPress={() => setUnlocked(true)}
            />
          )}
        </View>
      ) : null}
      <AdminButton
        label="Save changes"
        icon="save"
        busy={busy}
        disabled={!name || clearing}
        onPress={() => void save()}
      />
    </SettingsPanel>
  )
}
