## Purpose

Hand-built lists of things to listen to: browsing them, opening one, and keeping
it useful. Two kinds share this behaviour - **collections** (library-wide,
unordered, whole books) and **playlists** (private to the listener, ordered, and
able to hold a single podcast episode). Requirements below apply to both kinds
unless they name one.

## ADDED Requirements

### Requirement: Browsing lists

A listener SHALL be able to see the lists of a given kind available to them,
each identified by its name, how many items it holds, and artwork drawn from the
items inside it.

#### Scenario: Opening the list of collections
- **WHEN** the listener opens Collections
- **THEN** every collection in the active library is listed
- **AND** each shows its name, its book count, and cover art from its books

#### Scenario: Opening the list of playlists
- **WHEN** the listener opens Playlists
- **THEN** their own playlists are listed
- **AND** each shows its name, its item count, and cover art from its items

#### Scenario: A list with more items than the tile shows
- **WHEN** a list holds more items than its tile displays artwork for
- **THEN** the tile indicates how many further items it contains

#### Scenario: Nothing to show yet
- **WHEN** there are no lists of that kind
- **THEN** an empty state explains what that kind is and how to make one

#### Scenario: More lists than one server page
- **WHEN** there are more lists than the server returns by default
- **THEN** all of them are still listed

### Requirement: Viewing a list

Opening a list SHALL show what it contains and how much listening it represents,
and allow starting playback from it.

#### Scenario: Opening a list
- **WHEN** the listener opens a list
- **THEN** its contents are shown with the listener's own progress
- **AND** the list's item count and total duration are shown

#### Scenario: Playing a list
- **WHEN** the listener chooses Play all
- **THEN** playback starts from the list's first item

#### Scenario: Opening one item
- **WHEN** the listener opens an item
- **THEN** that item's own destination opens

#### Scenario: Playing one item
- **WHEN** the listener plays a single item from a list
- **THEN** that item starts, without reordering the list

### Requirement: Collections are unordered books

A collection SHALL present its contents as books, with no position shown and no
ordering implied.

#### Scenario: Viewing a collection
- **WHEN** the listener opens a collection
- **THEN** its books are shown without position numbers

### Requirement: Playlists are ordered

A playlist SHALL present its items in the order the server holds them, and each
item SHALL show its position.

#### Scenario: Viewing a playlist
- **WHEN** the listener opens a playlist
- **THEN** its items appear in server order, each showing its position

#### Scenario: Order survives a reload
- **WHEN** the listener reopens a playlist
- **THEN** the items are in the same order the server holds

### Requirement: Playlist items may be episodes

A playlist item MAY be a single podcast episode rather than a whole book. An
episode item SHALL be presented as an episode, not as a book.

#### Scenario: An episode in a playlist
- **WHEN** a playlist contains a podcast episode
- **THEN** the row shows the episode's own title and duration
- **AND** it identifies the podcast the episode belongs to

#### Scenario: An episode row is not mistaken for its podcast
- **WHEN** a playlist entry carries episode detail alongside its library item
- **THEN** the entry is presented from the episode, not from the library item
- **AND** the library item is treated as the containing podcast

#### Scenario: Opening an episode item
- **WHEN** the listener opens an episode item
- **THEN** the destination is that episode, not the podcast or its first episode

### Requirement: Maintaining a list

A listener SHALL be able to rename a list, remove an item from it, and delete
it.

#### Scenario: Renaming
- **WHEN** the listener renames a list and confirms
- **THEN** the new name is saved and shown

#### Scenario: Removing an item
- **WHEN** the listener removes an item from a list
- **THEN** the item leaves the list
- **AND** the underlying book or episode remains in the library

#### Scenario: Removing an item from an ordered list
- **WHEN** the listener removes an item from a playlist
- **THEN** the remaining items renumber

#### Scenario: Deleting a list
- **WHEN** the listener deletes a list and confirms
- **THEN** the list is gone
- **AND** its items remain in the library

#### Scenario: A maintenance action fails
- **WHEN** a rename, removal or delete fails on the server
- **THEN** the list returns to its previous state
- **AND** the failure is surfaced

### Requirement: Destructive actions confirm, and say what they affect

Deleting a list or removing an item SHALL confirm first, and the confirmation
SHALL make clear that the underlying books and episodes are not being deleted.

#### Scenario: Confirming before acting
- **WHEN** the listener chooses to delete a list or remove an item
- **THEN** a confirmation is shown before anything is sent

#### Scenario: Deleting a collection affects everyone
- **WHEN** the listener deletes a collection
- **THEN** the confirmation says how many books it holds
- **AND** it does not describe the collection as personal to the listener

#### Scenario: Deleting a playlist affects only the listener
- **WHEN** the listener deletes a playlist
- **THEN** the confirmation reflects that only their own playlist is affected

### Requirement: No reordering affordance until reordering exists

A list view SHALL NOT present a control that implies its items can be reordered,
unless reordering is actually implemented.

#### Scenario: Viewing playlist rows
- **WHEN** the listener views a playlist
- **THEN** no drag handle or other reorder affordance is shown

### Requirement: Creating stays where it already is

A browse screen SHALL NOT introduce a second way to create a list. Where a
client already has one, the browse screen SHALL route to it.

#### Scenario: Creating from the browse screen
- **WHEN** the listener chooses to create a list
- **THEN** the client's existing create flow is used

### Requirement: Consistent across clients

Mobile, the hosted web app and the self-hosted web app SHALL offer the same list
capabilities for a given kind. A list maintained on one SHALL read the same on
the others.

#### Scenario: Same actions on any client
- **WHEN** a listener views a list on mobile, hosted web or self-hosted web
- **THEN** browse, view, rename, remove-an-item and delete are available on each

#### Scenario: A list maintained elsewhere
- **WHEN** a listener maintains a list on one client and opens it on another
- **THEN** the change is reflected
