/**
 * Warning beeps before the sleep timer ends. When enabled, the app plays a gentle
 * cue as the countdown crosses 2 minutes / 1 minute / the final second remaining,
 * so a listener drifting off gets a heads-up before the audio goes quiet.
 *
 * Two implementations, same split as shake-to-extend (see shakeToExtend.ts) - the
 * cue must sound with the screen off / app backgrounded:
 *
 *  - Android: the beep is fired by the native phone media service
 *    (HearthShelfPlayerService) via SoundPool on the media stream, so it mixes
 *    over the book without ducking and works while backgrounded (the JS sleep
 *    tick is suspended then, but the native progress tick keeps running). JS just
 *    pushes the beep settings + the live timer's remaining PLAYBACK seconds; the
 *    service owns the threshold logic and playback.
 *
 *  - iOS / other: no background media service here, so play the cue from JS with
 *    expo-audio, driven by the store's position ticks. iOS keeps the audio session
 *    active during background playback (UIBackgroundModes: audio), and the players
 *    mix rather than interrupt, so the cue plays over the book. Reliable in the
 *    foreground; best-effort while fully backgrounded.
 */
import { useEffect } from 'react'
import { Platform } from 'react-native'
import { getSettingsState, subscribeSettings, type BeepSound } from '@/store/settings'
import { setAutoSleepBeep } from './autoBridge'
import { getState, subscribe } from './store'

/** Remaining playback seconds of the live duration/clock timer, or -1 if none. */
function remainingSec(): number {
  const timer = getState().sleepTimer
  if (timer?.kind === 'duration' || timer?.kind === 'clock') return timer.remainingSec
  return -1
}

/**
 * Mount the sleep-timer beep driver. Call once from a persistent host component
 * (PlayerHost). No-op visible output; it either pushes native prefs (Android) or
 * plays cues via expo-audio (iOS).
 */
export function useSleepBeep(): void {
  useEffect(() => {
    if (Platform.OS === 'android') return mountNativePush()
    return mountExpoAudio()
  }, [])
}

/** Android: push beep settings + remaining seconds to native on every settings or
 *  player-store change. The service reads the toggles live and owns the cue logic. */
function mountNativePush(): () => void {
  const push = () => {
    const s = getSettingsState()
    setAutoSleepBeep(
      s.sleepChime,
      s.sleepBeepAt2min,
      s.sleepBeepAt1min,
      s.sleepBeepFinal,
      s.sleepBeepSound,
      s.sleepBeepVolume,
      remainingSec(),
    )
  }
  push()
  const unsubSettings = subscribeSettings(push)
  const unsubPlayer = subscribe(push)
  return () => {
    unsubSettings()
    unsubPlayer()
    // Disarm on unmount so a stale remaining value can't linger in prefs.
    setAutoSleepBeep(false, false, false, false, getSettingsState().sleepBeepSound, 0, -1)
  }
}

/** The four bundled tones, required so Metro bundles them. */
const BEEP_ASSETS: Record<BeepSound, number> = {
  chime: require('../../assets/beeps/chime.wav'),
  marimba: require('../../assets/beeps/marimba.wav'),
  beep: require('../../assets/beeps/beep.wav'),
  bell: require('../../assets/beeps/bell.wav'),
}

// Lazily-built preview players, shared across previewBeep calls. Kept separate
// from the iOS runtime players so previewing from Settings never touches the live
// sleep-timer cue state.
const previewPlayers = new Map<BeepSound, import('expo-audio').AudioPlayer>()
let previewModeSet = false

/**
 * Play a one-shot preview of a beep tone at a given volume (0-100), for the "test
 * sound" button in Settings. Uses expo-audio on both platforms - the settings
 * screen is always foreground, and previewing needs no book playing (the Android
 * SoundPool lives in the media service, which is only up during playback). Safe
 * to call rapidly; each tap restarts the tone. No-op if expo-audio is unavailable.
 */
export function previewBeep(sound: BeepSound, volume: number): void {
  try {
    const Audio = require('expo-audio') as typeof import('expo-audio')
    if (!previewModeSet) {
      previewModeSet = true
      Audio.setAudioModeAsync({ interruptionMode: 'mixWithOthers', playsInSilentMode: true }).catch(
        () => {},
      )
    }
    let p = previewPlayers.get(sound)
    if (!p) {
      p = Audio.createAudioPlayer(BEEP_ASSETS[sound])
      previewPlayers.set(sound, p)
    }
    p.volume = Math.max(0, Math.min(1, volume / 100))
    p.seekTo(0).catch(() => {})
    p.play()
  } catch {
    // A preview that can't play must never break the settings screen.
  }
}

/** iOS / other: play the cue from JS with expo-audio, driven by store position
 *  ticks. expo-audio is imported lazily so the Android path (and any platform
 *  without it) never loads the native module. */
function mountExpoAudio(): () => void {
  // Lazily required so Android never pulls expo-audio in.
  const Audio = require('expo-audio') as typeof import('expo-audio')

  const players = new Map<BeepSound, import('expo-audio').AudioPlayer>()
  // Per-timer edge state: the remaining seconds at the previous tick, and which
  // thresholds have fired for the current timer (reset when a new timer arms).
  let prevRemaining = -1
  let fired2 = false
  let fired1 = false
  let firedFinal = false

  // Mix the cue over the book rather than interrupt it.
  Audio.setAudioModeAsync({ interruptionMode: 'mixWithOthers', playsInSilentMode: true }).catch(
    () => {},
  )

  const playerFor = (sound: BeepSound) => {
    let p = players.get(sound)
    if (!p) {
      try {
        p = Audio.createAudioPlayer(BEEP_ASSETS[sound])
        players.set(sound, p)
      } catch {
        return null
      }
    }
    return p
  }

  const beep = () => {
    const s = getSettingsState()
    const p = playerFor(s.sleepBeepSound)
    if (!p) return
    try {
      p.volume = Math.max(0, Math.min(1, s.sleepBeepVolume / 100))
      p.seekTo(0).catch(() => {})
      p.play()
    } catch {
      // A cue that fails to play must never break playback.
    }
  }

  const tick = () => {
    const s = getSettingsState()
    const cur = remainingSec()
    // No live timer: reset edge state so the next armed timer starts fresh.
    if (cur < 0) {
      prevRemaining = -1
      fired2 = fired1 = firedFinal = false
      return
    }
    // A new/extended timer (remaining jumped up): re-arm the cues.
    if (prevRemaining < 0 || cur > prevRemaining + 1) {
      fired2 = fired1 = firedFinal = false
    }
    const crossed = (mark: number) => prevRemaining > mark && cur <= mark
    if (s.sleepChime) {
      if (
        !fired2 &&
        s.sleepBeepAt2min &&
        (crossed(120) || (prevRemaining < 0 && cur <= 120 && cur > 60))
      ) {
        fired2 = true
        beep()
      }
      if (
        !fired1 &&
        s.sleepBeepAt1min &&
        (crossed(60) || (prevRemaining < 0 && cur <= 60 && cur > 1))
      ) {
        fired1 = true
        beep()
      }
      if (!firedFinal && s.sleepBeepFinal && cur <= 1) {
        firedFinal = true
        beep()
      }
    }
    prevRemaining = cur
  }

  tick()
  const unsubPlayer = subscribe(tick)
  const unsubSettings = subscribeSettings(tick)

  return () => {
    unsubPlayer()
    unsubSettings()
    for (const p of players.values()) {
      try {
        p.remove()
      } catch {
        // ignore
      }
    }
    players.clear()
  }
}
