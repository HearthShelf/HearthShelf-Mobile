import { spacing } from './theme'

export type WindowClass = 'compact' | 'medium' | 'expanded'

export function windowClass(width: number): WindowClass {
  if (width >= 840) return 'expanded'
  if (width >= 600) return 'medium'
  return 'compact'
}

export function adaptiveHorizontalPadding(width: number): number {
  return windowClass(width) === 'compact' ? spacing.lg : spacing.xl
}

export function adaptiveContentMaxWidth(width: number): number {
  return windowClass(width) === 'compact' ? width : Math.min(width, 640)
}

export function adaptiveGridColumns({
  width,
  minTile,
  maxCols,
  minCols = 2,
  gutter = spacing.lg,
  horizontalPadding = adaptiveHorizontalPadding(width) * 2,
  reserved = 0,
}: {
  width: number
  minTile: number
  maxCols: number
  minCols?: number
  gutter?: number
  horizontalPadding?: number
  reserved?: number
}): number {
  const available = Math.max(0, width - horizontalPadding - reserved)
  const fit = Math.floor((available + gutter) / (minTile + gutter))
  return Math.max(minCols, Math.min(maxCols, fit || minCols))
}

export function adaptiveGridTileWidth({
  width,
  cols,
  gutter = spacing.lg,
  horizontalPadding = adaptiveHorizontalPadding(width) * 2,
  reserved = 0,
}: {
  width: number
  cols: number
  gutter?: number
  horizontalPadding?: number
  reserved?: number
}): number {
  const available = Math.max(0, width - horizontalPadding - reserved)
  return (available - gutter * (cols - 1)) / cols
}

export function adaptiveLibraryColumns(width: number, size: 'comfortable' | 'compact'): number {
  return adaptiveGridColumns({
    width,
    // 108 (not 112) so comfortable fits 3 columns at every phone width: a 390pt
    // iPhone yields available=358 -> floor((358+16)/(108+16)) = 3. At 112 the same
    // phone floored to 2 (needed >=402pt), which read as an oversized 2-up grid on
    // iPhone while wider Android dp landed on 3. A real 3-up tile is ~109pt.
    minTile: size === 'compact' ? 86 : 108,
    maxCols: size === 'compact' ? 7 : 6,
    minCols: 2,
  })
}

export function adaptiveShelfTileWidth(width: number): number {
  switch (windowClass(width)) {
    case 'expanded':
      return 144
    case 'medium':
      return 132
    default:
      return 120
  }
}

/**
 * Play-button diameter for the player transport, sized so the five-button row
 * (chapter-prev, rewind, play, forward, chapter-next) keeps real gaps between
 * buttons instead of jamming edge-to-edge. Fixed 84dp overflowed the row on
 * small-dp windows (display size "large": ~350-400dp wide), pushing the outer
 * buttons to the screen edge.
 *
 * `rowWidth` is the transport row's inner width (after the control rail's
 * padding and any vertical-nav inset). The other four buttons total ~228dp;
 * the play button only gives up size once four ~10dp minimum gaps no longer
 * fit around the full 84, clamped to a 56dp floor.
 */
export function adaptivePlayerPlaySize(rowWidth: number): number {
  const siblings = 60 + 54 + 54 + 60 // chapter btns (60) + skip btns (34 * 1.6)
  const minGaps = 4 * 10
  return Math.round(Math.max(56, Math.min(84, rowWidth - siblings - minGaps)))
}

export function adaptivePlayerCoverMaxWidth(width: number, immersive: boolean): number {
  if (immersive) return Math.max(0, width - spacing.xl * 2)
  // Compact: no fixed cap - the side gutters and the measured cover-area height
  // (player.tsx coverMaxH) bound the artwork. A fixed dp cap left wide bands of
  // dead space around the cover on low-density displays (display size set to
  // "small"), where the same screen offers far more dp. Medium/expanded keep a
  // cap so tablets don't show a billboard.
  return windowClass(width) === 'compact' ? Math.max(0, width - spacing.xl * 2) : 440
}
