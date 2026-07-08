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
    minTile: size === 'compact' ? 86 : 112,
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

export function adaptivePlayerCoverMaxWidth(width: number, immersive: boolean): number {
  if (immersive) return Math.max(0, width - spacing.xl * 2)
  return windowClass(width) === 'compact' ? 360 : 440
}
