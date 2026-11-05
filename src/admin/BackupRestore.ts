/**
 * Tracks a restore from the tap until the server is back.
 *
 * A restore outlasts any screen: the connection can cover the app, the admin can leave
 * Backups, and the app can be killed. So this runs at module level, mounted once at the
 * root by BackupRestoreWatcher, and a saved marker resumes it after a relaunch. What the
 * admin sees always comes from asking the server, never from a timer.
 *
 * Neither server really restarts: each swaps its database and reopens it. The request
 * answers when that is done, so that answer is the only proof a restore worked. Without
 * it, HearthShelf can at least say whether a restore is still running. Audiobookshelf
 * can't, so its restore never settles while the request is open, and a lost answer ends
 * in "we can't tell", never in "it worked".
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { AppState } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import type { HsRestoreResult } from '@hearthshelf/core'
import { ABSRequestError } from '@/api/abs'
import {
  askServerAfterRestore,
  clearBackupFiles,
  PartialRestoreError,
  type RestoreKind,
  type TransferOptions,
} from '@/api/admin/backups'
import { useConnection } from '@/api/ConnectionProvider'
import { currentServerId, getSession } from '@/api/session'
import { useAuthResolved } from '@/auth/useAuthResolved'
import { showToast } from '@/ui/Toast'

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
  /** The server being restored. Nothing another server says counts for this restore. */
  serverId: string | null
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
  serverId: null,
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
/** When the server got the whole request, so a slow upload doesn't count as a slow restore. */
let waitingSince = 0
let requestOpen = false
/** Still true after the admin stops waiting: a 401 can make the upload go out again. */
let requestsInFlight = 0
/** The app died mid-upload, so unless the server says otherwise it never got the file. */
let uploadDied = false
let requestMayBeDead = false
let goodAnswers = 0
let checking = false
let reconnectAsked = false
let reconnect: (() => void) | null = null
let abortUpload: AbortController | null = null
let markerRead = false
let viewers = 0
let pollTimer: ReturnType<typeof setInterval> | null = null

export function getRestoreState(): RestoreState {
  return state
}

function isWaiting(): boolean {
  return state.phase === 'restarting' || state.phase === 'reconnecting'
}

