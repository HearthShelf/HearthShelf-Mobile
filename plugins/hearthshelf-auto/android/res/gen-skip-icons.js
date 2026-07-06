// Generate the skip-back / skip-forward vectorDrawables with bold numerals.
// One shared circular arrow (mirrored for forward) + a bold digit glyph library,
// laid out centered. Writes ic_hs_rewind[_N].xml and ic_hs_forward[_N].xml.
const fs = require('fs')
const path = require('path')

const OUT = process.argv[2] // drawable dir

// Circular arrow, viewport 48, broken at top with an arrowhead. Back version
// points left; forward is the same ring mirrored so the head points right.
const RING_BACK = `M24,8 L24,2 L15,9.5 L24,17 L24,11.2
  C31.1,11.2 36.8,16.9 36.8,24 C36.8,31.1 31.1,36.8 24,36.8
  C16.9,36.8 11.2,31.1 11.2,24 C11.2,20.7 12.4,17.8 14.5,15.5
  L12.2,13.2 C9.5,16 7.9,19.8 7.9,24 C7.9,32.9 15.1,40.1 24,40.1
  C32.9,40.1 40.1,32.9 40.1,24 C40.1,15.1 32.9,8 24,8 Z`
const RING_FWD = `M24,8 L24,2 L33,9.5 L24,17 L24,11.2
  C16.9,11.2 11.2,16.9 11.2,24 C11.2,31.1 16.9,36.8 24,36.8
  C31.1,36.8 36.8,31.1 36.8,24 C36.8,20.7 35.6,17.8 33.5,15.5
  L35.8,13.2 C38.5,16 40.1,19.8 40.1,24 C40.1,32.9 32.9,40.1 24,40.1
  C15.1,40.1 7.9,32.9 7.9,24 C7.9,15.1 15.1,8 24,8 Z`

