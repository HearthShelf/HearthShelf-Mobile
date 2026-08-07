/**
 * QuestGiver client against the connected server's HearthShelf backend.
 *
 * Like absRmab.ts, these endpoints live under /hs/questgiver/* on the connected
 * server's own origin (the HearthShelf Node backend, NOT the ABS-native /api/*
 * surface) and are reached with the per-user ABS bearer token.
 *
 * The /hs/questgiver/config payload is SHARED: it gates BOTH QuestGiver and the
 * Discover surface (featureEnabled + discoverEnabled). There is no separate
 * /hs/discover/config endpoint.
 *
 * Every call degrades gracefully, and that is what makes the flow shippable
 * without any AI setup: `recommend` falls through to the deterministic
 * `qgHeuristic` on ANY failure, and `config` falls back to "feature ON, AI OFF".
 * A run always produces picks.
 *
 * Run history and feedback mirror to AsyncStorage for offline/instant paint, but
 * the server is the source of truth so history follows the listener across
 * devices (web included).
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  qgHeuristic,
  qgCraftPrompt,
  type QgProfile,
  type QgAnswers,
  type QgCandidate,
  type QgResult,
  type QgRenderedPick,
  type HSQuestGiverConfig,
} from '@hearthshelf/core'
import { getSession } from './session'

export type QgConfig = HSQuestGiverConfig

/** The client display shape for a completed run - intentionally richer than the
 *  loose core round-trip type, and identical to what the web apps persist so a
 *  run made here renders there unchanged. */
export interface QgRun {
  id: string
  label: string
  when: string // human-readable, stamped at save time
  engine: 'ai' | 'heuristic'
  intro: string
  picks: QgRenderedPick[]
}

export interface QgFeedback {
  vote?: 1 | -1
  note?: string
}

// Config fallback: feature ON, AI OFF. Mirrors the web clients - the heuristic
// flow works without the backend, and both surfaces stay visible.
const CONFIG_FALLBACK: QgConfig = {
  featureEnabled: true,
  discoverEnabled: true,
  enabled: false,
  provider: null,
  model: null,
  limit: null,
  remaining: null,
  period: null,
}

async function qgFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const s = getSession()
  if (!s) throw new Error('not_connected')
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${s.token}`)
  headers.set('Accept', 'application/json')
  if (init?.body) headers.set('Content-Type', 'application/json')
  const res = await fetch(`${s.serverUrl}/hs/questgiver${path}`, { ...init, headers })
  if (!res.ok) throw new Error(`qg ${res.status}`)
  return (await res.json()) as T
}

/**
 * The SHARED QuestGiver + Discover config. Returns the feature-on / AI-off
 * fallback on any failure so both surfaces default to enabled and the heuristic
 * flow keeps working.
 */
export async function getQgConfig(): Promise<QgConfig> {
  try {
    const data = await qgFetch<Partial<QgConfig>>('/config')
    return {
      featureEnabled: data.featureEnabled !== false,
      discoverEnabled: data.discoverEnabled !== false,
      enabled: data.enabled === true,
      provider: data.provider ?? null,
      model: data.model ?? null,
      limit: data.limit ?? null,
      remaining: data.remaining ?? null,
      period: data.period ?? null,
    }
  } catch {
    return CONFIG_FALLBACK
  }
}

/**
 * Get a recommendation. Tries the AI backend; on ANY failure (unconfigured,
 * rate-limited, provider error, network, no session) falls back to the local
 * heuristic - deterministic, no backend needed. This is the floor that makes a
 * run always produce results.
 */
export async function qgRecommend(
  profile: QgProfile,
  answers: QgAnswers,
  candidates: QgCandidate[],
): Promise<QgResult & { remaining?: number | null }> {
  try {
    const prompt = qgCraftPrompt(profile, answers, candidates)
    const data = await qgFetch<{
      intro: string
      picks: { id: string; reason: string }[]
      newPicks: { title: string; author: string; genre: string; hours: number; reason: string }[]
      remaining?: number | null
    }>('/recommend', { method: 'POST', body: JSON.stringify({ prompt }) })
    return {
      intro: data.intro,
      picks: data.picks,
      newPicks: data.newPicks ?? [],
      engine: 'ai',
      remaining: data.remaining ?? null,
    }
  } catch {
    return { ...qgHeuristic(profile, answers, candidates), engine: 'heuristic' }
  }
}

// --- Local mirror (run history, feedback) ------------------------------------

const RUNS_KEY = 'hs.qg.runs'
const FEEDBACK_KEY = 'hs.qg.feedback'
const RUN_CAP = 30

// In-memory caches so the screens can render synchronously; hydrated once at
// mount via loadLocalCache().
let runsCache: QgRun[] = []
let feedbackCache: Record<string, QgFeedback> = {}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  void AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => {})
}

/** Hydrate both caches from device storage. Call once before first render. */
export async function loadLocalCache(): Promise<void> {
  runsCache = await readJson<QgRun[]>(RUNS_KEY, [])
  feedbackCache = await readJson<Record<string, QgFeedback>>(FEEDBACK_KEY, {})
}

export function getRuns(): QgRun[] {
  return runsCache
}

export function getFeedback(): Record<string, QgFeedback> {
  return feedbackCache
}

/** Save a run locally, then mirror to the server so it follows the listener to
 *  other devices. Best effort - the local copy already holds it if the backend
 *  is unreachable. */
export function saveRun(run: QgRun): QgRun[] {
  runsCache = [run, ...runsCache].slice(0, RUN_CAP)
  writeJson(RUNS_KEY, runsCache)
  qgFetch('/runs', { method: 'POST', body: JSON.stringify({ run }) }).catch(() => {})
  return runsCache
}

/** Pull server-side run history (cross-device). Falls back to the local cache
 *  when the backend is unreachable. */
export async function fetchServerRuns(): Promise<QgRun[]> {
  try {
    const data = await qgFetch<{ runs: QgRun[] }>('/runs')
    if (Array.isArray(data.runs)) {
      runsCache = data.runs.slice(0, RUN_CAP)
      writeJson(RUNS_KEY, runsCache)
    }
  } catch {
    /* offline - keep the local cache */
  }
  return runsCache
}

export function setFeedback(key: string, fb: QgFeedback): Record<string, QgFeedback> {
  const k = key.toLowerCase()
  feedbackCache = { ...feedbackCache, [k]: { ...feedbackCache[k], ...fb } }
  writeJson(FEEDBACK_KEY, feedbackCache)
  return feedbackCache
}
