/** Invite people by email, and manage the invites still waiting. An email can go
 *  missing, so each invite also carries a code the admin can pass on by hand. */
import { useMemo, useState } from 'react'
import { Pressable, View } from 'react-native'
import { router } from 'expo-router'
import * as Clipboard from 'expo-clipboard'
import {
  fmtSessDate,
  inviteMessage,
  inviteUrl,
  type InviteResult,
  type PendingInvite,
} from '@hearthshelf/core'
import { AdminButton } from '@/admin/AdminButton'
import { AdminCard } from '@/admin/AdminCard'
import { AdminField } from '@/admin/AdminField'
import { AdminGate } from '@/admin/AdminGate'
import { AdminUnavailable } from '@/admin/AdminUnavailable'
import { useAdminResource } from '@/admin/useAdminResource'
import { useAdminWrite } from '@/admin/useAdminWrite'
import { getInviteState, inviteFromServer, revokeInvite } from '@/api/admin/hosted'
import { useConnection } from '@/api/ConnectionProvider'
import { WEBAPP_URL } from '@/lib/config'
import { confirm } from '@/ui/confirm'
import { Icon, icons } from '@/ui/icons'
import { AppText } from '@/ui/primitives'
import { Seg, SettingsLabel, SettingsPanel } from '@/ui/settingsControls'
import { EmptyState, SkeletonRow } from '@/ui/states'
import { showToast } from '@/ui/Toast'
import { useColors } from '@/ui/ThemeProvider'
import { spacing } from '@/ui/theme'

type InviteRole = 'admin' | 'user'

const ROLE_OPTIONS: { value: InviteRole; label: string }[] = [
  { value: 'user', label: 'User' },
  { value: 'admin', label: 'Admin' },
]

// A row we know of from the send response, before the list has caught up. It has
// no real id yet, so it can't be canceled.
const UNSAVED_ID_PREFIX = 'pending:'

export default function InviteScreen() {
  return (
    <AdminGate>
      <Invites />
    </AdminGate>
  )
}

async function copy(text: string, done: string) {
  try {
    await Clipboard.setStringAsync(text)
    showToast(done)
  } catch {
    showToast("Couldn't copy that.")
  }
}

/** The send response carries the newest code, which the list may not show yet. */
function mergeSent(invites: PendingInvite[], sent: Map<string, InviteResult>): PendingInvite[] {
  const seen = new Set<string>()
  const rows = invites.map((row) => {
    const key = row.email.toLowerCase()
    seen.add(key)
    const fresh = sent.get(key)
    return fresh ? { ...row, code: fresh.code, role: fresh.role } : row
  })
  const added: PendingInvite[] = []
  for (const [key, r] of sent) {
    if (seen.has(key)) continue
    added.push({
      id: `${UNSAVED_ID_PREFIX}${r.email}`,
      email: r.email,
      role: r.role,
      code: r.code,
      created_at: Date.now(),
      expires_at: null,
    })
  }
  return [...added, ...rows]
}

