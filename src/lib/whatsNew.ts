/**
 * "What's new" chip visibility - the small amount of state behind the Home
 * header chip.
 *
 * The rule: after the app's version changes, the chip appears for the next two
 * cold launches, then retires itself. Two is enough to catch someone who opened
 * the app, got pulled away, and came back - without the chip becoming permanent
 * furniture. Opening the sheet retires it immediately, since at that point it
 * has done its job.
 *
 * Deliberately NOT a modal on launch: an update dialog you didn't ask for is an
 * interruption. The notes stay reachable forever from Settings > About.
 *
 * All storage is best-effort. Every failure path resolves to "don't show the
 * chip" rather than throwing - release notes are never worth a broken Home.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { FULL_VERSION } from '@/lib/config'

/** Version whose notes the chip is currently advertising. */
const VERSION_KEY = 'hs.whatsNew.version'
/** Cold launches counted against that version. */
const LAUNCHES_KEY = 'hs.whatsNew.launches'

/** How many cold launches the chip survives after a version change. */
export const CHIP_LAUNCH_BUDGET = 2

/**
 * Count this launch and report whether the chip should show.
 *
 * Call once per cold start. On the first run after an update the stored version
 * no longer matches the running build, so the counter resets and the chip is
 * armed; each later launch spends one of its two showings.
 *
 * A fresh install counts as an update - a first-time user seeing "What's New"
 * once is a reasonable introduction to where the notes live, and there is no
 * prior version to compare against anyway.
 */
export async function registerLaunch(): Promise<boolean> {
  if (!FULL_VERSION) return false
  try {
    const [storedVersion, storedLaunches] = await Promise.all([
      AsyncStorage.getItem(VERSION_KEY),
      AsyncStorage.getItem(LAUNCHES_KEY),
    ])

    if (storedVersion !== FULL_VERSION) {
      // New build (or first install): arm the chip and spend launch one.
      await AsyncStorage.multiSet([
        [VERSION_KEY, FULL_VERSION],
        [LAUNCHES_KEY, '1'],
      ])
      return true
    }

    // A missing or corrupt counter means we can't prove the budget is unspent,
    // so treat it as spent rather than risk a chip that re-arms forever. Note
    // the null check must come first: Number(null) is 0, which is finite and
    // would read as "no launches used yet".
    if (storedLaunches === null) return false
    const spent = Number(storedLaunches)
    if (!Number.isFinite(spent)) return false
    if (spent >= CHIP_LAUNCH_BUDGET) return false

    await AsyncStorage.setItem(LAUNCHES_KEY, String(spent + 1))
    return true
  } catch {
    return false
  }
}

/** Retire the chip for this version - called when the user opens the sheet. */
export async function dismissChip(): Promise<void> {
  try {
    await AsyncStorage.multiSet([
      [VERSION_KEY, FULL_VERSION],
      [LAUNCHES_KEY, String(CHIP_LAUNCH_BUDGET)],
    ])
  } catch {
    // Worst case the chip shows once more. Not worth surfacing.
  }
}
