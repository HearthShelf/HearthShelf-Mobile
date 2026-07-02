/**
 * The registry behind the player's customizable action buttons. Each
 * PlayerActionKey resolves to an icon, a label, and what happens when it's
 * tapped. The player builds this map once (with the live refs/labels it has on
 * hand) and both the on-screen row and the More tray render from it, so the
 * arrangement in My Settings is the single source of truth for order + labels.
 *
 * Actions with no mobile implementation yet (Cast, Car mode, Download, Notes)
 * are real entries here so they can be arranged, but their handler shows a
 * "Coming soon" toast until the feature lands.
 */
import type { PlayerActionKey } from '@/store/settings'
import { icons } from '@/ui/icons'

export interface PlayerActionDescriptor {
  key: PlayerActionKey
  icon: (typeof icons)[keyof typeof icons]
  label: string
  onPress: () => void
  /** Greyed out and non-interactive (e.g. Chapters with no chapters). */
  disabled?: boolean
  /** Ember-tinted active affordance (e.g. a running sleep timer). */
  active?: boolean
  /** 0..1 remaining fraction for the sleep timer's winding-down bar. */
  depletion?: number | null
  /** True for the not-yet-built stubs, so the editor can flag them. */
  comingSoon?: boolean
}

/** Everything the handlers need from the player to do their job. */
export interface ActionContext {
  present: (key: PlayerActionKey) => void
  comingSoon: (label: string) => void
  hasChapters: boolean
  /** e.g. "1.5×" - shown as the Speed button's label. */
  speedLabel: string
  /** e.g. "12:30", "Chapter", or "Sleep". */
  sleepLabel: string
  sleepActive: boolean
  sleepDepletion: number | null
  /** Whether the current item is downloaded (drives the Download label/icon). */
  downloaded?: boolean
}

/**
 * Build the full descriptor map. The keys the player passes to `present` are the
 * sheets it owns; stubs route through `comingSoon`. Order here is irrelevant -
 * the arrangement in settings decides placement and order.
 */
export function buildActions(ctx: ActionContext): Record<PlayerActionKey, PlayerActionDescriptor> {
  return {
    chapters: {
      key: 'chapters',
      icon: icons.chapters,
      label: 'Chapters',
      disabled: !ctx.hasChapters,
      onPress: () => ctx.present('chapters'),
    },
    speed: {
      key: 'speed',
      icon: icons.speed,
      label: ctx.speedLabel,
      onPress: () => ctx.present('speed'),
    },
    sleep: {
      key: 'sleep',
      icon: icons.sleep,
      label: ctx.sleepLabel,
      active: ctx.sleepActive,
      depletion: ctx.sleepDepletion,
      onPress: () => ctx.present('sleep'),
    },
    recent: {
      key: 'recent',
      icon: icons.recent,
      label: 'Recent',
      onPress: () => ctx.present('recent'),
    },
    bookmarks: {
      key: 'bookmarks',
      icon: icons.bookmarks,
      label: 'Bookmarks',
      onPress: () => ctx.present('bookmarks'),
    },
    details: {
      key: 'details',
      icon: icons.info,
      label: 'Details',
      onPress: () => ctx.present('details'),
    },
    addList: {
      key: 'addList',
      icon: icons.addList,
      label: 'Add to list',
      onPress: () => ctx.present('addList'),
    },
    cast: {
      key: 'cast',
      icon: icons.cast,
      label: 'Cast',
      comingSoon: true,
      onPress: () => ctx.comingSoon('Cast'),
    },
    carMode: {
      key: 'carMode',
      icon: icons.carMode,
      label: 'Car mode',
      comingSoon: true,
      onPress: () => ctx.comingSoon('Car mode'),
    },
    download: {
      key: 'download',
      icon: ctx.downloaded ? icons.downloadDone : icons.download,
      label: ctx.downloaded ? 'Downloaded' : 'Download',
      comingSoon: true,
      onPress: () => ctx.comingSoon('Downloads'),
    },
    notes: {
      key: 'notes',
      icon: icons.notes,
      label: 'Notes',
      onPress: () => ctx.present('notes'),
    },
  }
}

/** Static label/icon for the reorder editor, where no live context exists. */
export const ACTION_META: Record<
  PlayerActionKey,
  { icon: (typeof icons)[keyof typeof icons]; label: string; comingSoon?: boolean }
> = {
  chapters: { icon: icons.chapters, label: 'Chapters' },
  speed: { icon: icons.speed, label: 'Speed' },
  sleep: { icon: icons.sleep, label: 'Sleep' },
  recent: { icon: icons.recent, label: 'Recent' },
  bookmarks: { icon: icons.bookmarks, label: 'Bookmarks' },
  details: { icon: icons.info, label: 'Book details' },
  addList: { icon: icons.addList, label: 'Add to list' },
  cast: { icon: icons.cast, label: 'Cast', comingSoon: true },
  carMode: { icon: icons.carMode, label: 'Car mode', comingSoon: true },
  download: { icon: icons.download, label: 'Download', comingSoon: true },
  notes: { icon: icons.notes, label: 'Notes' },
}