// Bold digit glyphs on a 0..12 wide, 0..16 tall cell (baseline at 16, top at 0).
// Filled outlines, stroke-weight ~2.4. Centered later by translating.
const DIGIT = {
  '0': 'M6,0 C9,0 11,2.6 11,8 C11,13.4 9,16 6,16 C3,16 1,13.4 1,8 C1,2.6 3,0 6,0 Z M6,2.4 C4.5,2.4 3.6,4.2 3.6,8 C3.6,11.8 4.5,13.6 6,13.6 C7.5,13.6 8.4,11.8 8.4,8 C8.4,4.2 7.5,2.4 6,2.4 Z',
  '1': 'M4.6,0 L8,0 L8,16 L5.4,16 L5.4,3 L3,3.6 L3,1.3 Z',
  '5': 'M1.8,0 L10,0 L10,2.6 L4.3,2.6 L4.3,5.8 C4.9,5.5 5.6,5.4 6.3,5.4 C9.1,5.4 11,7.3 11,10.4 C11,13.6 8.9,16 5.9,16 C3.6,16 1.7,14.8 1,12.8 L3.6,11.7 C4,12.8 4.8,13.4 5.9,13.4 C7.3,13.4 8.3,12.2 8.3,10.5 C8.3,8.8 7.3,7.7 5.9,7.7 C5,7.7 4.3,8.1 3.8,8.9 L1.4,8.4 Z',
  '3': 'M1.4,3.2 C2,1.1 3.8,0 6,0 C8.8,0 10.8,1.7 10.8,4.2 C10.8,5.9 9.9,7.1 8.4,7.6 C10.1,8 11.2,9.4 11.2,11.3 C11.2,14.1 9,16 6,16 C3.6,16 1.6,14.7 1,12.5 L3.6,11.6 C3.9,12.8 4.8,13.5 6,13.5 C7.4,13.5 8.4,12.6 8.4,11.2 C8.4,9.8 7.4,9 5.8,9 L4.7,9 L4.7,6.6 L5.7,6.6 C7.1,6.6 8,5.8 8,4.5 C8,3.3 7.2,2.5 6,2.5 C4.9,2.5 4.1,3.1 3.8,4.2 Z',
  '6': 'M6.2,0 C8.2,0 9.8,0.9 10.6,2.6 L8.2,3.8 C7.8,3 7.1,2.5 6.2,2.5 C4.6,2.5 3.6,4 3.6,6.6 L3.6,7.2 C4.3,6.2 5.4,5.6 6.7,5.6 C9.2,5.6 11,7.7 11,10.6 C11,13.7 8.9,16 6,16 C2.9,16 1,13.5 1,9 C1,3.4 3,0 6.2,0 Z M6,7.9 C4.6,7.9 3.6,9 3.6,10.7 C3.6,12.4 4.6,13.6 6,13.6 C7.4,13.6 8.4,12.4 8.4,10.7 C8.4,9 7.4,7.9 6,7.9 Z',
  '9': 'M5.8,16 C3.8,16 2.2,15.1 1.4,13.4 L3.8,12.2 C4.2,13 4.9,13.5 5.8,13.5 C7.4,13.5 8.4,12 8.4,9.4 L8.4,8.8 C7.7,9.8 6.6,10.4 5.3,10.4 C2.8,10.4 1,8.3 1,5.4 C1,2.3 3.1,0 6,0 C9.1,0 11,2.5 11,7 C11,12.6 9,16 5.8,16 Z M6,2.4 C4.6,2.4 3.6,3.6 3.6,5.3 C3.6,7 4.6,8.1 6,8.1 C7.4,8.1 8.4,7 8.4,5.3 C8.4,3.6 7.4,2.4 6,2.4 Z',
  '2': 'M1.3,4.3 C1.7,1.7 3.6,0 6.1,0 C8.8,0 10.7,1.8 10.7,4.4 C10.7,6.2 9.8,7.7 7.7,9.6 L4.8,12.3 L4.8,13.4 L10.9,13.4 L10.9,16 L1.1,16 L1.1,13.7 L5.9,9.3 C7.6,7.7 8.1,6.6 8.1,4.5 C8.1,3.2 7.3,2.5 6.1,2.5 C4.9,2.5 4.1,3.2 3.9,4.7 Z',
  '4': 'M7.3,0 L10,0 L10,10.2 L11.6,10.2 L11.6,12.6 L10,12.6 L10,16 L7.4,16 L7.4,12.6 L0.6,12.6 L0.6,10.4 Z M7.4,10.2 L7.4,3.8 L3.3,10.2 Z',
  '7': 'M1.2,0 L10.8,0 L10.8,2.2 L5.9,16 L3,16 L7.8,2.6 L1.2,2.6 Z',
  '8': 'M6,0 C8.7,0 10.6,1.6 10.6,4 C10.6,5.6 9.7,6.8 8.2,7.4 C10,8 11,9.3 11,11.2 C11,13.8 8.9,16 6,16 C3.1,16 1,13.8 1,11.2 C1,9.3 2,8 3.8,7.4 C2.3,6.8 1.4,5.6 1.4,4 C1.4,1.6 3.3,0 6,0 Z M6,2.3 C4.8,2.3 4,3.1 4,4.3 C4,5.5 4.8,6.3 6,6.3 C7.2,6.3 8,5.5 8,4.3 C8,3.1 7.2,2.3 6,2.3 Z M6,8.5 C4.6,8.5 3.6,9.4 3.6,10.8 C3.6,12.2 4.6,13.2 6,13.2 C7.4,13.2 8.4,12.2 8.4,10.8 C8.4,9.4 7.4,8.5 6,8.5 Z',
  '.': 'M1.4,12.8 L4.4,12.8 L4.4,16 L1.4,16 Z',
  'x': 'M0.6,6 L3.6,6 L5.8,9.1 L8,6 L11,6 L7.4,10.9 L11.2,16 L8.2,16 L5.8,12.7 L3.4,16 L0.4,16 L4.2,10.9 Z',
}

// Per-glyph advance widths on the 16-tall cell ('.' is narrow).
const GLYPH_W = { '.': 5.4, x: 11.4 }
const glyphW = (c) => GLYPH_W[c] ?? 12

