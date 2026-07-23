/**
 * JS side of the native car bridge. Hands the connected ABS server URL + token
 * (and the user's skip-second settings) to the native Android Auto / iOS CarPlay
 * surface, which serves the car browse tree and owns native media controls. Also
 * publishes the phone-computed Discover feed for the car to browse, since the
 * car can't run the TS taste engine itself. No-op on platforms without the
 * module.
 */
import { NativeModules, Platform } from 'react-native'

/** One Discover row handed to the car: a label and its books (id/title/author). */
export interface AutoDiscoverShelf {
  id: string
  label: string
  items: { id: string; title: string; author: string }[]
}

interface HearthShelfAutoNative {
  setSession(serverUrl: string, token: string, skipBackSec: number, skipForwardSec: number): void
  setSkipSeconds(skipBackSec: number, skipForwardSec: number): void
  setDiscover(json: string): void
  setNotePopsEnabled(enabled: boolean): void
  setChapterProgress(enabled: boolean): void
  setSleepShake(enabled: boolean, minutes: number, timerActive: boolean, hapticLevel: string): void
  setSleepBeep(
    enabled: boolean,
    at2min: boolean,
    at1min: boolean,
    atFinal: boolean,
    sound: string,
    volume: number,
    remainingSec: number,
  ): void
  loadCarBook(itemId: string, positionSec: number): void
  clearSession(): void
}

const native: HearthShelfAutoNative | undefined = NativeModules.HearthShelfAuto

export function setAutoSession(
  serverUrl: string,
  token: string,
  skipBackSec: number,
  skipForwardSec: number,
): void {
  if (Platform.OS === 'android' || Platform.OS === 'ios') {
    native?.setSession(serverUrl, token, skipBackSec, skipForwardSec)
  }
}

/**
 * Push the user's skip-second settings to native so the phone notification's
 * rewind/forward buttons honor them (the car session also carries these, but only
 * while a car session is active - the notification is always live during playback).
 * Android only: iOS shares one player + MPRemoteCommandCenter, which already picks
 * up the intervals from setSession.
 */
export function setAutoSkipSeconds(skipBackSec: number, skipForwardSec: number): void {
  if (Platform.OS === 'android') native?.setSkipSeconds(skipBackSec, skipForwardSec)
}

/** Publish the current Discover shelves so the car's Discover tab can browse them. */
export function setAutoDiscover(shelves: AutoDiscoverShelf[]): void {
  if (Platform.OS === 'android' || Platform.OS === 'ios') {
    native?.setDiscover(JSON.stringify({ shelves }))
  }
}

/**
 * Mirror the notePops master on/off into the car service. The Auto service runs
 * headlessly and can't read the RN settings store (AsyncStorage/SQLite), so JS
 * pushes the current value here whenever it changes. See docs/social.md Phase 7.
 */
export function setAutoNotePops(enabled: boolean): void {
  if (Platform.OS === 'android' || Platform.OS === 'ios') native?.setNotePopsEnabled(enabled)
}

/**
 * Mirror the "scrubber scope" setting (chapter vs whole book) into the CarPlay
 * player, so the car/lock-screen progress bar tracks the current chapter or the
 * whole book to match the phone. iOS only: the Android Auto service computes
 * chapter-relative progress from its own chapter-clipped windows.
 */
export function setAutoChapterProgress(chapterScoped: boolean): void {
  if (Platform.OS === 'ios') native?.setChapterProgress(chapterScoped)
}

/**
 * Push the shake-to-extend sleep-timer state to native. Shake detection lives in
 * the phone media service (not JS) so it fires with the screen off / app
 * backgrounded - a JS accelerometer listener is suspended by Android then.
 * `timerActive` is true only while a duration/clock sleep timer is live, so the
 * service subscribes the accelerometer only when a shake could actually add time.
 * Android only: iOS shake-to-extend is unchanged (foreground JS listener).
 */
export function setAutoSleepShake(
  enabled: boolean,
  minutes: number,
  timerActive: boolean,
  hapticLevel: string,
): void {
  // Both platforms now detect the shake natively so it works with the phone
  // locked (iOS suspends the JS DeviceMotion listener when the screen is off).
  if (Platform.OS === 'android' || Platform.OS === 'ios') {
    native?.setSleepShake(enabled, minutes, timerActive, hapticLevel)
  }
}

/**
 * Push the warning-beep settings + the live sleep timer's remaining playback
 * seconds to native, so the phone media service fires the cues itself (screen-off
 * / backgrounded, like shake-to-extend). `remainingSec` is -1 when no
 * duration/clock timer is armed. Android only: the iOS beep runs foreground in JS
 * (see useSleepBeep), since the background media service is Android-only here.
 */
export function setAutoSleepBeep(
  enabled: boolean,
  at2min: boolean,
  at1min: boolean,
  atFinal: boolean,
  sound: string,
  volume: number,
  remainingSec: number,
): void {
  if (Platform.OS === 'android') {
    native?.setSleepBeep(enabled, at2min, at1min, atFinal, sound, volume, remainingSec)
  }
}

/**
 * Load the book the phone is playing into the car player at the given position,
 * on the car-takeover edge. Without this the car connects with an empty player
 * and Android Auto auto-plays the browse tree's first item (the up-next queue
 * head) instead of resuming the current book. Android only: iOS CarPlay shares
 * one player, so there's nothing to hand over.
 */
export function loadAutoCarBook(itemId: string, positionSec: number): void {
  if (Platform.OS === 'android') native?.loadCarBook(itemId, positionSec)
}

export function clearAutoSession(): void {
  if (Platform.OS === 'android' || Platform.OS === 'ios') native?.clearSession()
}
