/**
 * What went wrong with an admin call, in terms a screen can act on.
 *
 * The rest of the app swallows backend errors into neutral values so a surface
 * hides. Admin does the opposite: an admin who thinks a user was disabled needs
 * to know it was not.
 */
import { ABSRequestError } from '@/api/abs'

export type AdminErrorKind = 'forbidden' | 'missing' | 'unreachable' | 'failed'

export function adminErrorKind(error: unknown): AdminErrorKind {
  if (error instanceof ABSRequestError) {
    // The /hs admin routes answer 401 to a non-admin. absRequest has already tried a
    // fresh token by the time a 401 gets here, so it means no, not "sign in again".
    if (error.status === 401 || error.status === 403) return 'forbidden'
    if (error.status === 404) return 'missing'
    return 'failed'
  }
  return 'unreachable'
}

/** A refusal the server worded for people ("Username already taken"). ABS sends
 *  plain text, /hs sends JSON. Machine codes and HTML pages are not shown. */
function serverReason(error: unknown): string | null {
  if (!(error instanceof ABSRequestError)) return null
  if (error.status < 400 || error.status >= 500) return null
  let text = error.detail.trim()
  try {
    const body = JSON.parse(text) as { detail?: unknown; message?: unknown; error?: unknown }
    const worded = [body.detail, body.message, body.error].find((v) => typeof v === 'string')
    text = typeof worded === 'string' ? worded.trim() : ''
  } catch {
    // Plain text, which is what ABS sends.
  }
  if (!text || text.length > 200 || !text.includes(' ') || text.includes('<')) return null
  return text
}

/** The message for a failed write. An unreachable server does not mean the write
 *  failed, only that no answer came back, so it must not read as a failure. */
export function adminWriteMessage(error: unknown, failed: string): string {
  switch (adminErrorKind(error)) {
    case 'unreachable':
      return "We couldn't confirm that. Refresh to check."
    case 'forbidden':
      return "Your account can't do that on this server."
    case 'missing':
      return "This server doesn't have that feature, or the item is gone."
    case 'failed':
      return serverReason(error) ?? failed
  }
}
