Every phase ends shippable. Run `tsc --noEmit` and eslint before each commit, and
test against the AIO test server. Use a throwaway server for anything destructive
(restore, delete library). Core changes go in `C:\code\HearthShelf-Core`, then bump
the pointer with fetch + reset, never `git pull`.

## 0. Foundations

- [ ] 0.1 Verify on a live server, with the per-user key the app holds, that one
      read and one write work for each route family: users, libraries, backups,
      api-keys, auth-settings, `/hs/jobs`, `/hs/hosted/*`. (Confirmed in ABS source
      only: `TokenManager.jwtAuthCheck` resolves a key to its user, and nothing
      treats key requests differently. The live run is still open.)
- [x] 0.2 Record the ABS type from `getMe()` in `src/api/me.ts`, cached per server,
      and reset it on server switch and sign-out.
- [x] 0.3 Set `activeRole` from that type in `ConnectionProvider`, on both the
      connect path and the saved-session launch path. (A linked `user` with an ABS
      admin account seeing the door, and the reverse, still needs an on-device check.)
- [x] 0.4 Add `adminRequest` to `src/api/abs.ts`: 401 refresh, 15s timeout, JSON
      header only for string bodies, no auto-retry of writes.
- [x] 0.5 Core: the endpoint map, `fmtBytes`, `isAdminAccountType`, and a UTF-8 safe
      replacement for `b64Param`. Core has no test runner, so these were checked with
      a script against Node's encoder. Admin types move with their phase (1.2, 1.4).
      Pointer bumped in Mobile and WebApp, and WebApp switched over.
- [x] 0.6 Replace `app/settings/admin.tsx` with `app/settings/admin/index.tsx`, as a
      flat route with `AdminGate`.
- [x] 0.7 Build `src/admin/`: `useAdminResource`, `AdminGate`, `TypedConfirm`,
      `SecretReveal`, `AdminCard`, `StatusPill`, `AdminUnavailable`, `HttpWarning`.
- [x] 0.8 Admin home: server name, versions, and sections, with unbuilt ones as
      "Soon". Web-only items open the web panel with `expo-web-browser`.

## 1. See what's happening

- [ ] 1.1 Home status tiles: users online, active sessions, library count, last
      backup, any failed task. Each tile opens its section.
- [ ] 1.2 Server Stats and Library Stats: tiles, and an activity chart with
      `react-native-svg`. Move `activityValue`, day and hour labels and
      `normalizeActivityBuckets` to core.
- [ ] 1.3 Listening Sessions: infinite scroll via `usePagedList`, delete with confirm.
      Show the user on each row, which web omits.
- [ ] 1.4 Tasks: move job types and formatters to core. List, run now, kill with
      confirm, logs in a sheet. Poll 5s and 3s, pausing in the background. Show
      "not available" rather than web's silent empty list.
- [ ] 1.5 RSS: list, close with confirm.

## 2. Users

- [ ] 2.1 Core: `defaultPermissions`, permission and type tables, type-change
      reseeding, human/service filter, presence and last-seen folding, bulk guards.
      Switch WebApp's three copies over.
- [ ] 2.2 User list: cards with presence, last seen and status, search, 30s presence
      poll. Hide service accounts.
- [ ] 2.3 User detail: info, permissions, stats, top books, finished books, sessions.
- [ ] 2.4 Edit account, permissions and password. Linked email keeps the "Change
      anyway" step. Password uses `secureTextEntry`, with confirm.
- [ ] 2.5 Enable and disable, delete with `TypedConfirm`. Never yourself or root.
      Delete uses the same route as web, and handles failure, which web does not.
- [ ] 2.6 Invites: send, copy code, copy message, resend with confirm, cancel. Read
      the invite origin from config. Confirm when inviting with the admin role.
- [ ] 2.7 Manual add user form.
- [ ] 2.8 Multi-select using the `useBookSelection` pattern, then bulk permissions
      with `TypedConfirm` showing the count.
- [ ] 2.9 Recover admins card, using `mintGrant` for its grant-authed route. Only
      show it when disabled admins exist.

## 3. Libraries

- [ ] 3.1 Core: `settingsFromLibrary`, the settings diff, `METADATA_SOURCES`,
      `ICON_OPTIONS`.
- [ ] 3.2 List with scan and force-scan, and drag reorder.
- [ ] 3.3 Create: name, type, typed path with Check. Block adding a path that fails
      the check, and fix the same bug in web (`LibraryEditModal.tsx:227`).
- [ ] 3.4 Edit drill-down: Details, Settings, Scanner, Schedule with presets, Tools.
      One draft, one Save. Metadata precedence via drag plus up/down.
- [ ] 3.5 Severe actions with `TypedConfirm`: delete library, remove folder, remove
      metadata files. Match all with confirm and a long timeout.

## 4. Server settings

- [ ] 4.1 General: server name, scanner toggles, date format, versions. Handle save
      errors, which web misses (`ConfigServerInfo.tsx:315`).
- [ ] 4.2 Community: defaults, kill-switches, telemetry with payload preview. Confirm
      the `community-config` verb first. Show "unavailable", not web's misleading
      disabled defaults.
- [ ] 4.3 Notifications: Apprise fields, rule toggles.
- [ ] 4.4 Metadata Utils: virtualized tags and genres, rename sheet, delete confirm.
- [ ] 4.5 API Keys: cards, create with `SecretReveal`, revoke confirm.
- [ ] 4.6 Email slice: e-reader devices, test send, relay status. SMTP form is a web
      link. Fix web's copy about turning the relay off (`ConfigEmail.tsx:236`).
- [ ] 4.7 Connect slice: service health, port check, connection state, keeping the
      "broker down" and "box unreachable" distinction. Share invite with 2.6.

## 5. Backups

- [ ] 5.1 Spike: `expo-sharing` install, large file download, POST download for
      `/hs/archive`, native multipart upload, raw zip upload.
- [ ] 5.2 Core: `SCHEDULE_PRESETS`, schedule-off derivation, filename parsing.
- [ ] 5.3 ABS and HearthShelf backup lists, run now, delete, schedule and keep count,
      honoring env-locked fields, and the schedule-off warning.
- [ ] 5.4 Download to file, then share sheet, with progress.
- [ ] 5.5 Restore with `TypedConfirm`, then "Server restarting" and reconnect. Test
      backgrounding the app during a restore, and token loss after one.
- [ ] 5.6 Upload a backup, and full archive restore. Cut these if 5.1 goes badly.

## 6. Setup sections

- [ ] 6.1 Service Accounts: list, create, edit, untag, delete, tokens. Generate
      passwords with `expo-crypto`. Handle the half-done state when the tag step
      fails after the ABS write.
- [ ] 6.2 Integrations: ReadMeABook, Audplexus, Audible, custom providers (read-only),
      env locks. Move the token parser and URL check to core.
- [ ] 6.3 QuestGiver slice: on/off toggles and provider status, rest links to web.

## 7. Finish

- [ ] 7.1 Confirm no "Soon" rows remain, and web-only rows land on the right page.
- [ ] 7.2 Add section names to settings search keywords.
- [ ] 7.3 Pass over accessibility, phone width, light and OLED themes.
- [ ] 7.4 Document the area on docs.hearthshelf.com, including what stays web only.
