## Purpose

Browsing and maintaining a library's collections: seeing what collections exist,
opening one, and keeping it tidy by renaming it, removing a book, or deleting it
outright.

## ADDED Requirements

### Requirement: Browsing collections

A listener SHALL be able to see every collection in the active library, each
identified by its name, how many books it holds, and artwork drawn from the
books inside it.

#### Scenario: Opening the collections list
- **WHEN** the listener opens Collections
- **THEN** every collection in the active library is listed
- **AND** each shows its name, its book count, and cover art from its books

#### Scenario: A collection with more books than the tile shows
- **WHEN** a collection holds more books than its tile displays artwork for
- **THEN** the tile indicates how many further books it contains

#### Scenario: A library with no collections
- **WHEN** the active library has no collections
- **THEN** an empty state explains what collections are and how to make one

#### Scenario: A large number of collections
- **WHEN** the library has more collections than the server returns by default
- **THEN** all of them are still listed

### Requirement: Viewing a collection

Opening a collection SHALL show the books it contains and how much listening it
represents, and allow starting playback from it.

#### Scenario: Opening a collection
- **WHEN** the listener opens a collection
- **THEN** its books are shown with each listener's own progress
- **AND** the collection's book count and total duration are shown

#### Scenario: Playing a collection
- **WHEN** the listener chooses Play all
- **THEN** playback starts from the collection's first book

#### Scenario: Opening a book from a collection
- **WHEN** the listener taps a book
- **THEN** that book's detail opens

### Requirement: Maintaining a collection

A listener SHALL be able to rename a collection, remove a book from it, and
delete it.

#### Scenario: Renaming
- **WHEN** the listener renames a collection and confirms
- **THEN** the new name is saved and shown

#### Scenario: Removing a book
- **WHEN** the listener removes a book from a collection
- **THEN** the book leaves the collection
- **AND** the book remains in the library

#### Scenario: Deleting a collection
- **WHEN** the listener deletes a collection and confirms
- **THEN** the collection is gone from the list
- **AND** its books remain in the library

#### Scenario: Destructive actions confirm first
- **WHEN** the listener chooses to delete a collection or remove a book
- **THEN** a confirmation is shown before anything is sent
- **AND** for a collection delete the confirmation says how many books it holds

#### Scenario: A maintenance action fails
- **WHEN** a rename, removal, or delete fails on the server
- **THEN** the collection returns to its previous state
- **AND** the failure is surfaced

### Requirement: Creating stays where it already is

The browse screen SHALL NOT introduce a second way to create a collection. Where
a client already has one, the browse screen SHALL route to it.

#### Scenario: Creating from the browse screen
- **WHEN** the listener chooses to create a collection
- **THEN** the client's existing create flow is used

### Requirement: Consistent across clients

Mobile and the hosted web app SHALL offer the same collection capabilities. A
collection maintained on one SHALL read the same on the other.

#### Scenario: Same actions on either client
- **WHEN** a listener views a collection on mobile or on the web app
- **THEN** browse, view, rename, remove-a-book and delete are available on both
