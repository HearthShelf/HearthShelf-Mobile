/**
 * The app's view of "who is signed in", in the shape screens actually want.
 *
 * `useSession()` returns `{ data, isPending }`, but almost every screen wants
 * the same three things - is auth settled, is someone signed in, and who are
 * they. This wraps that once so screens don't each re-derive it (and drift in
 * how they treat the pending state).
 *
 * `user.id` is the stable account id: the `sub` of every grant the control
 * plane mints, and the per-user primary key on every self-hosted server. For
 * accounts carried over from the previous identity provider it is that
 * provider's original id, seeded on purpose - so it is emphatically NOT
 * opaque-and-regenerable.
 */
import { useCallback } from 'react'
import { authClient } from './client'
import { signOutOfGoogleNatively } from './native'
import { clearCachedSession } from './sessionCache'
import { useAuthResolved } from './useAuthResolved'

export interface AuthUser {
  id: string
  email: string
  /** Full display name, when the account has one. */
  name: string
  /** Display username, when the account has one set. */
  username?: string
  /** Profile photo URL from the sign-in provider, when there is one. */
  imageUrl?: string
  /** Account creation time, for "member since". */
  createdAt?: Date

  // Aliases matching the previous provider's user shape, so the screens that
  // render a name/email did not all need rewriting for a field rename. They are
  // derived, never separate state.
  /** Alias of `name`. */
  fullName: string
  /** First word of `name`, for greetings. Empty when there is no name. */
  firstName: string
  /** Shaped like the old provider's nested email, which several screens read. */
  primaryEmailAddress: { emailAddress: string } | null
}

export function useAuth(): {
  /** False while the session is still resolving. */
  isLoaded: boolean
  /** True once a session is confirmed. */
  isSignedIn: boolean
  user: AuthUser | null
  signOut: () => Promise<void>
} {
  // isLoaded is sticky once auth has answered - see useAuthResolved for why a
  // plain `!isPending` blinks.
  const { session, isLoaded, isSignedIn } = useAuthResolved()

  // Clearing the stored session locally as well as calling the service: sign-out
  // has to work when the service is unreachable, or a user on a dead network is
  // stuck signed in with no way out but reinstalling.
  const signOut = useCallback(async () => {
    try {
      await authClient.signOut()
    } finally {
      // Also end the OS-level Google session, or the next sign-in silently
      // re-uses this account and never offers the picker. See
      // signOutOfGoogleNatively.
      await signOutOfGoogleNatively()
      await clearCachedSession()
    }
  }, [])

  const raw = session?.user
  const name = raw?.name ?? ''
  const email = raw?.email ?? ''
  const user: AuthUser | null = raw
    ? {
        id: raw.id,
        email,
        name,
        username: (raw as { username?: string }).username ?? undefined,
        imageUrl: raw.image ?? undefined,
        createdAt: raw.createdAt ? new Date(raw.createdAt) : undefined,
        fullName: name,
        firstName: name.split(' ')[0] ?? '',
        primaryEmailAddress: email ? { emailAddress: email } : null,
      }
    : null

  return { isLoaded, isSignedIn, user, signOut }
}
