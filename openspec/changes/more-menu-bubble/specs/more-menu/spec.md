## Purpose

The More tab's popup menu: a bubble anchored to the tab that lists the app's
secondary destinations, so reaching Discover, Downloads or the admin surface is
one tap rather than a trip through a settings screen.

## ADDED Requirements

### Requirement: Opening the menu

Tapping the More tab SHALL open a popup menu anchored above it. It SHALL NOT
navigate to a screen, and the tab underneath SHALL stay on whatever screen the
user was already on.

#### Scenario: Tapping More from any tab
- **WHEN** the user taps the More tab
- **THEN** the popup opens above the tab bar
- **AND** the current screen stays mounted and visible behind it

#### Scenario: The More tab reflects the open state
- **WHEN** the popup is open
- **THEN** the More tab renders in its active style
- **AND** it exposes an expanded state to accessibility services

#### Scenario: Tapping More while it is already open
- **WHEN** the popup is open and the user taps the More tab again
- **THEN** the popup dismisses

### Requirement: Dismissing the menu

The menu SHALL be dismissible without making a choice, and choosing an item
SHALL dismiss it.

#### Scenario: Tapping outside
- **WHEN** the user taps the scrim outside the bubble
- **THEN** the popup dismisses and no navigation occurs

#### Scenario: Android back button
- **WHEN** the popup is open on Android and the user presses hardware back
- **THEN** the popup dismisses and the press does not propagate to the router

#### Scenario: Choosing a destination
- **WHEN** the user taps an entry
- **THEN** the popup dismisses and the app navigates to that destination

### Requirement: Menu contents

The menu SHALL list the app's secondary destinations in three groups, separated
by dividers, in this order: Discover and QuestGiver; Downloads, History,
Collections and Playlists; Settings and Server Settings.

Discover SHALL be presented as the leading entry, visually distinct from the
rest.

#### Scenario: Default contents for a non-admin
- **WHEN** a non-admin opens the menu
- **THEN** the entries are Discover, QuestGiver, Downloads, History,
  Collections, Playlists, Settings
- **AND** Server Settings is absent

#### Scenario: Entries whose screens do not exist yet
- **WHEN** the menu renders an entry whose destination screen is not built on
  this platform
- **THEN** that entry is omitted from the menu
- **AND** the remaining entries keep their relative order and grouping

### Requirement: Admin-only entries

Server Settings SHALL appear only when the connected account has the admin role
on the active server. It SHALL be omitted entirely rather than shown disabled.

#### Scenario: Admin on the active server
- **WHEN** an admin opens the menu
- **THEN** Server Settings appears as the last entry

#### Scenario: Role changes while the app is running
- **WHEN** the active server or the account's role changes
- **THEN** the next open of the menu reflects the new role

### Requirement: Growth animation

The menu SHALL animate open by growing from its bottom-right corner - the corner
nearest the More tab - toward its top-left, so it reads as unfolding out of the
tab that was tapped.

The growth SHALL be continuous: a single motion from start to rest with no
intermediate hold, followed by a slight settle. It SHALL start small enough to
read as a point at the corner rather than as an already-visible rectangle.

#### Scenario: Opening
- **WHEN** the popup opens
- **THEN** it scales up from its bottom-right corner
- **AND** the scale increases monotonically until it overshoots its final size
  slightly, then settles back

#### Scenario: Reduced motion
- **WHEN** the OS reports a reduced-motion preference
- **THEN** the popup appears without the growth animation
- **AND** all entries are immediately visible and interactive

#### Scenario: Entries revealing
- **WHEN** the popup opens with motion enabled
- **THEN** entries fade in staggered from the growth corner outward
- **AND** every entry is fully opaque once the animation completes

### Requirement: Settings is a pushed route

The screen previously reached by the More tab SHALL become a pushed route
reached from the menu's Settings entry.

#### Scenario: Opening Settings from the menu
- **WHEN** the user taps Settings
- **THEN** the settings screen is pushed
- **AND** back returns to the screen the user opened the menu from

### Requirement: Discover has one entry point

Discover SHALL be reachable from the More menu, and SHALL NOT also be surfaced
as a Home header button.

#### Scenario: Home header after this change
- **WHEN** the user views the Home header
- **THEN** it offers arrange, downloads and search
- **AND** it does not offer a Discover button
