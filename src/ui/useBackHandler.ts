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

export function useBackHandler(handler: () => boolean, enabled = true): void {
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== 'android' || !enabled) return
      const sub = BackHandler.addEventListener('hardwareBackPress', handler)
      return () => sub.remove()
    }, [handler, enabled]),
  )
}
