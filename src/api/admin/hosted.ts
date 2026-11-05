/**
 * The server's HearthShelf connection, as far as people are concerned: is it
 * connected, who has been invited, and removing or recovering accounts.
 */
import {
  HS_ENDPOINTS,
  type HSHostedConfigStatus,
  type HSHostedRecoverAdminsResponse,
  type HostedLinkedUsersResponse,
  type InviteResult,
  type PendingInvite,
  type RemoveUserResult,
} from '@hearthshelf/core'
import { ABSRequestError, adminRequest } from '@/api/abs'
import { ApiError, mintGrant } from '@/api/controlPlane'
import { currentServerId } from '@/api/session'
import { getSessionToken } from '@/auth/token'

// These wait on the control plane and on email, and a timed-out write can only
// be reported as "we couldn't confirm that".
const FORWARDED_TIMEOUT_MS = 30000

export function getHostedStatus(): Promise<HSHostedConfigStatus> {
  return adminRequest<HSHostedConfigStatus>(HS_ENDPOINTS.hostedConfig)
}

/** Invite someone by email. Inviting the same email again mints a new code and
 *  retires the old one, so this is also how an invite is resent. */
export function inviteFromServer(email: string, role: 'admin' | 'user'): Promise<InviteResult> {
  return adminRequest<InviteResult>(
    HS_ENDPOINTS.hostedInvite,
    { method: 'POST', body: JSON.stringify({ email, role }) },
    { timeoutMs: FORWARDED_TIMEOUT_MS },
  )
}

export async function getPendingInvites(): Promise<PendingInvite[]> {
  const res = await adminRequest<{ invites?: PendingInvite[] }>(
    HS_ENDPOINTS.hostedInvites,
    undefined,
    { timeoutMs: FORWARDED_TIMEOUT_MS },
  )
  return res.invites ?? []
}

export interface InviteState {
  paired: boolean
  invites: PendingInvite[]
}

/** Listing invites fails on a server that isn't connected, so ask that first. */
export async function getInviteState(): Promise<InviteState> {
  const { paired } = await getHostedStatus()
  return { paired, invites: paired ? await getPendingInvites() : [] }
}

export function revokeInvite(inviteId: string): Promise<{ ok: boolean }> {
  return adminRequest<{ ok: boolean }>(
    HS_ENDPOINTS.hostedInvitesRevoke,
    { method: 'POST', body: JSON.stringify({ invite_id: inviteId }) },
    { timeoutMs: FORWARDED_TIMEOUT_MS },
  )
}

/** Deletes the account and drops its hosted link, so the person stops seeing this
 *  server and can't be let back in by a new account with the same email. */
export function removeUser(absUserId: string, email: string | null): Promise<RemoveUserResult> {
  return adminRequest<RemoveUserResult>(
    HS_ENDPOINTS.hostedRemoveUser,
    {
      method: 'POST',
      body: JSON.stringify({ abs_user_id: absUserId, email: email ?? undefined }),
    },
    { timeoutMs: FORWARDED_TIMEOUT_MS },
  )
}

/** The accounts that have signed in through HearthShelf on this server. */
export async function getLinkedAbsUserIds(): Promise<Set<string>> {
  const res = await adminRequest<HostedLinkedUsersResponse>(HS_ENDPOINTS.hostedLinkedUsers)
  return new Set((res.linked ?? []).map((l) => l.absUserId))
}

/**
 * Re-enables every disabled admin on this server. The server trusts a fresh
 * control-plane grant here rather than the ABS token, since there may be no working
 * admin login left, and it only accepts one from a server admin link.
 */
export async function recoverAdmins(): Promise<HSHostedRecoverAdminsResponse> {
  const serverId = currentServerId()
  if (!serverId) throw new Error('recover_no_server')
  let grant: string
  try {
    ;({ grant } = await mintGrant(getSessionToken, serverId))
  } catch (e) {
    // Report a refusal as one, so the screen doesn't call it a lost connection.
    if (e instanceof ApiError) throw new ABSRequestError(e.status, HS_ENDPOINTS.hostedRecoverAdmins)
    throw e
  }
  return adminRequest<HSHostedRecoverAdminsResponse>(
    HS_ENDPOINTS.hostedRecoverAdmins,
    { method: 'POST', body: JSON.stringify({ grant }) },
    { timeoutMs: FORWARDED_TIMEOUT_MS },
  )
}
