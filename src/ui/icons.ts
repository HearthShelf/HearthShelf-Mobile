/**
 * Glyph map: the web app + design system use Material Symbols Rounded; the native
 * app renders MaterialIcons from @expo/vector-icons (same Google glyph set, no
 * extra font to ship). Centralized so screens reference semantic names.
 *
 * The DS marks active / now-playing states with the FILLED icon variant. Some
 * glyphs have an explicit `-filled` twin in MaterialIcons (home, play-circle);
 * for the rest the base glyph already reads as a solid fill, so `filledIcons`
 * below maps a semantic name to its filled glyph where one is meaningfully
 * different, and callers pass `filled` to opt in.
 *
 * Full Material Symbols Rounded (true outlined/filled variable font) is a later
 * fidelity upgrade; MaterialIcons + the ember pill/tint carry the active
 * affordance for now.
 */
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

export const Icon = MaterialIcons
export type IconName = React.ComponentProps<typeof MaterialIcons>['name']

export const icons = {
  // Tabs
  home: 'home',
  library: 'auto-stories',
  nowPlaying: 'play-circle',
  stats: 'insights',
  more: 'more-horiz',
  // Transport
  play: 'play-arrow',
  pause: 'pause',
  rewind: 'replay-10',
  forward: 'forward-30',
  skipPrev: 'skip-previous',
  skipNext: 'skip-next',
  // Player toolbar
  chapters: 'format-list-bulleted',
  speed: 'speed',
  sleep: 'bedtime',
  recent: 'history',
  // Brand / stats
  flame: 'local-fire-department',
  schedule: 'schedule',
  car: 'directions-car',
  check: 'check',
  checkCircle: 'check-circle',
  tune: 'tune',
  sort: 'swap-vert',
  dragHandle: 'drag-indicator',
  queue: 'queue-music',
  bookmark: 'bookmark-add',
  bookmarkFilled: 'bookmark-added',
  info: 'info',
  addList: 'playlist-add',
  readAlong: 'menu-book',
  share: 'ios-share',
  expandLess: 'expand-less',
  nothingQueued: 'do-not-disturb-on',
  // Nav / actions
  search: 'search',
  back: 'arrow-back',
  close: 'close',
  chevronRight: 'chevron-right',
  expand: 'expand-less',
  collapse: 'expand-more',
  server: 'dns',
  signOut: 'logout',
  retry: 'refresh',
  // Settings
  palette: 'palette',
  darkMode: 'dark-mode',
  connections: 'hub',
  book: 'menu-book',
  person: 'person',
  chevronDown: 'expand-more',
  checkCircleFilled: 'check-circle',
  link: 'link',
  add: 'add',
} as const satisfies Record<string, IconName>

/**
 * Filled glyph per semantic name, for active / now-playing states. Only names
 * with a meaningfully-different filled twin appear here; `iconFor(name, filled)`
 * falls back to the outlined glyph otherwise.
 */
export const filledIcons = {
  home: 'home-filled',
  nowPlaying: 'play-circle-filled',
  play: 'play-arrow',
  flame: 'local-fire-department',
} as const satisfies Partial<Record<keyof typeof icons, IconName>>

/** Resolve a semantic icon name to a glyph, picking the filled twin when asked. */
export function iconFor(name: keyof typeof icons, filled = false): IconName {
  if (filled && name in filledIcons) {
    return filledIcons[name as keyof typeof filledIcons]
  }
  return icons[name]
}
