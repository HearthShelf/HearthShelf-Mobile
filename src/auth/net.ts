/**
 * Network limits for calls to the auth service from the account screens.
 *
 * The auth client's fetch has no timeout of its own, so on a dead or half-open
 * network (ship Wi-Fi, a captive portal) a call can hang for a minute or more
 * with its button stuck busy. Each settings-screen call passes AUTH_FETCH so it
 * gives up in a bounded time.
 *
 * The auth client returns HTTP failures as `{ error }` and only THROWS when the
 * request never got an answer (no network, or our timeout aborted it). So a
 * thrown value here means "could not reach the service", which is what
 * authErrorText says in plain words instead of "Network request failed" or
 * "Aborted".
 */

export const AUTH_TIMEOUT_MS = 15000

/** Pass as `fetchOptions` on an auth client call, or spread into `$fetch` options. */
export const AUTH_FETCH = { timeout: AUTH_TIMEOUT_MS } as const

export const AUTH_UNREACHABLE =
  "Can't reach HearthShelf right now. Check your connection and try again."

/** Marks a call that never got an answer, so callers can tell it from a refusal. */
export class AuthUnreachableError extends Error {
  readonly original: unknown

  constructor(original?: unknown) {
    super(AUTH_UNREACHABLE)
    this.name = 'AuthUnreachableError'
    this.original = original
  }
}

/** Run an auth client request, turning a transport failure into AuthUnreachableError. */
export async function reachAuth<T>(request: Promise<T>): Promise<T> {
  try {
    return await request
  } catch (e) {
    throw new AuthUnreachableError(e)
  }
}

/** Toast text for a thrown auth call. */
export function authErrorText(e: unknown, fallback: string): string {
  if (e instanceof AuthUnreachableError) return AUTH_UNREACHABLE
  return (e as Error)?.message || fallback
}
