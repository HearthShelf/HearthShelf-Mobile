/**
 * On-device crash breadcrumb logger.
 *
 * Why this exists: the crashes we're chasing are NATIVE aborts (a JSI
 * `isObject()` assertion inside libworklets.so kills the whole process). No JS
 * runs during a native abort, so the app can't POST a report mid-crash. Instead
 * we do what native crash reporters do under the hood:
 *
 *   1. Continuously append breadcrumbs to a file on disk as the app runs.
 *   2. Write a "running" sentinel at boot and clear it on a clean shutdown.
 *   3. On the NEXT launch, if the sentinel is still set, the last run died
 *      unexpectedly - flush the saved breadcrumb trail to the backend.
 *
 * This captures the JS trail leading up to the crash from every tester with no
 * PC and no third-party SDK. It does NOT capture the symbolicated native stack
 * (that needs a native signal handler); the breadcrumb trail is usually enough
 * to identify which value/worklet went wrong.
 *
 * Storage is a bounded ring: we keep only the last MAX_CRUMBS lines so the file
 * can't grow without bound, and the serialized report is capped well under the
 * collector's 8000-char detail limit.
 */
import { Paths, File } from 'expo-file-system'

/** Max breadcrumbs retained in the in-memory ring (oldest dropped past this). */
const MAX_CRUMBS = 120
/** Hard cap on a single breadcrumb's text, so one huge log can't dominate. */
const CRUMB_MAX = 300
/** Cap on the serialized breadcrumb blob sent upstream (collector caps at 8000). */
const REPORT_CRUMBS_MAX_CHARS = 6000

interface Crumb {
  /** ms since epoch */
  t: number
  /** 'log' | 'warn' | 'error' | free-form tag */
  tag: string
  msg: string
}

/** The persisted run state: breadcrumbs plus whether the run is still open. */
interface RunState {
  /** Set true at boot, false on clean shutdown. If true at next launch -> crash. */
  running: boolean
  /** ms the run started. */
  startedAt: number
  crumbs: Crumb[]
}

const STATE_FILE = 'crashlog.json'

let state: RunState | null = null
let file: File | null = null
/** Coalesce disk writes: breadcrumbs are frequent, fsync-per-crumb is wasteful. */
let flushTimer: ReturnType<typeof setTimeout> | null = null
/** Prior-run crash report, captured by initCrashLog() at boot and retrieved
 *  later by the UI once a Clerk token is available to authenticate the upload. */
let priorReport: PriorCrashReport | null = null
/** Resolves when initCrashLog() has finished reading the prior state, so a
 *  consumer (takePriorCrashReport) can await it rather than race the async read. */
let initResolve: (() => void) | null = null
const initDone: Promise<void> = new Promise((res) => {
  initResolve = res
})

function getFile(): File {
  if (!file) file = new File(Paths.document, STATE_FILE)
  return file
}

/** Read the persisted state from the previous run, if any. Never throws.
 *  `text()` is async on SDK 57, so this is async; it's only awaited once at init. */
async function readPersisted(): Promise<RunState | null> {
  try {
    const f = getFile()
    if (!f.exists) return null
    const raw = await f.text()
    if (!raw) return null
    const parsed = JSON.parse(raw) as RunState
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.crumbs)) return null
    return parsed
  } catch {
    return null
  }
}

/** Persist current state to disk. Best-effort; never throws. */
function writePersisted(): void {
  if (!state) return
  try {
    getFile().write(JSON.stringify(state))
  } catch {
    // Disk full / permissions - logging must never break the app.
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    writePersisted()
  }, 1000)
}

/**
 * The report from the PREVIOUS run if it ended in a crash, else null. Call once
 * early in app startup (before initCrashLog re-arms the sentinel). The returned
 * object is safe to JSON-serialize into a crash report's `detail`.
 */
export interface PriorCrashReport {
  startedAt: number
  /** ms between run start and this launch reading it (rough uptime-before-crash). */
  crumbs: Crumb[]
  /** The last breadcrumb before death - usually the most telling line. */
  lastCrumb: Crumb | null
}

/**
 * Initialize crash logging. Reads any prior run's state, decides whether the
 * last run crashed, then arms a fresh "running" sentinel for this run.
 *
 * Returns the prior crash report if the last run died unexpectedly, so the
 * caller can flush it upstream. Returns null on a clean prior shutdown or first
 * ever launch.
 */
