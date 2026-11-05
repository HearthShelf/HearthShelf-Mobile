/**
 * Loads one piece of admin data for a screen. Reloads on focus, so returning from
 * a detail screen shows what changed there, and can poll while the screen is in
 * use. Polling stops when the app is backgrounded or the screen loses focus, and
 * also on an answer that will not change by asking again (403, 404).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { getMe } from '@/api/abs'
import { adminErrorKind } from '@/api/admin/errors'

export interface AdminResource<T> {
  data: T | null
  /** True until the first load settles. Polls and reloads leave it false. */
  loading: boolean
  /** The latest load's failure. `data` keeps the last good answer alongside it. */
  error: unknown
  reload: () => void
}

export function useAdminResource<T>(
  load: () => Promise<T>,
  options?: { pollMs?: number },
): AdminResource<T> {
  const pollMs = options?.pollMs
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<unknown>(null)
  const loadRef = useRef(load)
  const latest = useRef(0)
  const stopped = useRef(false)

  useEffect(() => {
    loadRef.current = load
  })

  const reload = useCallback(() => {
    const id = ++latest.current
    stopped.current = false
    loadRef
      .current()
      .then((value) => {
        if (id !== latest.current) return
        setData(value)
        setError(null)
      })
      .catch((e: unknown) => {
        if (id !== latest.current) return
        setError(e)
        const kind = adminErrorKind(e)
        if (kind === 'forbidden' || kind === 'missing') stopped.current = true
        // A 403 may mean this account was demoted. Re-reading it updates the role,
        // which sends AdminGate to its "Admins only" state.
        if (kind === 'forbidden') void getMe().catch(() => {})
      })
      .finally(() => {
        if (id === latest.current) setLoading(false)
      })
  }, [])

  useFocusEffect(
    useCallback(() => {
      reload()
      if (!pollMs) {
        return () => {
          latest.current++
        }
      }
      const tick = () => {
        if (!stopped.current) reload()
      }
      let timer: ReturnType<typeof setInterval> | null = null
      const start = () => {
        timer ??= setInterval(tick, pollMs)
      }
      const stop = () => {
        if (timer) clearInterval(timer)
        timer = null
      }
      if (AppState.currentState === 'active') start()
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          tick()
          start()
        } else {
          stop()
        }
      })
      return () => {
        stop()
        sub.remove()
        latest.current++
      }
    }, [pollMs, reload]),
  )

  return { data, loading, error, reload }
}
