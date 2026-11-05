/** The full-screen state for an admin load that failed, by what went wrong. */
import { adminErrorKind } from '@/api/admin/errors'
import { icons } from '@/ui/icons'
import { EmptyState, ErrorState } from '@/ui/states'

export function AdminUnavailable({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  switch (adminErrorKind(error)) {
    case 'forbidden':
      return (
        <EmptyState
          icon={icons.lock}
          title="Admins only"
          body="Your account can't see this on this server."
        />
      )
    case 'missing':
      return (
        <EmptyState
          icon={icons.notInterested}
          title="Not available here"
          body="This server doesn't have this feature."
        />
      )
    case 'unreachable':
      return (
        <ErrorState message="Server Admin needs a connection to your server." onRetry={onRetry} />
      )
    case 'failed':
      return (
        <ErrorState
          title="Something went wrong"
          message="The server couldn't load this."
          onRetry={onRetry}
        />
      )
  }
}
