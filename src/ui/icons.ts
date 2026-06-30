/**
 * Glyph map: the web app uses Material Symbols; the native app uses MaterialIcons
 * from @expo/vector-icons. Centralized so screens reference semantic names and we
 * keep one place to swap icon sets.
 */
import MaterialIcons from '@expo/vector-icons/MaterialIcons'

export const Icon = MaterialIcons
export type IconName = React.ComponentProps<typeof MaterialIcons>['name']

export const icons = {
  // Tabs
  home: 'home',
  library: 'auto-stories',
  nowPlaying: 'graphic-eq',
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
} as const satisfies Record<string, IconName>
