## Context

**Two meanings of "admin", plus a third.**

| Name | Where it lives | What it controls |
| --- | --- | --- |
| ABS account type (`admin`, `root`) | `GET /api/me` `.type` | Every ABS admin endpoint, and `/hs/*` admin routes (`isAdmin`, `requireAbsAdmin`) |
| Link role (`admin`, `user`) | Control plane `links.role`, returned by `/servers` and in the grant | Only control-plane actions, such as `reset-secret` and control-plane invites (`control-plane/src/routes/servers.ts:303,448,499,524`) |
| Platform admin | `platform_admins` table | The `/admin` staff area. Out of scope |

`/hs/hosted/connect` also returns the link role (`server/routes/hosted.js:209`), so
the connect response cannot be used to find the ABS type.

**How mobile reaches a server.** It only connects through `/hs/hosted/connect`
(`src/api/connect.ts:47`), so a server mobile can reach always has the HearthShelf
backend, and is always paired. Bare ABS is not a mobile case. That removes most of
the web panel's "what if there is no `/hs`" branching, though single routes can
still be absent or turned off, so screens keep degrading.

**What mobile does not have, compared with web.**

- No React Query. The repo uses module stores with `useSyncExternalStore`, and
  screens load with `useEffect` (`app/settings/integrations.tsx`). Admin data is
  screen-local and does not need a new library.
- No socket client. This costs nothing: web's admin panel polls too (tasks 5s,
  task logs 3s, presence 30s).
- `absRequest` is private to `src/api/abs.ts`, has a 6s default timeout, and sets
  `Content-Type: application/json` on any request with a body, which breaks
  multipart and raw zip uploads.
- No test runner and no test files. `tsc --noEmit` and eslint are the automated
  checks. Core is where pure logic can be tested.

**What mobile already has:** `settingsControls.tsx` (rows, toggles, segments),
`confirm.ts`, `Toast`, `states.tsx` (skeleton, empty, error), `usePagedList`,
`@gorhom/bottom-sheet`, `react-native-draggable-flatlist`, `expo-clipboard`,
`expo-document-picker`, `expo-file-system`, `expo-crypto`, `react-native-svg`,
`expo-web-browser`.

## Goals / Non-Goals

**Goals:**
- An admin can do the common jobs from a phone without opening a browser.
- The door appears for exactly the people the server will obey.
- Risky actions are harder to do by accident on mobile than on web.
- Shared logic lives in core once.

**Non-Goals:**
- Parity with `/config`. The triage table in `proposal.md` is the scope.
- Self-hosted-only pages (Connected Apps, Import & Merge, Logs).
- A server-side folder browser for library paths.
- Offline admin. Admin needs a live connection and says so.
- Push alerts for server problems. A good later change, not this one.

## Decisions

### 1. Gate on ABS type, and keep the link role separately

`activeRole` keeps its name and its `'admin' | 'user'` shape, but its value comes
from `/api/me`: `admin` or `root` becomes `'admin'`. All four consumers (settings
index, navigation settings, `AppTabBar`, `MoreMenu`) then become correct with no
edits.

The progress store already calls `getMe()` (`src/store/progress.ts:475`), so the
type is recorded there, next to `setMeId` in `src/api/me.ts`, rather than adding a
second heavy `/api/me` call. Add `getMeType`, `setMeType`, `clearMeType` and a
subscribe, cleared on server switch. Cache the last value per server so the door
does not flicker at launch. The server stays the real authority, so a stale cached
value costs at most one 403.

The link role is no longer read by the app. The control-plane actions that need it
(`reset-secret`, control-plane invites) are web only in this change, so a phone
field for it would be dead code. Add one if such an action ever comes to the phone.

The saved-session launch path never reaches the connect code, so it restores the
cached type itself. `getMe` only records the type if the active server did not
change while it was in flight.

*Alternative rejected:* have `/hs/hosted/connect` return the ABS type. It is a
cleaner source, but the cached fast path holds the link role, it needs a server
release before mobile can rely on it, and `/api/me` is already being fetched.

### 2. Flat routes with a guard on each screen

`app/settings/admin.tsx` becomes a folder of screens registered in the existing
settings stack (`admin/index`, and so on). A nested stack was rejected: the first
screen of a nested native stack can lose its back button on iOS, and flat routes
keep the header and back behaviour of every other settings screen. `hideTabs` in
`settings/_layout.tsx` already matches the `/settings/admin` prefix, and the nav
item href stays the same.

Every screen wraps its content in `AdminGate`. Non-admins get "Admins only", which
also covers a deep link. The home passes `fresh`, re-reading the account type on
open, so a demotion is noticed at the door. Inner screens notice one through a 403.

`AdminGate` keys its children on the server id, so a server change remounts the
screen. That discards form state, which is what guarantees an edit made against one
server is never saved to another. It deliberately does not block on connection
state, so a brief reconnect does not throw away a half-filled form.

```
app/settings/admin/
  index.tsx             home: status tiles + section list
  stats.tsx  sessions.tsx  tasks.tsx  rss.tsx
  users/index.tsx  users/[id].tsx  users/invite.tsx  users/bulk.tsx
  libraries/index.tsx  libraries/[id].tsx  libraries/new.tsx
  general.tsx  community.tsx  notifications.tsx  metadata.tsx  apikeys.tsx
  email.tsx  connect.tsx  backups.tsx
  service-accounts.tsx  integrations.tsx  questgiver.tsx
```

### 3. One admin transport

Export a thin `adminRequest` from `src/api/abs.ts` built on `absRequest`, so every
admin call, including `/hs/*`, gets the 401 refresh and replay. Web's `/hs`
fetchers lack that, and mobile's `absRmab.ts` raw-fetch pattern should not be
copied here.

