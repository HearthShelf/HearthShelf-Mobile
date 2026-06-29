/**
 * JS side of the native Android Auto bridge. Hands the connected ABS server URL
 * + token to the native HearthShelfAutoService (which serves the car browse tree
 * and plays audio in its own process). No-op on platforms without the module.
 */
import { NativeModules, Platform } from 'react-native'

interface HearthShelfAutoNative {
  setSession(serverUrl: string, token: string): void
  clearSession(): void
}

const native: HearthShelfAutoNative | undefined = NativeModules.HearthShelfAuto

export function setAutoSession(serverUrl: string, token: string): void {
  if (Platform.OS === 'android') native?.setSession(serverUrl, token)
}

export function clearAutoSession(): void {
  if (Platform.OS === 'android') native?.clearSession()
}
