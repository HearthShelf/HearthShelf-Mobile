/**
 * fetch() with a hard per-request timeout via AbortController. Plain fetch on
 * React Native has no client-side timeout, so a request on a half-open socket -
 * e.g. one opened on Wi-Fi that the OS hasn't torn down after a handoff to
 * cellular - can hang for the OS TCP timeout (30-60s+). That made the launch
 * connect (and its Retry) appear dead: the connect-timeout race would reject in
 * JS while the underlying fetch kept dangling, so each retry re-hung on the same
 * dead route. Aborting the request frees the socket and lets a retry get a fresh
 * one.
 *
 * Transport failures are re-thrown as ConnectionError so callers (and the UI)
 * get a real reason - "Can't find that server address" vs "Server took too long"
 * - instead of an opaque TypeError.
 */
import { classifyFetchError } from './connectionError'

/** Default per-request timeout for connect/auth calls, in ms. Kept below the
 *  overall connect race (see CONNECT_TIMEOUT_MS in ConnectionProvider) so a
 *  single hung hop aborts and can be retried within the outer window. */
export const DEFAULT_FETCH_TIMEOUT_MS = 10000

export async function fetchWithTimeout(
  input: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (e) {
    // Classify at the throw site, where we still know whether the abort was OUR
    // timeout or the caller's - downstream all that survives is a TypeError with
    // an opaque message. See connectionError.ts.
    throw classifyFetchError(e, { url: input, aborted: timedOut })
  } finally {
    clearTimeout(timer)
  }
}
