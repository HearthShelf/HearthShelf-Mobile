## Purpose

Browsing a listener's playlists and viewing one in order - including playlists
that mix whole books with individual podcast episodes - plus the maintenance
needed to keep one useful.

## ADDED Requirements

### Requirement: Browsing playlists

A listener SHALL be able to see their playlists, each identified by name, item
count, and artwork drawn from the items inside it.

#### Scenario: Opening the playlists list
- **WHEN** the listener opens Playlists
- **THEN** their playlists are listed with name, item count and artwork

#### Scenario: No playlists yet
- **WHEN** the listener has no playlists
- **THEN** an empty state explains what playlists are and how to make one

#### Scenario: More playlists than one server page
- **WHEN** the listener has more playlists than the server returns by default
- **THEN** all of them are still listed

### Requirement: Playlists are ordered

A playlist SHALL present its items in the order the server holds them, and each
item SHALL show its position.

#### Scenario: Viewing a playlist
- **WHEN** the listener opens a playlist
- **THEN** its items appear in server order, each showing its position

#### Scenario: Playing the playlist
- **WHEN** the listener chooses Play all
- **THEN** playback starts from the first item

#### Scenario: Playing one item
- **WHEN** the listener plays a single item from the list
- **THEN** that item starts, without reordering the playlist

### Requirement: Items may be episodes

A playlist item MAY be a single podcast episode rather than a whole book. An
episode item SHALL be presented as an episode, not as a book.

#### Scenario: An episode in a playlist
- **WHEN** a playlist contains a podcast episode
- **THEN** the row identifies the episode and the podcast it belongs to

#### Scenario: Opening an episode item
- **WHEN** the listener opens an episode item
- **THEN** the destination is that episode, not the podcast's first episode

### Requirement: Maintaining a playlist

A listener SHALL be able to rename a playlist, remove an item from it, and
delete it.

#### Scenario: Renaming
- **WHEN** the listener renames a playlist and confirms
- **THEN** the new name is saved and shown

#### Scenario: Removing an item
- **WHEN** the listener removes an item
- **THEN** the item leaves the playlist and the remaining positions renumber
- **AND** the book or episode remains in the library

#### Scenario: Deleting a playlist
- **WHEN** the listener deletes a playlist and confirms
- **THEN** it is gone from the list
- **AND** its items remain in the library

#### Scenario: A maintenance action fails
- **WHEN** a rename, removal or delete fails on the server
- **THEN** the playlist returns to its previous state
- **AND** the failure is surfaced

### Requirement: No reordering affordance

The playlist view SHALL NOT present a control that implies items can be
reordered, unless reordering is actually implemented.

#### Scenario: Viewing playlist rows
- **WHEN** the listener views a playlist
- **THEN** no drag handle or other reorder affordance is shown
