/**
 * Startup instrumentation for the "app hangs on the animated loader" bug.
 *
 * The loader can hang with nothing thrown - Clerk's isLoaded never resolving, a
 * connect step stalling without rejecting - so crash reporting sees nothing. This
 * module makes the silent hang observable two ways:
 *
 *   - phase spans: a single Sentry transaction ('app.startup') spanning the whole
 *     launch, with a child span per phase (clerk-load, cached-session-check,
 *     run-connect, connect-to:<step>). A hang shows up as one span that never
 *     ends, so the flame graph points straight at the stuck phase.
 *   - watchdog: if the splash is still covering the screen after WATCHDOG_MS, we
 *     capture a Sentry message tagged with the phase that was in flight, turning
 *     a hang into an actual reported event. This is the piece missing today - a
 *     hang currently produces zero signal.
 *
 * All of it is best-effort and no-ops when Sentry is disabled (empty DSN) or when
 * tracing isn't sampled, so it never itself blocks or breaks startup. This is
 * debugging scaffolding for a bounded window, not a permanent subsystem - it can
 * be pulled once the hang is diagnosed and fixed.
 */
import * as Sentry from '@sentry/react-native'

/** How long the loader may stay up before we treat the launch as stalled and
 *  report it. Longer than the connect timeout (20s) + its one retry so a merely
 *  slow-but-recovering connect doesn't trip it - only a genuine hang does. */
const WATCHDOG_MS = 45000

type SpanHandle = { end: () => void }

let startupSpan: ReturnType<typeof Sentry.startInactiveSpan> | undefined
let watchdogTimer: ReturnType<typeof setTimeout> | undefined
/** Phases started but not yet ended, attached to the watchdog report so a hang
 *  names the step(s) actually stuck. A SET (not a single value) because phases
 *  overlap - clerk-load and cached-session-check run concurrently - and because
 *  a phase that ENDED must stop being blamed. */
const inFlight = new Set<string>()
/** Phases that started at all this launch, in order. A stall is often best
 *  explained by what NEVER started (e.g. no connect:* phase = the connect was
 *  never attempted), which the in-flight set alone can't show. */
const started: string[] = []
let finished = false

/** Begin the startup transaction and arm the hang watchdog. Call once, as early
 *  in the launch as a Sentry client exists. Safe to call when Sentry is off. */
export function beginStartupTrace(): void {
  if (startupSpan || finished) return
  try {
    startupSpan = Sentry.startInactiveSpan({
      name: 'app.startup',
      op: 'app.start',
      forceTransaction: true,
    })
  } catch {
    // tracing disabled / not sampled - spans no-op, watchdog still useful
  }
  watchdogTimer = setTimeout(() => {
    // Still up after WATCHDOG_MS: the loader hung. Report it with the phase that
    // was in flight so the event is actionable on its own.
    try {
      // Report BOTH what is still running and the full ordered list of phases
      // reached. "stuck: (none)" is itself the finding - it means nothing was
      // in flight and the launch was wedged between phases (e.g. waiting on a
      // gate that never fired), which is exactly the failure a single
      // last-phase-started tag hid.
      const stuck = [...inFlight]
      const stuckLabel = stuck.length ? stuck.join(',') : '(none)'
      Sentry.captureMessage(`startup stalled; in-flight: ${stuckLabel}`, {
        level: 'error',
        tags: {
          startup_stalled: 'true',
          startup_stuck_phases: stuckLabel,
          startup_last_started: started[started.length - 1] ?? '(none)',
        },
        extra: {
          inFlight: stuck,
          phasesStarted: started,
        },
      })
    } catch {
      // never let the watchdog itself throw during startup
    }
  }, WATCHDOG_MS)
}

/**
 * Open a child span for one startup phase. Returns a handle whose end() closes
 * it. Records the phase as in-flight for the watchdog. A hang inside the phase
 * leaves the span open (visible in the trace) and the phase named (visible on
 * the watchdog report). No-ops after the trace has finished.
 */
export function startPhase(name: string): SpanHandle {
  if (finished) return { end: () => {} }
  // Track in-flight phases as a SET, not a single global. `currentPhase` used to
  // be overwritten by every startPhase() and never restored on end(), so the
  // watchdog reported the last phase STARTED rather than one still running. That
  // actively misled a real investigation: a stalled launch was reported as
  // `cached-session-check` (a 42ms SecureStore read that had already completed),
  // when the truth was that no connect phase had started at all.
  inFlight.add(name)
  started.push(name)
  let span: ReturnType<typeof Sentry.startInactiveSpan> | undefined
  try {
    span = Sentry.startInactiveSpan({ name, op: 'startup.phase' })
  } catch {
    // tracing off - phase still tracked for the watchdog via inFlight
  }
  let ended = false
  return {
    end: () => {
      if (ended) return
      ended = true
      inFlight.delete(name)
      try {
        span?.end()
      } catch {
        // ignore
      }
    },
  }
}

/** Run an async phase with a span around it, ending the span on both success and
 *  failure. Rethrows so callers keep their own error handling. */
export async function tracePhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const phase = startPhase(name)
  try {
    return await fn()
  } finally {
    phase.end()
  }
}

/** The launch reached a terminal state (ready / offline / error / signed-out).
 *  Close the transaction, disarm the watchdog, and mark done so late callers
 *  no-op. Pass the outcome so the trace records how the launch ended. */
export function finishStartupTrace(outcome: string): void {
  if (finished) return
  finished = true
  inFlight.clear()
  if (watchdogTimer) {
    clearTimeout(watchdogTimer)
    watchdogTimer = undefined
  }
  try {
    startupSpan?.setAttribute('outcome', outcome)
    startupSpan?.end()
  } catch {
    // ignore
  }
  startupSpan = undefined
}