export async function initCrashLog(): Promise<PriorCrashReport | null> {
  const prior = await readPersisted()

  // A prior run that never cleared `running` died unexpectedly (native abort,
  // OOM kill, force-stop mid-run). We surface only genuine unclean exits.
  let report: PriorCrashReport | null = null
  if (prior && prior.running && prior.crumbs.length > 0) {
    const trimmed = capCrumbs(prior.crumbs)
    report = {
      startedAt: prior.startedAt,
      crumbs: trimmed,
      lastCrumb: trimmed.length ? trimmed[trimmed.length - 1] : null,
    }
  }

  // Arm a fresh sentinel for THIS run. Reading the prior state above already
  // completed, so we don't clobber it. Breadcrumbs recorded before init resolves
  // are dropped (state is null) - acceptable, init runs at the top of index.js.
  state = { running: true, startedAt: Date.now(), crumbs: [] }
  writePersisted()

  priorReport = report
  initResolve?.()
  return report
}

/**
 * Retrieve the prior-run crash report captured at boot, consuming it so it is
 * only ever returned once (the caller flushes it upstream). Awaits init so it
 * never races the async read. Returns null if the last run shut down cleanly or
 * the report was already taken.
 */
export async function takePriorCrashReport(): Promise<PriorCrashReport | null> {
  await initDone
  const r = priorReport
  priorReport = null
  return r
}

/** Keep the breadcrumb blob under the upstream detail cap, newest-first priority. */
function capCrumbs(crumbs: Crumb[]): Crumb[] {
  // Take from the end (most recent) until we hit the char budget.
  const out: Crumb[] = []
  let chars = 0
  for (let i = crumbs.length - 1; i >= 0; i--) {
    const c = crumbs[i]
    chars += c.msg.length + 24
    if (chars > REPORT_CRUMBS_MAX_CHARS) break
    out.unshift(c)
  }
  return out
}

/**
 * Record a breadcrumb. Cheap and synchronous; the disk write is coalesced.
 * `tag` groups the crumb (e.g. 'nav', 'player', 'error'); `msg` is free text.
 */
export function breadcrumb(tag: string, msg: string): void {
  if (!state) return
  const crumb: Crumb = {
    t: Date.now(),
    tag: tag.slice(0, 32),
    msg: (msg ?? '').slice(0, CRUMB_MAX),
  }
  state.crumbs.push(crumb)
  if (state.crumbs.length > MAX_CRUMBS) state.crumbs.shift()
  scheduleFlush()
}

/**
 * Mark the current run as cleanly shut down. There is no reliable "app closing"
 * hook on Android for a swipe-away or a native crash, so in practice this is
 * called on backgrounding as a best-effort "we got at least this far cleanly"
 * signal. It is intentionally conservative: we would rather occasionally report
 * a false crash (app was killed while backgrounded) than miss a real one.
 */
export function markCleanShutdown(): void {
  if (!state) return
  state.running = false
  writePersisted()
}

/** Re-arm the sentinel after a clean-shutdown mark (e.g. app returns to fg). */
export function markRunning(): void {
  if (!state) return
  if (!state.running) {
    state.running = true
    writePersisted()
  }
}

/**
 * Install global JS error capture so uncaught JS errors and console.error calls
 * become breadcrumbs before the process potentially dies. Safe to call once at
 * module load. This does NOT prevent crashes or catch native aborts - it only
 * enriches the breadcrumb trail so a JS error immediately preceding a native
 * abort is on disk.
 */
export function installCrashHandler(): void {
  // Capture uncaught JS errors via the RN global handler, then chain to the
  // original so the red-box / default reporting still happens.
  const g = globalThis as unknown as {
    ErrorUtils?: {
      getGlobalHandler?: () => (error: unknown, isFatal?: boolean) => void
      setGlobalHandler?: (h: (error: unknown, isFatal?: boolean) => void) => void
    }
  }
  const eu = g.ErrorUtils
  if (eu?.getGlobalHandler && eu?.setGlobalHandler) {
    const prev = eu.getGlobalHandler()
    eu.setGlobalHandler((error: unknown, isFatal?: boolean) => {
      try {
        const e = error as { message?: string; stack?: string } | undefined
        const head = e?.message || String(error)
        const stack = e?.stack ? ' | ' + e.stack.split('\n').slice(0, 4).join(' ') : ''
        breadcrumb(isFatal ? 'fatal' : 'error', head + stack)
        // Force the trail to disk synchronously - a fatal is about to end the run.
        writePersisted()
      } catch {
        // never let the handler itself throw
      }
      prev?.(error, isFatal)
    })
  }

  // Mirror console.error into breadcrumbs (many RN library warnings of interest
  // land here, and they often precede a worklet crash).
  const origError = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    try {
      breadcrumb('console.error', args.map(safeStr).join(' '))
    } catch {
      // ignore
    }
    origError(...args)
  }
}

function safeStr(v: unknown): string {
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
