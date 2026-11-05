/**
 * Tracks a restore from the tap until the server is back.
 *
 * It lives outside the screen because a restore outlasts it: the connection can cover
 * the app, AdminGate can remount, and the admin can leave. A saved marker also carries
 * it across the app being killed. What the admin sees always comes from asking the
 * server, never from a timer.
 *
 * Neither server really restarts: each swaps its database and reopens it. The request
 * answers when that is done, so while it is open there is nothing better to ask. Once
 * it settles, or the app has been in the background (which can silently kill it), the
 * server is polled instead.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { HsRestoreResult } from '@hearthshelf/core'
import { ABSRequestError } from '@/api/abs'
import {
  askServerAfterRestore,
  isAbort,
  type RestoreKind,
  type TransferOptions,
} from '@/api/admin/backups'
import { useConnection } from '@/api/ConnectionProvider'
import { currentServerId } from '@/api/session'

const POLL_MS = 3000
const SLOW_AFTER_MS = 3 * 60_000
/** A marker older than this is a restore that finished long ago, not one to wait for. */
const MARKER_MAX_AGE_MS = 60 * 60_000
const MARKER_KEY = 'admin.backupRestore'
/** Without the server's own answer, one good reply could be a gap mid-restore. */
const ANSWERS_NEEDED_WITHOUT_RESULT = 3

export interface RestoreState {
  phase: 'idle' | 'uploading' | 'restarting' | 'reconnecting' | 'finished' | 'failed'
  kind: RestoreKind | null
  /** Upload progress, 0 to 1. */
  uploaded: number
  /** The server's answer to the restore never reached us, so we can't say it worked. */
  lostContact: boolean
  crossServer: boolean
  /** Waiting longer than a restore should take. */
  slow: boolean
  failure: string | null
}

const IDLE: RestoreState = {
  phase: 'idle',
  kind: null,
  uploaded: 0,
  lostContact: false,
  crossServer: false,
  slow: false,
  failure: null,
}

let state = IDLE
const listeners = new Set<() => void>()

let run = 0
let startedAt = 0
let requestOpen = false
let requestMayBeDead = false
let goodAnswers = 0
let checking = false
let reconnectAsked = false
let reconnect: (() => void) | null = null
let abortUpload: AbortController | null = null
let markerRead = false

