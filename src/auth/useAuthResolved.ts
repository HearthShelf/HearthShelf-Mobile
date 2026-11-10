/**
 * The one correct reading of "has auth answered yet, and who is signed in".
 *
 * WHY THIS EXISTS AS ITS OWN HOOK. Better Auth's session store sets
 * `isPending: currentValue.data === null` on every session REQUEST, not just
 * the first (see `better-auth/dist/client/query.mjs`, its `onRequest`). For a
 * signed-out user `data` is permanently null, so `isPending` flips back to true
 * on every background refetch. A plain `const isLoaded = !isPending` therefore
 * reports "auth is still loading" again and again, forever.
 *
 * That is what made the sign-in screen blink: the root gate redirects to
 * /sign-in on a resolved signed-out reading, then a refetch flipped isLoaded
 * back to false, so the gate rendered its launch splash over the top, then
 * resolved and redirected again - a loop, several times a second.
 *
 * Three separate places had each written that same `!isPending` line (the root
 * AuthGate, ConnectionProvider, and useAuth), so the bug had to be fixed three
 * times or not at all. It lives here once now.
 *
 * THE RULE: auth answering is a ONE-WAY DOOR. A later refetch can change WHO is
 * signed in - that is what `isSignedIn` is for - but never whether the question
 * has been answered.
 */
import { useRef } from 'react'
import { useSession } from './client'

export interface ResolvedAuth {
  /** True once auth has answered at least once this run. Never returns to false. */
  isLoaded: boolean
  /** True while a session is confirmed. Freely changes across refetches. */
  isSignedIn: boolean
  /** The raw session, for callers that need the user off it. */
  session: ReturnType<typeof useSession>['data']
  /**
   * The last session check failed without the service saying "no session" -
   * a network error, a timeout, or a server error. A signed-out reading in that
   * state is a guess, not an answer: offline, the Expo client only restores its
   * cached session while that copy is unexpired, so a phone that went a week
   * without reaching the auth service (a cruise, say) reads signed out even
   * though its cookie is still on disk. Only a 401 clears the session for real.
   */
  authUnreachable: boolean
}

export function useAuthResolved(): ResolvedAuth {
  const { data: session, isPending, error } = useSession()

  // Keyed on `isPending` having been false at least once, and deliberately NOT
  // on the store's `isRefetching`: that is set on the very FIRST request too, so
  // latching on it would mark auth "answered" while the initial load is still in
  // flight. That would report a returning user as signed out before their
  // session could re-hydrate, and defeat the offline-launch timeout in
  // app/_layout.tsx, which depends on isLoaded staying false until auth has
  // genuinely answered.
  const answered = useRef(false)
  if (!isPending) answered.current = true

  const status = (error as { status?: number } | null)?.status
  const authUnreachable = !session && !!error && status !== 401 && status !== 403

  return { isLoaded: answered.current, isSignedIn: !!session, session, authUnreachable }
}
