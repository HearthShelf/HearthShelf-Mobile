/**
 * Android hardware back-button hook. Registers a handler that runs only while
 * the screen is focused (via useFocusEffect), so pushed routes don't fight the
 * tab roots over the back press. Return `true` from the handler to swallow the
 * press (you handled it); return `false` to let the default (router pop / app
 * exit) proceed.
 *
 * `enabled` lets a screen arm/disarm the handler by state (e.g. only intercept
 * while a search query is active) without re-registering every render.
 *
 * No-op on iOS, which has no hardware back button.
 */
import { useCallback } from 'react'
import { BackHandler, Platform } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { useBottomSheetModal } from '@gorhom/bottom-sheet'

export function useBackHandler(handler: () => boolean, enabled = true): void {
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android' || !enabled) return
      const sub = BackHandler.addEventListener('hardwareBackPress', handler)
      return () => sub.remove()
    }, [handler, enabled]),
  )
}

/**
 * Closes the topmost open bottom sheet on hardware back, one per press, in
 * reverse-open order (LIFO) - so a chain like Queue -> Auto rules closes the
 * sub-sheet first, then the Queue, then falls through to the screen's own back
 * logic once no sheets remain.
 *
 * The bottom-sheet library ships no Android back handling of its own, and a back
 * press would otherwise pop the whole route (dropping out of the player) while a
 * sheet sat open on top of it.
 *
 * Call this AFTER a screen's other `useBackHandler` registrations: BackHandler
 * fires listeners last-registered-first, so registering the sheet handler later
 * makes it run first, ahead of immersive/route-pop logic.
 */
export function useSheetBackHandler(): void {
  const { dismiss } = useBottomSheetModal()
  useBackHandler(
    useCallback(
      // dismiss() returns true when a sheet was open (and closes it), false when
      // none were - which is exactly our swallow/fall-through signal.
      () => dismiss(),
      [dismiss],
    ),
  )
}
