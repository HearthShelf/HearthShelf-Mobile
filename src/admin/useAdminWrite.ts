/**
 * Runs an admin write: blocks double taps, reports the outcome in a toast, and
 * reloads whatever the screen shows. It reloads on failure too, because a write
 * that timed out may have worked, and only the server can say.
 */
import { useCallback, useRef, useState } from 'react'
import { adminWriteMessage } from '@/api/admin/errors'
import { showToast } from '@/ui/Toast'

export interface AdminWriteOptions {
  /** Toast on success. Omit when the screen shows the result itself. */
  done?: string
  /** Toast when the server refuses for an unexpected reason. */
  failed: string
  /** Called after the write settles, whether or not it worked. */
  reload?: () => void
}

export function useAdminWrite() {
  const [busy, setBusy] = useState(false)
  const running = useRef(false)

  const run = useCallback(
    async (action: () => Promise<unknown>, options: AdminWriteOptions): Promise<boolean> => {
      if (running.current) return false
      running.current = true
      setBusy(true)
      try {
        await action()
        if (options.done) showToast(options.done)
        return true
      } catch (e) {
        showToast(adminWriteMessage(e, options.failed))
        return false
      } finally {
        running.current = false
        setBusy(false)
        options.reload?.()
      }
    },
    [],
  )

  return { run, busy }
}
