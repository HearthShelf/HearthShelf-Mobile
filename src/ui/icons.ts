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
  nowPlaying: 'graphic-eq',
  stats: 'insights',
  more: 'more-horiz',
  // Transport
  play: 'play-arrow',
  pause: 'pause',
  replay: 'replay',
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
  bell: 'notifications',
  bellActive: 'notifications-active',
  bellOff: 'notifications-off',
  newRelease: 'new-releases',
  calendar: 'event',
  // Stats screen
  flag: 'flag',
  straighten: 'straighten',
  compress: 'compress',
  voice: 'record-voice-over',
  premium: 'workspace-premium',
  barChart: 'bar-chart',
  compare: 'compare-arrows',
  edit: 'edit',
  monthView: 'calendar-view-month',
  today: 'today',
  hourglass: 'hourglass-top',
  trending: 'trending-up',
  car: 'directions-car',
  // Recent-session device kinds. Apple/Android/Car are brand logos drawn from
  // MaterialCommunityIcons in DeviceKindIcon; web/desktop use these MaterialIcons.
  language: 'language',
  computer: 'computer',
  check: 'check',
  checkCircle: 'check-circle',
  doneAll: 'done-all',
  removeDone: 'remove-done',
  taskAlt: 'task-alt',
  checklist: 'checklist',
  selectAll: 'select-all',
  arrowDownward: 'arrow-downward',
  filter: 'filter-list',
  viewList: 'view-list',
  viewGrid: 'grid-view',
  unfold: 'unfold-more',
  listNumbered: 'format-list-numbered',
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
  cast: 'cast',
  carMode: 'directions-car',
  focusView: 'center-focus-strong',
  download: 'download',
  downloadDone: 'download-done',
  notes: 'sticky-note-2',
  send: 'send',
  club: 'groups',
  people: 'group',
  chat: 'forum',
  bookmarks: 'bookmarks',
  visible: 'visibility',
  hidden: 'visibility-off',
  lock: 'lock',
  shield: 'shield',
  onScreen: 'grid-view',
  inTray: 'more-horiz',
  expandLess: 'expand-less',
  arrowUpward: 'arrow-upward',
  nothingQueued: 'do-not-disturb-on',
  sparkle: 'auto-awesome',
  // Nav / actions
  search: 'search',
  back: 'arrow-back',
  close: 'close',
  archive: 'archive',
  delete: 'delete',
  chevronRight: 'chevron-right',
  chevronLeft: 'chevron-left',
  textFields: 'text-fields',
  expand: 'expand-less',
  collapse: 'expand-more',
  server: 'dns',
  signOut: 'logout',
  retry: 'refresh',
  cloudOff: 'cloud-off',
  cloudDone: 'cloud-done',
  cloudSync: 'cloud-sync',
  cloudQueue: 'cloud-queue',
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
  // Requests / missing books
  bolt: 'bolt',
  shoppingCart: 'shopping-cart',
  openInNew: 'open-in-new',
  cloudDownload: 'cloud-download',
  error: 'error',
  receiptLong: 'receipt-long',
} as const satisfies Record<string, IconName>

/**
 * Filled glyph per semantic name, for active / now-playing states. Only names
 * with a meaningfully-different filled twin appear here; `iconFor(name, filled)`
 * falls back to the outlined glyph otherwise.
 */
export const filledIcons = {
  home: 'home-filled',
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