function syncPolling(): void {
  if (isWaiting() && AppState.currentState === 'active') {
    pollTimer ??= setInterval(() => void checkServer(), POLL_MS)
  } else if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function update(patch: Partial<RestoreState>): void {
  state = { ...state, ...patch }
  listeners.forEach((listener) => listener())
  syncPolling()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

AppState.addEventListener('change', (next) => {
  if (next === 'background') requestMayBeDead = true
  syncPolling()
  if (next === 'active') void checkServer()
})

function saveMarker(kind: RestoreKind, serverId: string | null, uploaded: boolean): Promise<void> {
  const marker = { kind, startedAt, serverId, uploaded }
  return AsyncStorage.setItem(MARKER_KEY, JSON.stringify(marker)).catch(() => undefined)
}

function clearMarker(): void {
  void AsyncStorage.removeItem(MARKER_KEY).catch(() => undefined)
}

function beginWaiting(patch: Partial<RestoreState>): void {
  run += 1
  goodAnswers = 0
  reconnectAsked = false
  waitingSince = Date.now()
  state = IDLE
  update(patch)
}

/** Leaves the file alone while a request might still need it. */
export function clearIdleBackupFiles(): void {
  if (requestsInFlight === 0) clearBackupFiles()
}

function partialFailure(kind: RestoreKind): string {
  return kind === 'hs'
    ? 'The restore stopped partway, so your HearthShelf data may be mixed up. Your old data is in a pre-restore folder on the server.'
    : 'The restore stopped partway, so part of your data was replaced. Check your server before you use it. If HearthShelf data was moved, the old copy is in a pre-restore folder on the server.'
}

/** The server looked at the request and said no, so nothing was replaced. A proxy's 5xx
 *  only says the answer got lost, and a 401 might be the restore replacing our account. */
function serverRefused(e: unknown): boolean {
  if (!(e instanceof ABSRequestError)) return false
  return e.status !== 401 && e.status !== 408 && e.status < 502
}

function settle(patch: Partial<RestoreState>, toast: string): void {
  clearMarker()
  update(patch)
  if (viewers === 0) showToast(toast)
}

type RestoreRequest = (transfer: TransferOptions) => Promise<HsRestoreResult | unknown>

export async function startRestore(kind: RestoreKind, request: RestoreRequest): Promise<void> {
  if (state.phase !== 'idle') return
  startedAt = Date.now()
  requestOpen = true
  requestMayBeDead = false
  uploadDied = false
  requestsInFlight += 1
  const uploads = kind === 'archive'
  const serverId = currentServerId()
  beginWaiting({ kind, serverId, phase: uploads ? 'uploading' : 'restarting' })
  const thisRun = run
  const controller = new AbortController()
  abortUpload = uploads ? controller : null
  await saveMarker(kind, serverId, !uploads)

  try {
    const result = await request({
      signal: controller.signal,
      onProgress: (fraction) => {
        if (thisRun !== run || getRestoreState().phase !== 'uploading' || fraction === null) return
        if (fraction >= 1) {
          abortUpload = null
          waitingSince = Date.now()
          void saveMarker(kind, serverId, true)
          update({ phase: 'restarting', uploaded: 1 })
        } else if (fraction - getRestoreState().uploaded >= 0.01) {
          update({ uploaded: fraction })
        }
      },
    })
    if (thisRun !== run) return
    requestOpen = false
    abortUpload = null
    const crossServer = Boolean((result as HsRestoreResult | undefined)?.crossServer)
    const { phase } = getRestoreState()
    update({ phase: phase === 'uploading' ? 'restarting' : phase, crossServer })
  } catch (e) {
    if (thisRun !== run) return
    requestOpen = false
    abortUpload = null
    if (controller.signal.aborted) return dismissRestore()
    if (e instanceof PartialRestoreError) {
      settle({ phase: 'failed', failure: partialFailure(kind) }, 'The restore failed.')
      return
    }
    const failure = serverRefused(e)
      ? 'The server turned that restore down, so your data was not replaced.'
      : getRestoreState().phase === 'uploading'
        ? "The upload stopped before it finished, so your data wasn't replaced."
        : null
    if (failure) {
      settle({ phase: 'failed', failure }, 'The restore failed.')
      return
    }
    update({ lostContact: true })
  } finally {
    requestsInFlight -= 1
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
  abortUpload?.abort()
  abortUpload = null
  clearMarker()
  state = IDLE
  update({})
}

async function checkServer(): Promise<void> {
  const { kind, serverId } = state
  if (!isWaiting() || !kind) return

  const slow = Date.now() - waitingSince > SLOW_AFTER_MS
  if (slow !== state.slow) update({ slow })
  if (currentServerId() !== serverId) return
  if (requestOpen && !requestMayBeDead && !slow) return
  if (checking) return

  checking = true
  const thisRun = run
  const answer = await askServerAfterRestore(kind).catch(() => 'down' as const)
  checking = false
  // The admin may have switched away while that was in flight, so it may not be ours.
  if (thisRun !== run || currentServerId() !== serverId) return

  const answering = answer === 'up' || answer === 'up-unconfirmed'
  if (answering && !(answer === 'up-unconfirmed' && requestOpen)) {
    goodAnswers += 1
    const noResult = state.lostContact || requestOpen
    if (goodAnswers < (noResult ? ANSWERS_NEEDED_WITHOUT_RESULT : 1)) {
      update({ phase: 'restarting' })
    } else if (uploadDied && answer === 'up') {
      settle(
        { phase: 'failed', failure: "The restore didn't finish sending, so nothing changed." },
        'The restore failed.',
      )
    } else {
      settle({ phase: 'finished', lostContact: noResult, slow: false }, 'Your server is back.')
    }
    return
  }
  goodAnswers = 0
  if (answer === 'restoring') uploadDied = false
  if (answer === 'token-lost') {
    // adminRequest's refresh already failed. The restore replaced the accounts, so
    // this needs the full connect flow, which also owns the error screen if it fails.
    update({ phase: 'reconnecting' })
    if (!reconnectAsked) {
      reconnectAsked = true
      reconnect?.()
    }
    return
  }
  update({ phase: 'restarting' })
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
  let marker: {
    kind: RestoreKind
    startedAt: number
    serverId: string | null
    uploaded?: boolean
  }
  try {
    marker = JSON.parse(saved) as typeof marker
  } catch {
    clearMarker()
    return
  }
  if (Date.now() - marker.startedAt > MARKER_MAX_AGE_MS) {
    clearMarker()
    return
  }
  startedAt = marker.startedAt
  requestOpen = false
  uploadDied = marker.uploaded === false
  beginWaiting({
    kind: marker.kind,
    serverId: marker.serverId,
    phase: 'restarting',
    lostContact: true,
  })
  void checkServer()
}

/** Mounted once at the app root, so recovery and cleanup run wherever the admin is. */
export function BackupRestoreWatcher(): null {
  const { retry } = useConnection()
  const { isLoaded, isSignedIn } = useAuthResolved()
  const wasSignedIn = useRef(false)

  useEffect(() => {
    reconnect = retry
    return () => {
      reconnect = null
    }
  }, [retry])

  useEffect(() => {
    clearBackupFiles()
    void resumeFromMarker()
  }, [])

  // Every sign-out path clears the session first. Checking it means a brief gap in
  // the auth state can't cancel a restore that is still uploading.
  useEffect(() => {
    if (!isLoaded) return
    if (wasSignedIn.current && !isSignedIn && !getSession()) {
      dismissRestore()
      clearBackupFiles()
    }
    wasSignedIn.current = isSignedIn
  }, [isLoaded, isSignedIn])

  return null
}

/** The current restore, for a screen that shows it. */
export function useBackupRestore(): RestoreState {
  useEffect(() => {
    viewers += 1
    return () => {
      viewers -= 1
    }
  }, [])
  return useSyncExternalStore(subscribe, getRestoreState)
}
