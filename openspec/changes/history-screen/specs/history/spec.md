## Purpose

The listener's own record of what they have listened to and what they have
finished, and the ability to correct a session that misrecords what actually
happened.

## ADDED Requirements

### Requirement: Two views of history

The History screen SHALL offer two views - listening sessions, and finished
books - and SHALL make clear which is showing.

#### Scenario: Default view
- **WHEN** the listener opens History
- **THEN** the sessions view is shown

#### Scenario: Switching views
- **WHEN** the listener switches to the books view
- **THEN** finished books are shown instead of sessions
- **AND** switching back returns to sessions

### Requirement: Sessions view

Sessions SHALL be listed newest first, grouped by the day they occurred, each
showing the book, the device, the time of day, and how long was listened.

#### Scenario: Viewing sessions
- **WHEN** the sessions view loads
- **THEN** sessions appear newest first under day headings
- **AND** each row shows book, device, start time and duration

#### Scenario: Recent days read naturally
- **WHEN** a session occurred today or yesterday
- **THEN** its heading says so rather than showing a date

#### Scenario: Opening a session's book
- **WHEN** the listener taps a session row
- **THEN** that book's detail opens

### Requirement: Books view

Finished books SHALL be listed newest first, grouped by month, each showing when
it was finished and how many times it has been finished if more than once.

#### Scenario: Viewing finished books
- **WHEN** the books view loads
- **THEN** finished books appear newest first under month headings
- **AND** each shows its finish date

#### Scenario: A re-read book
- **WHEN** a book has been finished more than once
- **THEN** its row shows how many times

#### Scenario: The completions source is unavailable
- **WHEN** the server cannot provide finished-book history
- **THEN** the books view explains that rather than showing an empty list
- **AND** the sessions view still works

### Requirement: Loading more by scrolling

Both views SHALL load further entries as the listener reaches the end of the
list, rather than presenting page controls.

#### Scenario: Reaching the end of the loaded list
- **WHEN** the listener scrolls to the end and more entries exist
- **THEN** the next batch loads and appends
- **AND** an indication of loading is shown while it does

#### Scenario: Reaching the true end
- **WHEN** every entry has been loaded
- **THEN** no further requests are made and no loading indicator remains

#### Scenario: A page fails to load
- **WHEN** loading the next batch fails
- **THEN** already-loaded entries stay on screen
- **AND** the listener can retry

### Requirement: Summary figures state their scope

Summary figures SHALL NOT imply they describe more than they do. A figure
covering only what is currently loaded SHALL say so; a figure the server
reports for the whole history MAY be presented as a total.

#### Scenario: A server-reported total
- **WHEN** the server reports the total number of sessions
- **THEN** that figure is presented as the overall count

#### Scenario: A figure derived from loaded entries
- **WHEN** a figure is computed from the entries loaded so far
- **THEN** it is labelled to make that scope clear
- **AND** it updates as more entries load

### Requirement: Correcting a session

A listener SHALL be able to delete a session, or correct the listening time it
recorded, from the sessions view.

#### Scenario: Deleting a session
- **WHEN** the listener deletes a session and confirms
- **THEN** the session is removed and the row leaves the list
- **AND** the summary figures no longer count it

#### Scenario: Correcting a duration
- **WHEN** the listener corrects a session's duration and confirms
- **THEN** the session is updated in place rather than duplicated

#### Scenario: The account cannot delete
- **WHEN** the account lacks the server's delete permission
- **THEN** the delete action is not offered

#### Scenario: A correction fails
- **WHEN** a delete or edit fails on the server
- **THEN** the list returns to its previous state and the failure is surfaced
