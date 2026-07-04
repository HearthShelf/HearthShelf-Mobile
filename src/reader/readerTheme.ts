/**
 * Builds an @epubjs-react-native Theme (CSS-in-JS injected into the book's
 * WebView) from the shared core reader prefs, so the mobile reader's palette and
 * typography match the web readers. Theme shape: { selector: { cssProp: val } }.
 */
import {
  READER_THEMES,
  READER_LINE_HEIGHTS,
  READER_WIDTHS,
  type ReaderPrefs,
} from '@hearthshelf/core'
import { READER_FONT_FAMILIES } from './readerPrefs'

export type EpubTheme = { [selector: string]: { [cssProp: string]: string } }

export function buildReaderTheme(prefs: ReaderPrefs): EpubTheme {
  const t = READER_THEMES[prefs.theme]
  const lh = READER_LINE_HEIGHTS[prefs.lh]
  const maxWidth = READER_WIDTHS[prefs.width]
  return {
    body: {
      background: t.bg,
      color: t.ink,
      'font-family': READER_FONT_FAMILIES[prefs.font],
      'font-size': `${prefs.size}px`,
      'line-height': String(lh),
      'text-align': prefs.align,
      'max-width': `${maxWidth}px`,
      margin: '0 auto',
      padding: '0 6vw',
    },
    p: {
      'font-family': READER_FONT_FAMILIES[prefs.font],
      'line-height': String(lh),
      'text-align': prefs.align,
    },
    // A quiet drop-cap on each chapter's opening paragraph, matching the web
    // reader's print touch.
    'p:first-of-type::first-letter': {
      'font-size': '3.1em',
      'line-height': '0.82',
      float: 'left',
      'padding-right': '0.08em',
      'font-weight': '600',
      color: t.ink,
    },
    a: { color: t.ink },
  }
}
