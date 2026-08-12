/**
 * The registry of every destination the bottom navigation can reach, and the
 * single source of truth for what the bar and the More menu each show.
 *
 * Before this, the bar's list (TABS in AppTabBar) and the menu's list
 * (buildEntries in MoreMenu) were two hardcoded tables that couldn't trade
 * entries. Now both read one user-arranged list: `navItems` in the settings
 * store, an ordered array of { key, placement } across bar / menu / hidden,
 * edited at Settings > Navigation.
 *
 * Two kinds of destination live here, and the difference matters:
 *  - Tab routes (`route` set) are screens inside the tabs navigator. They can be
 *    pinned to the bar because the navigator can switch to them. Pinning one
 *    does NOT unregister it - every tab route stays declared in the tabs layout
 *    regardless of placement, or the navigator would lose the screen.
 *  - Pushed routes (`href` set) are ordinary stack pushes. Pinning one to the
 *    bar makes its icon push that route rather than switch tabs.
 *
 * More itself is not in this list: it's a fixed trailing slot on the bar that
 * opens the menu, so the menu can never be stranded.
 */
import type { icons } from './icons'
import type { Href } from 'expo-router'

/** Stable id for one navigation destination. Persisted in settings, so renaming
 *  one silently resets that entry to its default placement. */
export type NavItemKey =
  | 'index'
  | 'library'
  | 'now'
  | 'stats'
  | 'feedback'
  | 'discover'
  | 'questgiver'
  | 'following'
  | 'downloads'
  | 'history'
  | 'collections'
  | 'playlists'
  | 'settings'
  | 'server-settings'

/** Where a destination sits: pinned to the bottom bar, listed in the More menu,
 *  or not shown at all. */
export type NavPlacement = 'bar' | 'menu' | 'hidden'

/** One destination's placement + position, ordered within its placement group. */
export interface NavItemPref {
  key: NavItemKey
  placement: NavPlacement
}

/** Most destinations we pin to the bar before the icons get too cramped to hit.
 *  The fixed More button sits beyond this, so a full bar shows 6 icons. */
export const MAX_BAR_ITEMS = 5

export interface NavItemMeta {
  key: NavItemKey
  label: string
  /** Shorter label for the bar, where horizontal room is tight. Falls back to
   *  `label` when the full name already fits. */
  shortLabel?: string
  icon: keyof typeof icons
  /** Tabs-navigator route name, for destinations that are tab screens. */
  route?: string
  /** Stack route to push, for destinations that are not tab screens. */
  href?: Href
  /** Default grouping, used only to seed the shipped order. The menu now renders
   *  in the user's arrangement, so dividers are no longer derived from this. */
  group: 1 | 2 | 3
  /** True for destinations only an admin may reach. */
  adminOnly?: boolean
}

/**
 * Every destination, in the order they appear as defaults. Keep in step with
 * DEFAULT_NAV_ITEMS in the store (and its copy in @hearthshelf/core).
 */
export const NAV_ITEMS: Record<NavItemKey, NavItemMeta> = {
  index: { key: 'index', label: 'Home', icon: 'home', route: 'index', group: 1 },
  library: { key: 'library', label: 'Library', icon: 'library', route: 'library', group: 1 },
  now: {
    key: 'now',
    label: 'Now Playing',
    shortLabel: 'Now',
    icon: 'nowPlaying',
    route: 'now',
    group: 1,
  },
  stats: { key: 'stats', label: 'Stats', icon: 'stats', route: 'stats', group: 1 },
  feedback: { key: 'feedback', label: 'Feedback', icon: 'feedback', route: 'feedback', group: 3 },
  discover: {
    key: 'discover',
    label: 'Discover',
    icon: 'sparkle',
    href: '/discover?from=more',
    group: 1,
  },
  questgiver: {
    key: 'questgiver',
    label: 'QuestGiver',
    icon: 'questGiver',
    href: '/questgiver',
    group: 1,
  },
  following: {
    key: 'following',
    label: 'Following',
    icon: 'newRelease',
    href: '/following',
    group: 2,
  },
  downloads: {
    key: 'downloads',
    label: 'Downloads',
    icon: 'download',
    href: '/settings/storage',
    group: 2,
  },
  history: { key: 'history', label: 'History', icon: 'history', href: '/history', group: 2 },
  collections: {
    key: 'collections',
    label: 'Collections',
    icon: 'collections',
    href: '/collections',
    group: 2,
  },
  playlists: {
    key: 'playlists',
    label: 'Playlists',
    icon: 'playlists',
    href: '/playlists',
    group: 2,
  },
  settings: { key: 'settings', label: 'Settings', icon: 'settings', href: '/settings', group: 3 },
  'server-settings': {
    key: 'server-settings',
    label: 'Server Settings',
    icon: 'serverSettings',
    href: '/settings/admin',
    group: 3,
    adminOnly: true,
  },
}

/** Every tab route the tabs navigator must declare, whatever the user's
 *  arrangement. Unpinning a tab moves its icon, never its screen. */
export const TAB_ROUTES: string[] = Object.values(NAV_ITEMS)
  .filter((m) => m.route)
  .map((m) => m.route as string)

/** The label the bar uses for a destination (short form when one is defined). */
export function barLabel(meta: NavItemMeta): string {
  return meta.shortLabel ?? meta.label
}

/**
 * Resolve the arrangement into the two lists the UI renders, dropping anything
 * the current role can't reach. The bar is capped at MAX_BAR_ITEMS; any overflow
 * (a stale saved list, or a role change) falls into the menu rather than being
 * dropped, so a destination is never silently unreachable.
 */
export function resolveNav(
  items: NavItemPref[],
  isAdmin: boolean,
): { bar: NavItemMeta[]; menu: NavItemMeta[] } {
  const bar: NavItemMeta[] = []
  const menu: NavItemMeta[] = []
  for (const it of items) {
    const meta = NAV_ITEMS[it.key]
    if (!meta) continue
    if (meta.adminOnly && !isAdmin) continue
    if (it.placement === 'hidden') continue
    if (it.placement === 'bar' && bar.length < MAX_BAR_ITEMS) bar.push(meta)
    else menu.push(meta)
  }
  // Both lists stay in the user's arranged order - the menu no longer regroups
  // itself, since reordering it is the point of the editor.
  return { bar, menu }
}