// Render a number (1-2 digits) as filled paths, scaled to fit the ring center
// and horizontally centered. Cell is 12 wide; scale to a comfortable size.
function numberPaths(n) {
  const s = String(n)
  const scale = 0.62 // 16-tall cell -> ~10 units tall
  const cellW = 12 * scale
  const gap = 0.6
  const totalW = s.length * cellW + (s.length - 1) * gap
  const startX = 24 - totalW / 2
  const topY = 24 - (16 * scale) / 2 - 1.3 // optical center (arrowhead notch sits up top)
  let out = []
  s.split('').forEach((d, i) => {
    const g = DIGIT[d]
    if (!g) return
    const tx = startX + i * (cellW + gap)
    out.push(
      `<group android:translateX="${tx.toFixed(2)}" android:translateY="${topY.toFixed(2)}" android:scaleX="${scale}" android:scaleY="${scale}">
      <path android:fillColor="@android:color/white" android:pathData="${g}"/>
    </group>`,
    )
  })
  return out.join('\n  ')
}

function icon(ring, n) {
  return `<!-- Skip ${n}s. Bold numeral fills the arc so it reads clearly on the car
     display. Generated - edit gen-icons.js, not this file. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="48dp"
    android:height="48dp"
    android:viewportWidth="48"
    android:viewportHeight="48">
  <path android:fillColor="@android:color/white"
      android:pathData="${ring.replace(/\s+/g, ' ').trim()}"/>
  ${numberPaths(n)}
</vector>
`
}

// Speed badge: the rate as bold text ("1.25x"), no ring, scaled to fill the
// viewport. The car button then reads the CURRENT speed at a glance.
function speedIcon(rate) {
  const s = `${rate}x`
  const chars = s.split('')
  const gap = 0.7
  const unitW = chars.reduce((w, c) => w + glyphW(c), 0) + gap * (chars.length - 1)
  const scale = Math.min(1.5, 42 / unitW)
  const startX = 24 - (unitW * scale) / 2
  const topY = 24 - (16 * scale) / 2
  let x = startX
  const groups = chars.map((c) => {
    const g = `<group android:translateX="${x.toFixed(2)}" android:translateY="${topY.toFixed(2)}" android:scaleX="${scale.toFixed(3)}" android:scaleY="${scale.toFixed(3)}">
      <path android:fillColor="@android:color/white" android:pathData="${DIGIT[c]}"/>
    </group>`
    x += (glyphW(c) + gap) * scale
    return g
  })
  return `<!-- Playback speed ${s}. Bold rate text so the current speed reads at a
     glance on the car display. Generated - edit gen-skip-icons.js, not this file. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="48dp"
    android:height="48dp"
    android:viewportWidth="48"
    android:viewportHeight="48">
  ${groups.join('\n  ')}
</vector>
`
}

// Cover every value the skip settings slider can produce (5..300 step 5) so the
// car's resId-backed buttons always find an exact-numeral icon. Vector XML is
// tiny, so the full set costs almost nothing in the APK. (The phone notification
// draws its numeral at runtime instead - see SkipIconRenderer.kt.)
const SKIP_SECS = []
for (let n = 5; n <= 300; n += 5) SKIP_SECS.push(n)
// Base names (no suffix) are the in-app defaults: 15 back, 30 forward.
fs.writeFileSync(path.join(OUT, 'ic_hs_rewind.xml'), icon(RING_BACK, 15))
fs.writeFileSync(path.join(OUT, 'ic_hs_forward.xml'), icon(RING_FWD, 30))
for (const n of SKIP_SECS) {
  fs.writeFileSync(path.join(OUT, `ic_hs_rewind_${n}.xml`), icon(RING_BACK, n))
  fs.writeFileSync(path.join(OUT, `ic_hs_forward_${n}.xml`), icon(RING_FWD, n))
}

// Speed presets (must cover HearthShelfAutoService.SPEED_PRESETS). File name
// encodes the rate with '.' -> '_' ("1.25" -> ic_hs_speed_1_25x).
const SPEEDS = ['0.75', '1', '1.25', '1.5', '1.75', '2']
for (const r of SPEEDS) {
  fs.writeFileSync(path.join(OUT, `ic_hs_speed_${r.replace('.', '_')}x.xml`), speedIcon(r))
}
console.log(
  'generated skip icons:', SKIP_SECS.length, 'x2 (5..300 step 5)',
  ' speed:', SPEEDS.join(','),
)
