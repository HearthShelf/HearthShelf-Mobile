/**
 * Owns "are we connected to an AudiobookShelf server yet?" for the whole app.
 *
 * Runs right after Clerk reports a signed-in user (see app/_layout.tsx). It mints
 * a grant, exchanges it for an ABS token, and stashes the result in the session
 * singleton (src/api/session.ts) that every /api/* helper reads. Until it reaches
 * `ready`, the root gate keeps the hearth splash on screen; on failure the splash
 * turns into an error screen (retry / manage servers / log out).
 *
 * The connect logic here was hoisted out of the Home tab so the splash - not a
 * tab already inside the app - covers the connect + first-load moment.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { useAuth } from '@clerk/expo'
import { fetchLinkedServers, type LinkedServer } from './controlPlane'
import { connectServer } from './connect'
import { setSession, setLastServerId, getLastServerId } from './session'
import { CLERK_JWT_TEMPLATE } from '@/lib/config'
import { setAutoSession } from '@/player/autoBridge'
import { startQueueSync } from '@/player/queueSync'
import { ensureDeviceId } from '@/store/settings'
import type { SplashServer } from '@/ui/SplashScreen'

export type ConnectionStatus =
  | { phase: 'connecting' }
  | { phase: 'select-server'; servers: LinkedServer[] }
  | { phase: 'no-servers' }
  | { phase: 'error'; message: string }
  | { phase: 'ready'; serverName: string }

interface ConnectionValue {
  status: ConnectionStatus
  /** Server the active session is connected to, once ready. */
  serverName: string | null
  /** Re-run the whole connect flow from the top. */
  retry: () => void
  /** Connect to a specific linked server (from the picker). */
  connectTo: (server: SplashServer) => void
}

const Ctx = createContext<ConnectionValue | null>(null)

class NoLinkedServersError extends Error {
  constructor() {
    super('No linked servers on this account')
    this.name = 'NoLinkedServersError'
  }
}

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const { getToken } = useAuth()
  const [status, setStatus] = useState<ConnectionStatus>({ phase: 'connecting' })

  // getToken identity changes across renders; keep a stable wrapper.
  const getTokenRef = useRef(getToken)
  getTokenRef.current = getToken
  const tokenFn = useCallback(async () => {
    try {
      return await getTokenRef.current({ template: CLERK_JWT_TEMPLATE })
    } catch {
      return null
    }
  }, [])

  const connectTo = useCallback(
    async (server: LinkedServer | SplashServer) => {
      setStatus({ phase: 'connecting' })
      try {
        const { serverUrl, token } = await connectServer(tokenFn, server.id, server.url)
        await setSession({ serverUrl, token })
        await setLastServerId(server.id)
        // Ensure the per-install deviceId is loaded before sync starts, so
        // device-scoped settings round-trip on the first pull.
        await ensureDeviceId()
        setAutoSession(serverUrl, token)
        startQueueSync()
        setStatus({ phase: 'ready', serverName: server.name })
      } catch (e) {
        setStatus({ phase: 'error', message: (e as Error).message })
      }
    },
    [tokenFn],
  )

  const connect = useCallback(async () => {
    setStatus({ phase: 'connecting' })
    try {
      const servers = await fetchLinkedServers(tokenFn)
      if (servers.length === 0) throw new NoLinkedServersError()
      if (servers.length === 1) {
        await connectTo(servers[0])
        return
      }
      // Precedence: this device's last-used server, then the account default
      // (set on another device), then show the picker.
      const lastId = await getLastServerId()
      const remembered = lastId ? servers.find((s) => s.id === lastId) : undefined
      const preferred = remembered ?? servers.find((s) => s.isDefault)
      if (preferred) await connectTo(preferred)
      else setStatus({ phase: 'select-server', servers })
    } catch (e) {
      if (e instanceof NoLinkedServersError) setStatus({ phase: 'no-servers' })
      else setStatus({ phase: 'error', message: (e as Error).message })
    }
  }, [connectTo, tokenFn])

  useEffect(() => {
    void connect()
  }, [connect])

  const serverName = status.phase === 'ready' ? status.serverName : null

  return (
    <Ctx.Provider value={{ status, serverName, retry: () => void connect(), connectTo }}>
      {children}
    </Ctx.Provider>
  )
}

export function useConnection(): ConnectionValue {
  const v = useContext(Ctx)
  if (!v) throw new Error('useConnection must be used within a ConnectionProvider')
  return v
}
