## Why

The More tab currently pushes a full settings screen. That makes it the right
place to change a preference and the wrong place to *go* somewhere - Discover,
Downloads and the admin surface are destinations, not settings, and two of them
are buried inside a settings list they don't belong in.

Discover in particular has no real home: it shipped with a sparkle button
squeezed into the Home header, which is a fourth icon competing for a space that
already holds three.

A popup anchored to the More tab turns it into a jump menu: one tap, pick a
destination, no screen transition for something you might not even want.

## What Changes

- Tapping **More** opens a bubble anchored above the tab instead of navigating
  to a screen. The bubble grows out of its bottom-right corner with a spring.
- The bubble lists eight destinations in three groups:
  - Discover, QuestGiver
  - Downloads, History, Collections, Playlists
  - Settings, Server Settings
- **Settings** (today's More screen) becomes a pushed route rather than a tab
  destination.
- **Server Settings** appears only for admins.
- The Discover sparkle button is removed from the Home header - the bubble
  becomes its single entry point.
- Tapping the scrim, pressing back, or choosing an item dismisses the bubble.

Four of the eight destinations do not exist on this platform yet (QuestGiver,
History, Collections, Playlists). This change builds the menu and wires the four
that exist; the remaining rows are added as their screens land. Their disabled /
empty presentation is deliberately out of scope and will be spec'd separately.

## Capabilities

### New Capabilities
- `more-menu`: The More tab's popup menu - how it opens, dismisses, animates,
  which destinations it lists, and how entries are gated by role and platform
  availability.

## Impact

- `app/(tabs)/_layout.tsx` - the More tab intercepts its own press instead of
  navigating.
- `app/(tabs)/more.tsx` - becomes `app/settings/index.tsx`, a pushed route.
- `src/ui/AppTabBar.tsx` - the More tab needs a press hook and an open state;
  `PILL_TABS` and `TABS` both carry a More entry.
- `app/(tabs)/index.tsx` - the Discover sparkle button in `HomeHeader` is
  removed.
- New: `src/ui/MoreMenu.tsx`.
- `src/ui/motion.tsx` - a spring config for the bubble's growth.
- No API, backend, or `@hearthshelf/core` changes.
