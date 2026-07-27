/**
 * Why a connection failed, in words a listener can act on.
 *
 * Connect failures used to reach the UI as opaque strings ("connect_failed:
 * no_token", "connect_stalled") and got regexed into one of two generic lines at
 * render time. That threw away what we actually knew: a typo'd hostname, a
 * server that's down, an expired certificate, and a rejected sign-in are four
 * different problems with four different fixes, and telling them apart is the
 * difference between a user fixing it themselves and filing a bug.
 *
 * So classification happens HERE, at the throw site, where the cause is still
 * known - not downstream in a component guessing from a string.
 *
 * The headline stays plain (6th-grade); the raw detail rides along in `detail`
 * for the "Show details" disclosure and bug reports.
 */

export type ConnectionErrorKind =
  | 'offline' // the device itself has no network
  | 'dns' // hostname doesn't resolve - usually a typo
  | 'refused' // host is there, nothing listening on that port
  | 'timeout' // no answer in time
  | 'tls' // certificate / secure-channel failure
  | 'auth' // 401/403 - the server said no
  | 'server' // 5xx - the server broke
  | 'notFound' // 404 - wrong path/route
  | 'unknown'

/** Plain headline per kind. Keep these short and free of jargon. */
const HEADLINES: Record<ConnectionErrorKind, string> = {
  offline: 'No internet connection.',
  dns: "Can't find that server address.",
  refused: "Server isn't answering on that address.",
  timeout: 'Server took too long to respond.',
  tls: "Couldn't make a secure connection.",
  auth: 'Sign-in was rejected.',
  server: 'The server had an error.',
  notFound: "That address didn't have a HearthShelf server on it.",
  unknown: "We couldn't reach your server.",
}

export class ConnectionError extends Error {
  readonly kind: ConnectionErrorKind
  /** Raw underlying text (status line, native error) for the details row. */
  readonly detail: string
  /** The URL we tried, so a bug report says which hop failed. */
  readonly url?: string
  readonly status?: number

  constructor(
    kind: ConnectionErrorKind,
    opts: { detail?: string; url?: string; status?: number } = {},
  ) {
    // `message` stays the human headline: anything that logs or toasts a raw
    // Error already reads correctly without knowing about this class.
    super(HEADLINES[kind])
    this.name = 'ConnectionError'
    this.kind = kind
    this.detail = opts.detail ?? ''
    this.url = opts.url
    this.status = opts.status
  }

  /** One line for the "Show details" disclosure / a bug report. */
  get details(): string {
    const bits = [
      this.status ? `HTTP ${this.status}` : null,
      this.detail || null,
      this.url ? `at ${this.url}` : null,
    ].filter(Boolean)
    return bits.join(' · ')
  }
}

/**
 * Classify a thrown fetch error. React Native's fetch collapses most transport
 * failures into a TypeError whose message is the only signal, so this is
 * necessarily string matching - but it happens once, here, against the native
 * text rather than against our own re-wrapped strings.
 *
 * `aborted` distinguishes our AbortController timeout from a genuine network
 * drop, which the message alone can't do.
 */
export function classifyFetchError(
  e: unknown,
  opts: { url?: string; aborted?: boolean } = {},
): ConnectionError {
  if (e instanceof ConnectionError) return e

  const raw = e instanceof Error ? e.message : String(e)
  const msg = raw.toLowerCase()
  const base = { detail: raw, url: opts.url }

  if (opts.aborted || msg.includes('aborted') || msg.includes('timeout')) {
    return new ConnectionError('timeout', base)
  }
  // Certificate problems - check before the generic network bucket, since the
  // native text often also contains "network".
  if (
    msg.includes('certificate') ||
    msg.includes('ssl') ||
    msg.includes('tls') ||
    msg.includes('trust')
  ) {
    return new ConnectionError('tls', base)
  }
  if (
    msg.includes('not resolve') ||
    msg.includes('hostname') ||
    msg.includes('nodename') ||
    msg.includes('enotfound') ||
    msg.includes('dns')
  ) {
    return new ConnectionError('dns', base)
  }
  if (msg.includes('refused') || msg.includes('econnrefused')) {
    return new ConnectionError('refused', base)
  }
  // RN's catch-all for "the request didn't reach anything". Genuinely ambiguous
  // between airplane mode and an unreachable host, so the copy stays neutral.
  if (msg.includes('network request failed') || msg.includes('network error')) {
    return new ConnectionError('offline', base)
  }
  return new ConnectionError('unknown', base)
}

/** Classify a non-ok HTTP response. `detail` should be the server's own error
 *  text when it sent one - it's more specific than any status mapping. */
export function classifyHttpStatus(
  status: number,
  opts: { detail?: string; url?: string } = {},
): ConnectionError {
  const kind: ConnectionErrorKind =
    status === 401 || status === 403
      ? 'auth'
      : status === 404
        ? 'notFound'
        : status >= 500
          ? 'server'
          : 'unknown'
  return new ConnectionError(kind, { ...opts, status })
}