function update(patch: Partial<RestoreState>): void {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getRestoreState(): RestoreState {
  return state
}

function saveMarker(kind: RestoreKind): Promise<void> {
  const marker = { kind, startedAt, serverId: currentServerId() }
  return AsyncStorage.setItem(MARKER_KEY, JSON.stringify(marker)).catch(() => undefined)
}

function clearMarker(): void {
  void AsyncStorage.removeItem(MARKER_KEY).catch(() => undefined)
}

function beginWaiting(kind: RestoreKind, patch: Partial<RestoreState>): void {
  run += 1
  goodAnswers = 0
  reconnectAsked = false
  update({ ...IDLE, kind, ...patch })
}

/** The server looked at the request and said no, so nothing was replaced. A proxy's 5xx
 *  only says the answer got lost, and a 401 might be the restore replacing our account. */
function serverRefused(e: unknown): boolean {
  if (!(e instanceof ABSRequestError)) return false
  return e.status !== 401 && e.status !== 408 && e.status < 502
}

type RestoreRequest = (transfer: TransferOptions) => Promise<HsRestoreResult | unknown>

export async function startRestore(kind: RestoreKind, request: RestoreRequest): Promise<void> {
  if (state.phase !== 'idle') return
  startedAt = Date.now()
  requestOpen = true
  requestMayBeDead = false
  const uploads = kind === 'archive'
  beginWaiting(kind, { phase: uploads ? 'uploading' : 'restarting' })
  const thisRun = run
  const controller = new AbortController()
  abortUpload = uploads ? controller : null
  await saveMarker(kind)

  try {
    const result = await request({
      signal: controller.signal,
      onProgress: (fraction) => {
        if (thisRun !== run || getRestoreState().phase !== 'uploading' || fraction === null) return
        if (fraction >= 1) {
          abortUpload = null
          update({ phase: 'restarting', uploaded: 1 })
        } else if (fraction - state.uploaded >= 0.01) {
          update({ uploaded: fraction })
        }
      },
    })
    if (thisRun !== run) return
    requestOpen = false
    abortUpload = null
    const crossServer = Boolean((result as HsRestoreResult | undefined)?.crossServer)
    update({
      phase: getRestoreState().phase === 'uploading' ? 'restarting' : getRestoreState().phase,
      crossServer,
    })
  } catch (e) {
    if (thisRun !== run) return
    requestOpen = false
    abortUpload = null
    if (isAbort(e)) return dismissRestore()
    const failure = serverRefused(e)
      ? 'The server turned that restore down, so your data was not replaced.'
      : getRestoreState().phase === 'uploading'
        ? "The upload stopped before it finished, so your data wasn't replaced."
        : null
    if (failure) {
      clearMarker()
      update({ phase: 'failed', failure })
      return
    }
    update({ lostContact: true })
  }
  void checkServer()
}

/** Only while the file is still going up. After that the server is already at work. */
export function cancelRestoreUpload(): void {
  abortUpload?.abort()
}

export function dismissRestore(): void {
  run += 1
  requestOpen = false
  abortUpload = null
  clearMarker()
  update(IDLE)
}

async function checkServer(): Promise<void> {
  const waiting = state.phase === 'restarting' || state.phase === 'reconnecting'
  if (checking || !waiting || !state.kind) return
  if (requestOpen && !requestMayBeDead) return

  checking = true
  const thisRun = run
  const answer = await askServerAfterRestore(state.kind).catch(() => 'down' as const)
  checking = false
  if (thisRun !== run) return

  const slow = Date.now() - startedAt > SLOW_AFTER_MS
  if (answer === 'up') {
    goodAnswers += 1
    const noResult = state.lostContact || requestOpen
    if (goodAnswers >= (noResult ? ANSWERS_NEEDED_WITHOUT_RESULT : 1)) {
      clearMarker()
      update({ phase: 'finished', lostContact: noResult, slow: false })
    } else {
      update({ phase: 'restarting', slow })
    }
    return
  }
  goodAnswers = 0
  if (answer === 'token-lost') {
    // adminRequest's refresh already failed. The restore replaced the accounts, so
    // this needs the full connect flow, which also owns the error screen if it fails.
    update({ phase: 'reconnecting', slow })
    if (!reconnectAsked) {
      reconnectAsked = true
      reconnect?.()
    }
    return
  }
  update({ phase: 'restarting', slow })
}

/** Asks again now, and lets a token problem try the connect flow once more. */
export function checkRestoreNow(): void {
  reconnectAsked = false
  void checkServer()
}

async function resumeFromMarker(): Promise<void> {
  if (markerRead) return
  markerRead = true
  const saved = await AsyncStorage.getItem(MARKER_KEY).catch(() => null)
  if (!saved || state.phase !== 'idle') return
  let marker: { kind: RestoreKind; startedAt: number; serverId: string | null }
  try {
    marker = JSON.parse(saved) as typeof marker
  } catch {
    clearMarker()
    return
  }
  if (Date.now() - marker.startedAt > MARKER_MAX_AGE_MS || marker.serverId !== currentServerId()) {
    clearMarker()
    return
  }
  startedAt = marker.startedAt
  requestOpen = false
  beginWaiting(marker.kind, { phase: 'restarting', lostContact: true })
}

/** The current restore, polling the server for as long as a screen shows it. */
export function useBackupRestore(): RestoreState {
  const { retry } = useConnection()
  const current = useSyncExternalStore(subscribe, getRestoreState)
  const waiting = current.phase === 'restarting' || current.phase === 'reconnecting'

  useEffect(() => {
    reconnect = retry
    return () => {
      reconnect = null
    }
  }, [retry])

  useEffect(() => {
    void resumeFromMarker()
  }, [])

  useEffect(() => {
    if (!waiting) return
    let timer: ReturnType<typeof setInterval> | null = null
    const start = () => {
      timer ??= setInterval(() => void checkServer(), POLL_MS)
    }
    const stop = () => {
      if (timer) clearInterval(timer)
      timer = null
    }
    void checkServer()
    if (AppState.currentState === 'active') start()
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') requestMayBeDead = true
      if (next === 'active') {
        void checkServer()
        start()
      } else {
        stop()
      }
    })
    return () => {
      stop()
      subscription.remove()
    }
  }, [waiting])

  return current
}
