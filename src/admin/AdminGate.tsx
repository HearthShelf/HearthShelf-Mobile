/**
 * Wraps every Server Admin screen. The Settings entry is only a shortcut: this is
 * what keeps a deep link or a demoted account out.
 *
 * `key` remounts the screen when the active server changes, which throws away any
 * form state, so an edit made against one server can never be saved to another.
 */
import { Fragment, useCallback, useEffect, useState } from 'react'
import { getMe } from '@/api/abs'
import { useConnection } from '@/api/ConnectionProvider'
import { getMeType } from '@/api/me'
import { currentServerId } from '@/api/session'
import { Loading } from '@/ui/primitives'
import { EmptyState, ErrorState } from '@/ui/states'
import { icons } from '@/ui/icons'

export function AdminGate({
  children,
  fresh = false,
}: {
  children: React.ReactNode
  /** Re-read the account type on open. The admin home sets this, so a demotion is
   *  noticed at the door. Inner screens rely on it, and on a 403 from their data. */
  fresh?: boolean
}) {
  const { activeRole } = useConnection()
  const serverId = currentServerId()
  const [check, setCheck] = useState<'checking' | 'done' | 'failed'>('checking')

  const runCheck = useCallback(() => {
    setCheck('checking')
    getMe()
      .then(() => setCheck('done'))
      .catch(() => setCheck('failed'))
  }, [])

  useEffect(() => {
    if (fresh || !getMeType()) runCheck()
    else setCheck('done')
  }, [fresh, runCheck, serverId])

  if (activeRole === 'admin') return <Fragment key={serverId ?? ''}>{children}</Fragment>
  if (check === 'checking') return <Loading label="Checking your access" />
  if (check === 'failed') {
    return (
      <ErrorState message="Server Admin needs a connection to your server." onRetry={runCheck} />
    )
  }
  return (
    <EmptyState
      icon={icons.lock}
      title="Admins only"
      body="You need an admin account on this server to manage it."
    />
  )
}
