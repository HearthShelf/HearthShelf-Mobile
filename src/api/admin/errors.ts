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
    if (error.status === 403) return 'forbidden'
    if (error.status === 404) return 'missing'
    return 'failed'
  }
  return 'unreachable'
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
      return failed
  }
}
