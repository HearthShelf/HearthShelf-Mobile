// Synthesize the sleep-timer warning beeps as small mono 16-bit WAV files.
// Four distinct, gentle tones so a listener drifting off gets an unobtrusive
// heads-up before the audio goes quiet. Generated (not recorded) so they stay
// tiny, license-free, and reproducible. Writes chime/marimba/beep/bell.wav here;
// the config plugin copies them to Android res/raw, and the JS/iOS path loads
// them from assets/beeps. Run: node assets/beeps/gen-beeps.js
const fs = require('fs')
const path = require('path')

const RATE = 44100

// Build a 44-byte PCM WAV header for `samples` mono 16-bit frames.
function wavHeader(sampleCount) {
  const byteRate = RATE * 2
  const dataLen = sampleCount * 2
  const buf = Buffer.alloc(44)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataLen, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // fmt chunk size
  buf.writeUInt16LE(1, 20) // PCM
  buf.writeUInt16LE(1, 22) // mono
  buf.writeUInt32LE(RATE, 24)
  buf.writeUInt32LE(byteRate, 28)
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36)
  buf.writeUInt32LE(dataLen, 40)
  return buf
}

// Render a float sample array (-1..1) to a 16-bit WAV buffer, soft-clipped.
function toWav(samples) {
  const header = wavHeader(samples.length)
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) {
    let v = samples[i]
    if (v > 1) v = 1
    if (v < -1) v = -1
    data.writeInt16LE(Math.round(v * 32767 * 0.85), i * 2)
  }
  return Buffer.concat([header, data])
}

// One decaying partial: sine at `freq`, exponential decay with time-constant
// `tau` seconds, starting at `startSec`, amplitude `amp`.
function partial(samples, { freq, amp, tau, startSec = 0, durSec }) {
  const start = Math.floor(startSec * RATE)
  const len = Math.floor(durSec * RATE)
  for (let i = 0; i < len; i++) {
    const idx = start + i
    if (idx >= samples.length) break
    const t = i / RATE
    const env = Math.exp(-t / tau)
    // 4ms raised-cosine attack so onsets never click.
    const attack = t < 0.004 ? 0.5 - 0.5 * Math.cos((Math.PI * t) / 0.004) : 1
    samples[idx] += amp * env * attack * Math.sin(2 * Math.PI * freq * t)
  }
}

function blank(durSec) {
  return new Float32Array(Math.floor(durSec * RATE))
}

// chime: a soft two-note major-third rise (E6 -> G#6), bell-ish, calming.
function chime() {
  const s = blank(1.1)
  partial(s, { freq: 1318.5, amp: 0.5, tau: 0.35, startSec: 0.0, durSec: 0.9 })
  partial(s, { freq: 1318.5 * 2, amp: 0.12, tau: 0.2, startSec: 0.0, durSec: 0.6 })
  partial(s, { freq: 1661.2, amp: 0.5, tau: 0.4, startSec: 0.16, durSec: 0.9 })
  partial(s, { freq: 1661.2 * 2, amp: 0.12, tau: 0.22, startSec: 0.16, durSec: 0.6 })
  return s
}

// marimba: short woody pluck (A5) with a strong inharmonic partial and fast decay.
function marimba() {
  const s = blank(0.55)
  partial(s, { freq: 880, amp: 0.6, tau: 0.14, durSec: 0.5 })
  partial(s, { freq: 880 * 3.9, amp: 0.18, tau: 0.06, durSec: 0.2 }) // bar overtone
  partial(s, { freq: 880 * 2, amp: 0.1, tau: 0.1, durSec: 0.3 })
  return s
}

// beep: two clean, even sine pips (classic timer). C6, twice.
function beep() {
  const s = blank(0.5)
  const pip = { freq: 1046.5, amp: 0.5, tau: 0.08, durSec: 0.14 }
  partial(s, { ...pip, startSec: 0.0 })
  partial(s, { ...pip, startSec: 0.22 })
  return s
}

// bell: rich, longer bell with a fundamental + a few tuned partials, slow decay.
function bell() {
  const s = blank(1.8)
  const f = 987.8 // B5
  partial(s, { freq: f * 0.5, amp: 0.28, tau: 0.9, durSec: 1.8 }) // hum tone
  partial(s, { freq: f, amp: 0.5, tau: 0.8, durSec: 1.7 })
  partial(s, { freq: f * 2.0, amp: 0.22, tau: 0.5, durSec: 1.2 })
  partial(s, { freq: f * 2.4, amp: 0.16, tau: 0.35, durSec: 0.9 }) // minor-third partial
  partial(s, { freq: f * 3.0, amp: 0.1, tau: 0.25, durSec: 0.6 })
  return s
}

const OUT = __dirname
const sounds = { chime, marimba, beep, bell }
for (const [name, gen] of Object.entries(sounds)) {
  fs.writeFileSync(path.join(OUT, `${name}.wav`), toWav(gen()))
  console.log(`wrote ${name}.wav`)
}
