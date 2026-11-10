/**
 * True while the app is running in offline mode: the launch connect could not
 * reach the server, and only downloaded books are usable. Screens that need the
 * server use this to show an honest offline state instead of a spinner that
 * never resolves or an action that silently does nothing.
 */
import { useConnection } from './ConnectionProvider'

export function useIsOffline(): boolean {
  return useConnection().status.phase === 'offline'
}
