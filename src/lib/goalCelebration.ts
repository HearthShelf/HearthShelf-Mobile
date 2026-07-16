/**
 * Decides whether to fire the yearly reading-goal celebration on app open.
 *
 * The rule: the user has a goal set, they've finished at least that many books
 * this year, and we haven't already celebrated *this goal number*. That last
 * clause is what makes it reset when the goal changes - the flag stores the goal
 * value we celebrated, so raising the goal (5 -> 10) re-arms the celebration for
 * the new target, and lowering it below what's already done fires immediately too.
 *
 * `booksThisYear` is server-computed (getHSStats), so the check runs after the
 * connection is ready. It's device-local: each device celebrates once per goal
 * value, which is the right feel (the confetti should greet you on the phone you
 * open, not be "used up" by another device).
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { getHSStats } from '@/api/abs'
import { getSettingsState, setSetting } from '@/store/settings'
import { celebrateGoal } from '@/ui/GoalCelebration'

// Stores the goal number we last celebrated (as a string). Absent => never.
const CELEBRATED_KEY = 'hs.goalCelebratedFor'

async function readCelebratedGoal(): Promise<number | null> {
  try {
    const raw = await AsyncStorage.getItem(CELEBRATED_KEY)
    if (raw == null) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

async function writeCelebratedGoal(goal: number): Promise<void> {
  try {
    await AsyncStorage.setItem(CELEBRATED_KEY, String(goal))
  } catch {
    // Storage unavailable - worst case the user sees the celebration again next
    // launch, which is harmless.
  }
}

// Guards against the launch check racing itself (e.g. a foreground re-check while
// the first stats fetch is still in flight).
let checking = false

/**
 * Run the app-open goal check. Fetches stats, and if the goal is newly reached,
 * fires the celebration and records the goal number so it won't re-fire until the
 * goal changes. Safe to call whenever the app becomes connected; it self-gates.
 */
export async function checkGoalCelebration(): Promise<void> {
  if (checking) return
  checking = true
  try {
    const goal = getSettingsState().yearlyBookGoal
    if (!goal || goal <= 0) return

    const celebrated = await readCelebratedGoal()
    // Already celebrated this exact goal - nothing to do until it changes.
    if (celebrated === goal) return

    const stats = await getHSStats()
    const done = stats.booksThisYear
    if (done == null || done < goal) return

    // Record first so a crash mid-celebration doesn't loop it on next launch.
    await writeCelebratedGoal(goal)
    celebrateGoal({
      goal,
      done,
      onRaise: (nextGoal) => setSetting('yearlyBookGoal', nextGoal),
    })
  } catch {
    // A stats fetch failure just means no celebration this open; try again later.
  } finally {
    checking = false
  }
}

/**
 * Fire the celebration immediately with the user's real numbers, for testing from
 * the diagnostics screen. Falls back to sample numbers if stats aren't available,
 * and never touches the celebrated-goal flag so it can be triggered repeatedly.
 */
export async function testGoalCelebration(): Promise<void> {
  const goal = getSettingsState().yearlyBookGoal || 12
  let done = goal
  try {
    const stats = await getHSStats()
    if (stats.booksThisYear != null) done = Math.max(stats.booksThisYear, goal)
  } catch {
    // Ignore - use the fallback numbers.
  }
  celebrateGoal({
    goal,
    done,
    onRaise: (nextGoal) => setSetting('yearlyBookGoal', nextGoal),
  })
}
