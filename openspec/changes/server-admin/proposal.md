## Why

Server admins can only manage their server from a browser. The mobile app has a
Server Admin door (`app/settings/admin.tsx`), but it opens onto four "Soon" rows.
The everyday admin jobs are phone-sized: invite someone, fix a user's access,
scan a library, see who is listening, run a backup, close a feed.

The web panel at `/config` has 22 sections and about 10,700 lines. A straight
port would be wrong twice over: some sections are unsafe or pointless on a phone,
and the door itself is gated on the wrong field (see below).

Three things are wrong today and should be fixed here rather than built on:

1. **The door checks the wrong role.** Mobile shows Server Admin when the control
   plane link role is `admin` (`ConnectionProvider.tsx:555`). The token the app
   holds is a per-user ABS API key (`HearthShelf/server/lib/hosted.js:324`), so
   what the app may actually do is decided by the ABS account type. Those two
   disagree: an ABS admin who joined by invite never sees the door, and someone
   invited with the `admin` link role but holding an ABS `user` account sees a
   door where everything returns 403. Web already checks ABS `me.type`
   (`WebApp/src/pages/config/ConfigShell.tsx:80`).
2. **Admin logic is trapped in the web apps.** Permission tables are triplicated
   inside WebApp alone, and `fmtBytes` is copied twice. A mobile port must not
   become another copy.
3. **Several risky web actions have no confirmation.** Mobile should not inherit
   that, and a tap on a phone is easier to get wrong than a click.

## What Changes

- The admin door follows the ABS account type, including `root`.
- Server Admin becomes a real area: a home screen with live server status, then
  sections delivered in phases.
- Sections are triaged into **phone**, **slice** (the useful part only) and
  **web only** (a row that says so and opens the web panel).
- Pure admin logic moves to `@hearthshelf/core`, and WebApp switches to it.
- A shared set of admin building blocks, so sections stay small.

### Section triage

| Web section | Decision | Phase | Size |
| --- | --- | --- | --- |
| Server Stats, Library Stats | Phone | 1 | S-M |
| Listening Sessions | Phone, with infinite scroll | 1 | S |
| Tasks | Phone | 1 | S |
| RSS Feeds | Phone, adds a confirm | 1 | S |
| Users, user detail, invites | Phone | 2 | L |
| Libraries | Phone. No folder browser, typed paths as on web | 3 | L |
| General | Phone | 4 | S |
| Community | Phone | 4 | S |
| Notifications | Phone (toggle rules, Apprise fields) | 4 | S |
| Metadata Utils | Phone | 4 | S |
| API Keys | Phone | 4 | S |
| Email | Slice: e-reader devices, test send, relay status | 4 | S |
| HearthShelf Connect | Slice: health, port check, invite | 4 | M |
| Backups | Phone, with upload and archive restore last | 5 | L |
| Service Accounts | Phone | 6 | M |
| Integrations | Phone | 6 | M |
| QuestGiver | Slice: on/off toggles and status | 6 | S |
| Authentication | **Web only.** Lockout risk, one-time form | - | - |
| Queue Debugger, Series Debugger | **Web only.** Dense developer tools | - | - |
| Connect: pair, disconnect, credential reset | **Web only.** Can cut off the phone's own connection | - | - |
| Email: SMTP form | **Web only.** One-time setup | - | - |
| QuestGiver: provider, model, Copilot sign-in | **Web only.** Long setup form | - | - |
| Your Stats | Already on mobile (Stats tab) | - | - |

Platform admin (`/admin`, the `platform_admins` roster) is a separate staff tool
and is out of scope.

## Capabilities

### New Capabilities
- `server-admin`: Who can reach server administration on mobile, what they can
  do there, and how risky actions are protected.

## Impact

- **HearthShelf-Mobile:** `src/api/ConnectionProvider.tsx`, `src/api/abs.ts`, new
  `src/api/admin/*`, new `src/admin/*`, `app/settings/admin.tsx` replaced by
  `app/settings/admin/*`, `app/settings/_layout.tsx`. One new dependency,
  `expo-sharing`, in phase 5.
- **HearthShelf-Core:** new `lib/admin*.ts` modules and admin types.
- **HearthShelf-WebApp:** imports the shared logic, drops local copies. Small bug
  fixes listed in `tasks.md`.
- **HearthShelf (self-hosted):** adopts the same core logic where it has copies.
  No backend changes are expected. The `/hs/*` admin routes already enforce admin
  on the server.