function Invites() {
  const colors = useColors()
  const { serverName } = useConnection()
  const state = useAdminResource(getInviteState)
  const { run, busy } = useAdminWrite()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<InviteRole>('user')
  const [sent, setSent] = useState<Map<string, InviteResult>>(() => new Map())

  const invites = useMemo(
    () => mergeSent(state.data?.invites ?? [], sent),
    [state.data?.invites, sent],
  )

  if (state.error && !state.data) {
    return <AdminUnavailable error={state.error} onRetry={state.reload} />
  }
  if (state.loading) {
    return (
      <SettingsPanel>
        <SkeletonRow />
        <SkeletonRow />
      </SettingsPanel>
    )
  }
  if (!state.data?.paired) {
    return (
      <EmptyState
        icon={icons.notInterested}
        title="Connect this server first"
        body="Email invites need this server connected to HearthShelf. You can still add someone by hand."
        cta="Add a user"
        onCta={() => router.replace('/settings/admin/users/add')}
      />
    )
  }

  async function send(address: string, inviteRole: InviteRole, resending: boolean) {
    const box: { result?: InviteResult } = {}
    const ok = await run(
      async () => {
        box.result = await inviteFromServer(address, inviteRole)
      },
      {
        failed: resending ? "Couldn't resend that invite." : "Couldn't send that invite.",
        reload: state.reload,
      },
    )
    const result = box.result
    if (!ok || !result) return
    setSent((prev) => new Map(prev).set(result.email.toLowerCase(), result))
    showToast(
      !result.emailed
        ? `Invited ${result.email}, but the email didn't send. Share the code instead.`
        : resending
          ? `Invite resent to ${result.email}. The old code no longer works.`
          : `Invited ${result.email}. Email sent.`,
    )
    if (!resending) setEmail('')
  }

  async function submit() {
    const target = email.trim()
    if (role === 'admin') {
      const ok = await confirm({
        title: 'Invite as admin',
        message: `Invite ${target} as an admin? They'll be able to manage this server.`,
        confirmLabel: 'Invite as admin',
      })
      if (!ok) return
    }
    await send(target, role, false)
  }

  async function resend(invite: PendingInvite) {
    const ok = await confirm({
      title: 'Resend invite',
      message: `Send ${invite.email} a new invite? Their old code stops working.`,
      confirmLabel: 'Resend',
    })
    if (ok) await send(invite.email, invite.role, true)
  }

  async function cancel(invite: PendingInvite) {
    const ok = await confirm({
      title: 'Cancel invite',
      message: `Cancel the invite for ${invite.email}? Their code stops working. You can invite them again later.`,
      confirmLabel: 'Cancel invite',
      cancelLabel: 'Keep it',
    })
    if (!ok) return
    const done = await run(() => revokeInvite(invite.id), {
      done: 'Invite canceled',
      failed: "Couldn't cancel that invite.",
      reload: state.reload,
    })
    if (!done) return
    setSent((prev) => {
      const next = new Map(prev)
      next.delete(invite.email.toLowerCase())
      return next
    })
  }

  return (
    <SettingsPanel>
      <AppText variant="meta" color={colors.textMuted}>
        They'll get an email to make a HearthShelf account. Then this server shows up for them.
      </AppText>
      <AdminField
        label="Email address"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        placeholder="name@email.com"
      />
      <View style={{ gap: spacing.xs }}>
        <AppText variant="label">Role</AppText>
        <Seg fill label="Role" value={role} options={ROLE_OPTIONS} onChange={setRole} />
      </View>
      <AdminButton
        label="Send invite"
        icon="send"
        busy={busy}
        disabled={!email.includes('@')}
        onPress={() => void submit()}
      />

      {invites.length > 0 ? (
        <View style={{ gap: spacing.sm }}>
          <SettingsLabel>Waiting to join</SettingsLabel>
          <AppText variant="meta" color={colors.textMuted}>
            If an email didn't arrive, send them the code however you like.
          </AppText>
          {invites.map((invite) => (
            <AdminCard
              key={invite.id}
              title={invite.email}
              subtitle={`${invite.role} · Invited ${fmtSessDate(invite.created_at).day}`}
            >
              <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
                {invite.code ? (
                  <>
                    <Pressable
                      onPress={() => void copy(invite.code ?? '', 'Code copied')}
                      accessibilityRole="button"
                      accessibilityLabel={`Copy code ${invite.code}`}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}
                    >
                      <AppText variant="mono">{invite.code}</AppText>
                      <Icon name="content-copy" size={18} color={colors.textMuted} />
                    </Pressable>
                    <AppText variant="caption" color={colors.textMuted}>
                      Enter this code in the app, or open {inviteUrl(WEBAPP_URL, invite.code)}
                    </AppText>
                  </>
                ) : null}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                  {invite.code ? (
                    <AdminButton
                      label="Copy message"
                      kind="secondary"
                      icon="ios-share"
                      onPress={() =>
                        void copy(
                          inviteMessage({
                            code: invite.code ?? '',
                            serverName,
                            origin: WEBAPP_URL,
                          }),
                          'Invite message copied',
                        )
                      }
                    />
                  ) : null}
                  <AdminButton
                    label="Resend"
                    kind="secondary"
                    icon="send"
                    disabled={busy}
                    onPress={() => void resend(invite)}
                  />
                  {invite.id.startsWith(UNSAVED_ID_PREFIX) ? null : (
                    <AdminButton
                      label="Cancel"
                      kind="secondary"
                      icon="close"
                      disabled={busy}
                      onPress={() => void cancel(invite)}
                    />
                  )}
                </View>
              </View>
            </AdminCard>
          ))}
        </View>
      ) : null}
    </SettingsPanel>
  )
}
