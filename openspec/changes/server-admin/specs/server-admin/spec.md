## ADDED Requirements

### Requirement: Access follows the server account type

Server Admin SHALL be offered to a user when, and only when, their account on the
connected server has the type `admin` or `root`. The control plane link role SHALL
NOT decide access.

#### Scenario: Invited admin
- **WHEN** a user linked with role `user` has an `admin` account on the server
- **THEN** the Server Admin entry is shown

#### Scenario: Link admin without server rights
- **WHEN** a user linked with role `admin` has a `user` account on the server
- **THEN** the Server Admin entry is not shown

#### Scenario: Rights removed during a session
- **WHEN** an admin screen receives a 403 from the server
- **THEN** the area shows "Admins only" and does not retry

#### Scenario: Switching servers
- **WHEN** the active server changes
- **THEN** access is decided again for the new server, and admin screens reset

### Requirement: Writes go to the server they were loaded from

A write SHALL only be sent to the server its screen loaded from.

#### Scenario: Server changes with a form open
- **WHEN** the active server changes while an admin form holds unsaved edits
- **THEN** the form is reset and nothing is sent to the new server

### Requirement: Risky actions are confirmed by severity

Actions SHALL be protected by how hard they are to undo. Severe actions SHALL
require the user to type the name of the target, or the count for bulk actions.

#### Scenario: Severe action
- **WHEN** an admin deletes a library
- **THEN** the sheet states what will be lost, and Delete stays disabled until the library name is typed

#### Scenario: Reversible action
- **WHEN** an admin starts a library scan
- **THEN** it runs with no confirmation and shows a toast

#### Scenario: Protecting the admin's own account
- **WHEN** an admin views their own account or the root account
- **THEN** the options that would disable or delete it are not offered

### Requirement: Failures are visible

Admin screens SHALL show failures and SHALL NOT present a failed or unknown result
as success or as empty data.

#### Scenario: Unconfirmed write
- **WHEN** a write times out with no response
- **THEN** it is not retried automatically, the admin is told it could not be confirmed, and the data reloads

#### Scenario: Feature missing on this server
- **WHEN** a route returns 404
- **THEN** the screen says the feature is not available on this server

### Requirement: Secrets are handled with care

Tokens shown once SHALL be presented with a copy action and a clear note that they
will not be shown again. Password and token fields SHALL be masked.

#### Scenario: Sending a secret over plain http
- **WHEN** the current connection is not https and a screen is about to send a password or token
- **THEN** the screen shows a warning before it is sent

### Requirement: Live views stop when not in use

Polling SHALL pause when the app is in the background or the screen is not focused.

#### Scenario: Backgrounding the app
- **WHEN** the app is backgrounded on the Tasks screen
- **THEN** polling stops, and resumes with a fresh read on return

### Requirement: Web-only sections are named

Sections kept on the web SHALL appear as rows that say so and open the web panel,
rather than being silently missing.

#### Scenario: Opening a web-only section
- **WHEN** an admin taps Authentication
- **THEN** the web panel opens on that section

### Requirement: Restores recover on their own

After a restore, the app SHALL wait for the server and reconnect without the admin
having to restart the app.

#### Scenario: Backgrounded during restore
- **WHEN** the app is backgrounded during a restore and later reopened
- **THEN** it shows the server's real state and reconnects once the server is back