- **Timeout:** 15s for admin calls. Slow-by-design calls (`matchall`, backups,
  scans, archive) pass their own. Raising it for admin only leaves the 6s default
  and the offline fallbacks untouched.
- **Do not auto-retry writes after a timeout.** `absRequest` turns an abort into
  "unreachable", but a timed-out write may have worked. The UI says "We couldn't
  confirm that. Refresh to check." and reloads the data.
- **`Content-Type`:** only set the JSON header when the body is a string.
- **Errors:** unlike the rest of the app, which swallows errors into neutral
  values, admin screens show them. A hidden failure is fine for a shelf, and wrong
  for an admin who thinks a user was disabled. Reads show `ErrorState` with Retry,
  writes show a toast with what failed, and route-level 404s render "not available
  on this server".

API modules live in `src/api/admin/` by section (`users.ts`, `libraries.ts`,
`backups.ts` ...). Endpoint strings and pure mapping come from core.

### 4. Share logic through core, not the API wrappers

Web's wrappers take an `AbsTarget`. Mobile's read a module session. Forcing them
together means an injected transport across a large surface, and web's own seam
for this (`src/admin/adminDataSource.tsx`) has no callers and drops PUT. So:

**Move to core:** admin types (`JobRun`, `ABSAdminSession`, notification, email,
RSS, server stats, hosted config shapes), an endpoint map, `defaultPermissions`,
permission and type tables, type-change reseeding, the human/service account
filter, presence and last-seen folding, bulk patch guards, `SCANNER_TOGGLES`,
library settings and diff (`settingsFromLibrary`, the diff inside `submit`),
`METADATA_SOURCES`, `fmtBytes`, job formatters, `SCHEDULE_PRESETS`, schedule-off
derivation, backup filename parsing, `EXPIRY_OPTIONS`, `isHostedOutage`,
activity bucket helpers, `parseRmabLoginTokenInput`, `rmabUrlMismatch`.

**Leave in each client:** request wrappers and UI.

*Alternative rejected:* one shared admin client in core. Better long term, but it
would block the first phone screen on rewriting web's admin data layer.

### 5. A small data hook, no new library

`useAdminResource(load, { pollMs })` in `src/admin/` returns
`{ data, loading, error, reload }`. It drops stale responses, pauses polling when
the app is backgrounded (`AppState`) or the screen loses focus, and on a 403 or 404.
Lists use the existing `usePagedList`. Server changes are handled by `AdminGate`
(decision 2).

### 6. Protect risky actions by how bad they are

| Level | Example | Mobile behaviour |
| --- | --- | --- |
| Reversible | Scan, toggle a rule, run a task | No confirm. Toast |
| Risky | Disable a user, close a feed, kill a task, remove an e-reader, resend an invite | `confirm()` naming the target |
| Severe | Delete a user or library, remove folder, remove metadata files, restore a backup, bulk permissions | `TypedConfirm`: a sheet that spells out the result and needs the name typed |

Mobile adds confirmation where web has none: RSS close, task kill, e-reader
removal, bulk apply, inviting with the admin role, password reset. Keep web's own
guards: no disabling yourself, no deleting yourself or root.

Secrets: passwords and tokens use `secureTextEntry`. A shown-once token uses a
`SecretReveal` component with copy, and leaves the clipboard alone otherwise.
Local connections can be plain http on the LAN (`candidates.ts`), so a screen
sending a password or token over http shows a one-line warning.

### 7. Keep Advanced mode out

Web's Advanced toggle only guards server versions, reset secret, task kill and the
debuggers. On mobile, versions are always shown, kill sits behind a confirm, and
the rest are web only. There is no toggle.

### 8. Reorder and form shapes

- Web's library and folder reordering uses HTML5 drag, which fails on touch. Use
  `react-native-draggable-flatlist`, and add up/down in the row menu for
  accessibility.
- The five-tab library modal becomes a drill-down: rows for Details, Settings,
  Scanner, Schedule and Tools, each its own screen or sheet, keeping one shared
  draft with one Save.
- Tables become cards. Web's phone CSS for the users table is a good reference for
  which fields matter.
- Library schedule offers presets, with raw cron behind a "Custom" option.

### 9. Backups: stream, never buffer

Web buffers whole files as Blobs. Mobile must not. Download to a file with
`expo-file-system` and hand it to the share sheet with `expo-sharing`. Upload from
`expo-document-picker` with a native file upload. `POST /hs/archive` is a POST
download, so confirm the downloader supports it during the spike (task 5.1). If it
does not, add a server route that issues a short-lived GET.

Restore replaces the database and restarts the server, which may invalidate the
app's own token. After a restore the screen shows "Server restarting", waits, then
goes through the normal reconnect. The app must survive being backgrounded during
this, so the state comes from the server, not a timer.

## Risks / Trade-offs

- **ABS API keys and admin routes.** The whole plan assumes a per-user API key can
  call every admin route. Web uses the same key, which is good evidence, but
  phase 0 verifies it against a live server before anything is built on it.
- **Restoring from a phone.** Severe and hard to recover from if the phone drops
  mid-way. Mitigated by typed confirm, and by the restore running on the server.
  Upload-and-restore comes last and can be cut.
- **Drift.** Each web admin change now needs a mobile thought. Core sharing limits
  this to UI.
- **`b64Param`** uses `btoa(unescape(...))`. Mobile already uses `atob`, but
  `unescape` on Hermes is unverified. Replace it with a UTF-8 safe encoder in core,
  so tag names with accents work.
- **Size.** Users and Libraries are the bulk of the work. Each phase ships alone,
  so the area is useful after phase 1, and rows for later sections stay "Soon".
