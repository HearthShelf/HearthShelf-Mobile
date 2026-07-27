# Absorb parity specs

Features and fixes identified by reviewing 164 commits in `C:\code\absorb`
(Flutter/Dart ABS client) since HearthShelf-Mobile started. **Concepts only** -
nothing here is a port of their code. Absorb commit hashes are cited so the
behavior can be re-read, not copied.

Status legend: `TODO` / `IN PROGRESS` / `DONE` / `WONTFIX`

| # | Item | Size | Status |
| --- | --- | --- | --- |
| 1 | Auto-rewind after interruptions | M | DONE (needs device test) |
| 2 | Battery use while paused / backgrounded | M | DONE (needs device test) |
| 3 | Edit + delete listening sessions | M | DONE (needs device test) |
| 6 | Browse-by-letter in the car | S | HELD - do last (needs car/truck verification) |
| 7 | Show why a connection failed | S | DONE (needs device test) |
| 8 | Bookmark editor: nudge + preview | S | DONE (needs device test) |
| B1 | BUG: listening time lost when killed mid-playback | M | FIXED (needs device test) |
| B2 | BUG: offline bookmarks deleted on next sync | S | FIXED (needs device test) |
| P | Podcasts in ABS | L | RESEARCH |

**Verification boundary:** all three landed changes are typecheck-clean but touch
playback, AsyncStorage, and native car events - none of it is verifiable in this
environment. Everything below marked "needs device test" means exactly that (see
the `hearthshelf-mobile-verification-boundary` memory).

---

## 1. Auto-rewind after interruptions

*Absorb: `222a669`, per-book override `40c989f`.*

### Problem
A phone call, a nav prompt, or a pause drops you back mid-sentence. Every mature
audiobook player rewinds a few seconds on resume. We have `sleepRewind` (sleep
timer only) and no general interruption rewind.

### Behavior
On resume from pause, seek backwards by an amount scaled to how long we were
paused:

| Paused for | Rewind |
| --- | --- |
| < activation delay (default 10s) | 0 |
| 10s - 1m | 3s |
| 1m - 1h | 10s |
| > 1h | 20s |

All four values and the activation delay are settings; a single "Auto-rewind"
master toggle (default on) gates them. Per-book override lives on the book menu
and falls back to the global default.

Applies to *every* resume path: manual play, notification/lockscreen play,
car transport controls, headset button, and recovery from a transient audio
focus loss (call, nav prompt, another app's alert).

### The trap Absorb hit (read this before implementing)
A transient audio-focus duck should pause the *native player directly*, not run
the full pause path (which saves + syncs + closes state). But it must still
**stamp the pause timestamp**, or resuming from a call skips the rewind entirely.

Worse: after rewinding, our pre-rewind position is still sitting on the server.
The resume-time "is the server ahead of us?" check then sees a position ~10s
ahead, concludes another device advanced the book, and **seeks forward, erasing
the rewind**. Absorb's fix was to gate that check on a *newer server timestamp*,
not on position alone. Position-only comparison is not sufficient.

### As built
`src/player/autoRewind.ts` - a small pause-clock module, wired into the store's
two resume paths (`setPlaying` for native/lockscreen/transport, `togglePlay` for
the UI).

**No native work was needed.** Media3 (`handleAudioFocus=true`) and
AVAudioSession handle focus internally and surface a call/nav duck as an ordinary
`isPlaying=false`, so an interruption and a manual pause arrive through the same
door - which is what we want, since both should rewind.

**Absorb's server-ahead trap does not apply to us.** They had to gate their
resume-time "is the server ahead?" check on a timestamp, because a rewind makes
the local position legitimately trail the server's. HearthShelf has no such check
on resume - the only server-position comparison is in `playItemById` (new book
load), where `resetAutoRewind()` has already cleared state. Verified by reading
`playback.ts`; the hooks (`noteRewind`/`lastRewindAmount`) exist in case a resume
check is ever added.

Two suppressions, both real bugs if missed:
- **Sleep-timer stop** already rewinds (`fireStop`), so the following resume is
  suppressed - otherwise the two stack.
- **Seek while paused** is a deliberate choice of spot; `requestSeek` suppresses
  when `!isPlaying` so resuming starts exactly there.

Rewind is clamped at 0 and kept inside the current chapter (same rule as the
sleep rewind), so it can't drop you into the previous chapter. `loadTrack` and
`clearTrack` reset the clock so a pause from the previous book can't leak.

Setting: `autoRewind` (account-scoped, default on) - added to
`SETTINGS_CATALOG` in Core (`505cc0a`), rendered in the player settings sheet as
"Pick up where you left off". Step sizes are fixed in the client.

### Files
- `src/player/autoRewind.ts` (new), `src/player/store.ts`
- `src/player/PlayerSettingsSheet.tsx`, `src/store/settings.ts`
- `HearthShelf-Core/src/lib/settings.ts` (catalog entry; submodule pointer bumped)

### Acceptance
- [ ] Call mid-book, hang up: rewinds ~3s and keeps playing
- [ ] Pause overnight, resume: rewinds 20s
- [ ] Rewind is **not** undone a second later by a server sync
- [ ] Tapping pause then immediately play (< 10s) does not rewind
- [ ] Nav prompt duck does not close/reopen the ABS session
- [ ] Sleep timer fires, then resume: rewinds ONCE (not sleep + auto stacked)
- [ ] Seek while paused, then play: starts exactly at the seeked spot
- [ ] Car handoff resume rewinds once, not on both engines

---

## 2. Battery use while paused / backgrounded

*Absorb: `3500534`.*

### Problem
Timers, pollers, and listeners keep running at foreground cadence while paused or
backgrounded. Absorb found this was a real, measurable drain. We have several
candidates and have never audited them.

### Audit list
Each of these needs a "what does it do while paused / while backgrounded?" answer:

| Suspect | File | Concern |
| --- | --- | --- |
| Progress tick / `syncProgress` | `playback.ts`, `PlayerHost.tsx` | Ticking with no playback |
| Queue sync | `queueSync.ts` | Periodic pull? |
| Club sync | `clubSync.ts` | Periodic pull? |
| Connectivity watcher | `connectivity.ts` | Re-probe storms on flaky networks |
| Shake-to-extend | `shakeToExtend.ts` | Accelerometer while paused = expensive |
| Heartbeat | `lib/heartbeat.ts` | Cadence when idle |
| Subscriptions poll | `subscriptions.ts` | |
| Sleep beep timer | `sleepBeep.ts` | Should be inert with no timer armed |

### Audit result
Most of the suspect list came back **clean** - and the biggest one I predicted
was wrong. Recording both, so this isn't re-audited from scratch later:

| Suspect | Verdict |
| --- | --- |
| Shake / accelerometer | **Clean.** Already gated on `isPlaying` in both JS (`shouldListen`) and native (`shakeConditionsMet`); unregisters on pause. My "single biggest one" guess was wrong. |
| `queueSync` | **Clean.** Event-driven + debounced pushes, pulls on foreground only. No standing timer. |
| `heartbeat` | **Clean.** Foreground-only, weekly-throttled. |
| `notePops` | **Clean.** No standing timer. |
| `sleepBeep` | **Clean.** Inert with no timer armed. |
| `subscriptions` | **Clean.** No periodic work. |
| **Native progress tick** | **FIXED - the real drain.** |
| **`clubSync` poll** | **FIXED.** |
| **Connectivity bursts** | **FIXED.** |

### As built

**1. Native 1s progress tick (the big one).** `HearthShelfPlayerService`'s
`progressTick` Runnable re-posted itself every second *unconditionally* from
service start until service destroy. The body was gated on `isPlaying`, so it did
nothing while paused - but it still woke the main thread every second, for hours,
on a paused audiobook. Now it stops rescheduling when playback stops and the
play edge (`onIsPlayingChanged`) restarts it, via
`startProgressTick`/`stopProgressTick` with a `progressTicking` guard so it can't
double-schedule. The pause edge emits one final position first, so pausing still
lands the exact stop point before the tick goes quiet. Verified with
`:app:compileDebugKotlin`.

**2. `clubSync` 15s poll.** Ran whenever a club book was loaded - paused,
pocketed, overnight - and never stopped on background. Now `ensurePolling()` also
requires `foreground`; backgrounding suspends it and the `active` handler pulls
once and restarts, so the data is current the moment anyone looks.

**3. Connectivity burst debounce.** Every qualifying NetInfo event immediately
fired a reconnect probe plus two flushes; a handoff or flaky signal emits several
in a row. Now coalesced behind a 2s settle window, cancelled by both
`stopConnectivityWatch` (so it can't fire after teardown) and `pokeConnectivity`
(so a manual Retry doesn't double-probe).

The `hidden`-vs-`paused` lifecycle concern from Absorb doesn't apply - that's a
Flutter desktop-window issue; RN's `AppState` gives us `background`/`inactive`,
both handled.

### Files
`plugins/hearthshelf-auto/android/HearthShelfPlayerService.kt`,
`src/player/clubSync.ts`, `src/player/connectivity.ts`

### Acceptance
- [ ] Paused + backgrounded 30 min: no accelerometer subscription, no periodic
      network calls beyond the heartbeat
- [ ] **Paused 30 min: confirm the native tick is idle** (no 1s main-thread wake -
      this is the one worth measuring on a real battery graph)
- [ ] Pause lands the exact stop position (the final emit still fires)
- [ ] Wifi -> mobile handoff triggers at most one probe
- [ ] Playing + backgrounded still syncs progress normally
- [ ] Sleep-timer beeps still fire with the screen off (they ride the native tick,
      which only runs while playing - so they should be unaffected, but verify)
- [ ] Club room stays fresh on foreground after a long background

---

## 3. Edit + delete listening sessions

*Absorb: `9154ebd`.*

### Problem
Fall asleep with the timer off and you get a 6-hour session that wrecks your
stats, your streak, and your daily average. There is currently no way to fix it -
the Stats screen is read-only.

### Behavior
On the Stats screen, listening sessions become tappable. A session sheet offers:
- **Edit duration** - correct the listened-time
- **Edit date/time** - move a session to the right day (matters for streaks and
  the heatmap)
- **Delete** - remove it entirely

Confirm before delete. Stats, goal ring, heatmap, and streak all recompute.

### Open question - RESOLVED
ABS has **no session PATCH**. Confirmed shape:
- **Delete**: `DELETE /api/sessions/:id` (needs the user's delete permission).
- **Edit**: re-submit through `POST /api/session/local` keeping the original id,
  so the server updates in place instead of adding a duplicate. Only
  `timeListening` and the day (re-derived from `updatedAt`) are honored on an
  existing session - so those are the only two fields the UI exposes. Anything
  else would look editable and silently not save.

### As built
Landed on the **item screen's Recent Listens sheet**, not the Stats tab - that's
where sessions are already listed per book, so the edit belongs next to them.

- Long-press a session row -> `SessionEditSheet` (stacked over the list).
- Time listened: -30m / -5m / +5m / +30m chips against a live total.
- Day: ±1 day chips, clamped so a session can't be moved into the future.
- Delete behind the standard `confirm()`, with the duration + date in the prompt
  so the blast radius is explicit.
- Save is inert until something actually changes; on success the list reloads and
  `refreshProgress()` runs so stats pick it up.
- Offline rows (banked, not yet on the server) are **not** long-pressable -
  there's no server session to correct.

### Files
- `app/item/[id].tsx` - `SessionEditSheet`, row long-press, `SessionRow.session`
- `src/api/abs.ts` - `deleteListeningSession`, `updateListeningSession`

### Acceptance
- [ ] Delete a 6h sleep session; totals, heatmap, streak all update
- [ ] Move a session across midnight; it lands on the right day
- [ ] Edits survive a refresh (server-side, not local-only)
- [ ] Delete fails gracefully for a user without the server delete permission

---

## 6. Browse-by-letter in the car

> **HELD until last (2026-07-26).** Touches Android Auto + CarPlay, which can
> only be verified in an actual vehicle - so it's sequenced after everything
> that can be checked from a desk. The child-count cap below is the part worth
> doing first when this is picked up: it prevents a *crash*, and it's cheap.


*Absorb: `58f7ab8`; their large-list crashes `5db5433`, `18291d0`.*

### Problem
Car browse has 4 tabs and no answer for a large library. Scrolling 2000 books on
a head unit is unusable, and car UIs cap the number of nodes you can return -
Absorb crashed CarPlay twice on exactly this before adding letter tiers.

### Behavior
When a browse list exceeds a threshold (~100 items), insert an A-Z tier:
`Library -> [A] [B] [C] ...` -> books under that letter. Below the threshold,
show books directly - no pointless extra tap on a small library.

Group by the same sort key the list already uses (title-ignoring-articles or
author, matching the phone's sort). Include a `#` bucket for
numeric/symbol-leading titles. Omit letters with no entries.

Applies to both Android Auto and CarPlay.

### Also: cap children per node
Independent of letter tiers, clamp the number of children we return for any
browse node. Both car platforms have limits and exceeding them is a *crash*, not
a truncation. Worth doing even before the letter tiers land.

### Files
- `src/player/autoBridge.ts`
- `plugins/hearthshelf-auto/` (Android Auto native browse tree)
- iOS CarPlay browse implementation

### Acceptance
- [ ] 2000-book library browses without a crash on both platforms
- [ ] Small library (< 100) shows books directly, no letter tier
- [ ] Letter buckets match the phone's sort order
- [ ] Truck-verified (Android Auto), car-verified (CarPlay)

---

## 7. Show why a connection failed

*Absorb: `befc673`.*

### Problem
Connection failures surface as generic states ("offline", the splash, a red
icon). We have burned multiple sessions diagnosing splash/connect issues that a
visible reason would have shortened - see the `auth-gate-splash-traps`,
`launch-rehydration-deadlock`, and `stale-offline-phase-no-edge` histories.

### Behavior
Wherever a connection fails - login/connect screen, the connection gate, the sync
status sheet - show the actual reason:

| Cause | Message |
| --- | --- |
| DNS / host not found | "Can't find that server address" |
| Connection refused | "Server isn't answering on that address" |
| Timeout | "Server took too long to respond" |
| TLS failure | "Couldn't make a secure connection" |
| HTTP 401/403 | "Sign-in was rejected" |
| HTTP 5xx | "Server had an error (500)" |
| No network | "No internet connection" |

Plus a collapsed "Details" row with the raw error + the URL we tried, so a bug
report can be actionable. Keep the headline at a 6th-grade reading level.

### As built
New `src/api/connectionError.ts`: a `ConnectionError` class carrying a `kind`
(offline / dns / refused / timeout / tls / auth / server / notFound / unknown), a
plain headline as its `message`, and the raw detail + attempted URL for the
disclosure row.

The key move is **classifying at the throw site, not the render site.** The
splash already had a `friendlyError()` that regexed the message into one of two
generic lines - by then the real cause was gone. Now:
- `fetchWithTimeout` classifies transport failures, and knows whether an abort
  was *our* timeout or a real drop (which the message alone can't tell you).
- `connect.ts` classifies HTTP status, preferring the server's own error text.
- `ConnectionProvider` carries `message` + `details` on the error phase.
- The splash shows the headline and only offers "Show details" when there's
  something to show. `friendlyError()` stays as a fallback for any path not yet
  routed through `ConnectionError`, so a raw string still can't reach the screen.

Also wired into the **offline banner**: when the cause is actionable
("Offline - can't find that server", "Offline - sign-in was rejected") it replaces
the generic line. A plain no-internet keeps the default copy - the cloud-off icon
already says that, and naming it adds nothing.

The `connect_stalled` sentinel is gone; that path now says "Server took too long
to respond" with the timeout in the details.

### Files
`src/api/connectionError.ts` (new), `src/api/fetchWithTimeout.ts`,
`src/api/connect.ts`, `src/api/ConnectionProvider.tsx`, `src/ui/SplashScreen.tsx`,
`src/ui/OfflineBanner.tsx`, `app/_layout.tsx`

### Acceptance
- [ ] Bad hostname, wrong port, expired cert, and 401 each produce distinct text
- [ ] Details row carries raw error + attempted URL
- [ ] Reason survives into the offline banner (not just the login screen)
- [ ] Airplane mode still reads as plain "Offline - downloaded books only"
- [ ] A stalled connect says "took too long", not `connect_stalled`

---

## 8. Bookmark editor: nudge + preview

*Absorb: `615c6af`.*

### Problem
A bookmark set while driving is always a few seconds late. There's no way to
adjust it and no way to check what's actually at that spot without leaving the
sheet.

### Behavior
Editing a bookmark gets:
- **Nudge controls** - -10s / -5s / +5s / +10s stepping the timestamp, with the
  new time shown live
- **Listen button** - play a short preview from the (nudged) position so you can
  confirm before saving. Stop preview on sheet close; restore prior playback
  state.
- **Roomier layout** - bigger touch targets; this is frequently used in the car
  or in bed
- Title edit in the same sheet

### As built
Long-press a row in the player's Bookmarks sheet to open `BookmarkEditSheet`
(stacked over the list). A one-line hint on the list makes the affordance
discoverable - long-press is invisible otherwise, and the edit is the whole point
for a bookmark dropped late in the car.

- **Nudge**: -10s / -5s / +5s / +10s, with the new timestamp live in the sheet
  title. Buttons are deliberately tall - this gets used driving and in bed.
- **Retitle** in the same sheet.
- **Listen from here**: previews from the (nudged) spot.
- Save is inert until something actually changes.

**The preview drives the LIVE player**, not a second engine - two players would
fight for audio focus and the book is already loaded. So the sheet snapshots
position + play-state on the first preview and restores both on close, including
a swipe/backdrop dismiss (`onDismiss`), not just the buttons. The snapshot is
taken once per visit, so repeated previews all restore to where the user actually
was rather than to the previous preview.

**Interaction with item 1 (auto-rewind):** both preview and restore seek while
paused, which suppresses the auto-rewind via `store.requestSeek`. That's correct
on both legs - a preview should start exactly where the user pointed, and a
restore should land exactly where they were; neither is "resuming after a break".

**Atomic move.** ABS keys bookmarks by (item, time) with no id, so a move is a
delete plus a create. `moveBookmarkPending` writes both sides in ONE state write
before any network call - splitting it would leave a window where the old
bookmark is gone and the new one isn't recorded, and a kill in there loses it
outright. It also handles the case where the original was itself never confirmed
(drop its pending create rather than tombstoning something the server never had).

**Not added to the item screen's bookmark sheet.** That surface manages bookmarks
independently and has no player loaded to preview against; faking a preview there
would be worse than leaving it as jump/delete.

### Files
`src/player/sheets.tsx` (`BookmarkEditSheet`), `src/player/useBookmarks.ts`
(`moveBookmark`), `src/player/pendingBookmarks.ts` (`moveBookmarkPending`)

### Acceptance
- [ ] Nudge ±5/±10 updates the displayed time immediately
- [ ] Preview plays from the nudged spot
- [ ] Closing by button AND by swipe both restore prior position + play state
- [ ] Preview twice, then close: restores to the original spot, not the 1st preview
- [ ] Was paused before previewing -> still paused after closing
- [ ] Moving a bookmark while offline doesn't lose it (see B2)
- [ ] Move an offline-created (never-confirmed) bookmark: ends up with exactly one

---

## B1. BUG: listening time lost when the app is killed mid-playback

*Absorb: `22929af`. **Confirmed present in our code.***

### The bug
`src/player/playback.ts:315`:

```ts
if (!force && active.pendingListened < SYNC_LISTENED_THRESHOLD) return
```

`SYNC_LISTENED_THRESHOLD` is 15 (`playback.ts:79`). For a **streaming** (online)
book, listened-time accrues in `active.pendingListened`, which is **in-memory
only**. It reaches the server on a threshold crossing or a `force` sync
(pause/stop).

If the process dies without a graceful pause - swipe-away, OS memory kill, crash
- everything in `pendingListened` is gone. Up to 15 seconds per kill, plus
anything accrued since the last successful push if a sync had been failing (the
failure path at `playback.ts:341` rolls the time *back into* `pendingListened`,
so a book played through a dead spot can bank far more than 15s in memory).

Note the asymmetry: the **offline** path is already durable -
`recordLocalSession()` persists to AsyncStorage every tick
(`pendingProgress.ts:83`). Only the online path is exposed.

### Fix
Mirror the offline path's durability for streaming sessions: persist accrued
listened-time to AsyncStorage as it accrues, clear it when a server sync
confirms, and on next launch fold any orphaned buffer into the pending-session
ledger so the existing flush ships it.

Concretely:
1. On each tick, write `pendingListened` for the active item to a durable
   streaming buffer (same store family as `pendingProgress.ts`).
2. On a successful `pushListened`, subtract the confirmed amount (don't clear
   outright - time accrued during the in-flight request must survive).
3. At startup, before opening any new session, migrate a non-empty buffer into
   the pending-session ledger. `flushPendingProgress()` then replays it via
   `/api/session/local-all`, which we already use for offline sessions.

Worst case loss becomes one tick instead of one threshold window.

### Watch out for
- Don't double-count: the live session sync remains the reporting path; the
  buffer is a safety net, and step 2 is what keeps them from both landing.
- The 404 `reopenAndResync` path (`playback.ts:349`) also needs to reduce the
  buffer on success.
- Writing to AsyncStorage every tick is more IO than we do now - batch or debounce
  if profiling shows it matters.

### As built
Streaming safety buffer in `pendingProgress.ts` (`hs.streamingPending.v1`),
mirroring the offline path's durability:
- `setStreamingPending()` on every tick, writing the **absolute** outstanding
  amount (not a delta) so a dropped call can't drift the buffer.
- `reduceStreamingPending()` on every confirmed sync - subtracting, not clearing,
  so time accrued during the in-flight request survives. Wired into all three
  confirmation points: `pushListened`, and **both** branches of
  `reopenAndResync` (the 404 path).
- `clearStreamingPending()` on a successful `safeClose()` - a clean close banks
  everything, so the buffer is spent. A *failed* close deliberately leaves it.
- `migrateOrphanStreaming()` at startup folds survivors into the pending-session
  ledger, replayed by the existing `/api/session/local-all` flush.

`ActiveSession` gained a `title` so an orphan can be replayed as a proper
session. Migration runs in both entry points: the ordered startup chain in
`ConnectionProvider` (ledger -> buffer -> migrate, before playback can open a
session whose writes would race it) and `backgroundFlushTask` (a headless wake
right after a kill is exactly when orphans exist).

### Files
`src/player/pendingProgress.ts`, `src/player/playback.ts`,
`src/api/ConnectionProvider.tsx`, `src/player/backgroundFlushTask.ts`

### Acceptance
- [ ] Stream 10 min, force-kill the app, relaunch: the ~10 min shows in recent
      listens and stats
- [ ] Normal pause -> sync still reports exactly once (no doubling)
- [ ] Session 404 -> reopen path doesn't leave a stale buffer
- [ ] Per-tick AsyncStorage write doesn't show up in a profile (debounce if it does)

---

## B2. BUG: offline bookmarks deleted on the next sync

*Absorb: `0fc792a`. **Confirmed present in our code - and worse than Absorb's.***

### The bug
`src/player/useBookmarks.ts:28-36`:

```ts
const addBookmark = useCallback(async (time, title) => {
  if (!libraryItemId) return
  await createBookmark(libraryItemId, time, title)
  haptics.success()
  refresh()
}, [libraryItemId, refresh])
```

There is **no offline handling at all**. `createBookmark` throws when the server
is unreachable; the rejection is unhandled (`addBookmark` is awaited by callers
that don't catch), no local copy is kept, and `refresh()` never runs. The
bookmark is simply lost - the user gets a haptic-less no-op or a crash.

Absorb's variant was subtler (they *had* a pending queue, they just populated it
after the network call, so a kill mid-push orphaned the entry and the next sync
deleted it as "not on the server"). Ours has no queue to get the ordering wrong
in - the list is always whatever `/api/me` returns.

### Fix
Give bookmarks the same write-ahead treatment the rest of our sync uses:
1. **Persist the bookmark locally first**, marked pending, *before* the network
   call. This ordering is the whole point - a kill between the call and the
   bookkeeping must leave the bookmark recoverable.
2. Attempt the server create. On success, clear the pending flag.
3. On failure (offline or error), leave it pending and show it in the list as a
   local bookmark.
4. Flush pending creates/deletes on reconnect, alongside the existing
   `flushPendingProgress()` connectivity/background-task hooks.
5. Merge server bookmarks with pending-local ones when rendering, so an offline
   bookmark is visible immediately.

Deletes need the same treatment (a pending-delete set), or an offline delete
reappears on the next refresh.

### Watch out for
- ABS bookmarks are keyed by `(libraryItemId, time)`, not an id - the pending key
  must be the same pair, and a **move is a delete + a create**, so item 8's move
  operation needs both queues correct.
- Don't let a pending-create for a bookmark the user then deleted offline
  resurrect it.

### As built
New `src/player/pendingBookmarks.ts` (`hs.pendingBookmarks.v1`) holding pending
creates + delete tombstones, keyed by `(libraryItemId, whole-second time)` to
match how ABS itself identifies a bookmark.

- `addBookmarkPending()` / `removeBookmarkPending()` persist **before** the
  network call and clear on confirmation. Neither throws - a failed write is a
  pending write, not a caller's problem.
- `mergeBookmarks()` overlays pending state on the server list, so an offline
  bookmark is visible immediately and an offline delete doesn't spring back.
- Re-adding a bookmark the user deleted offline drops the tombstone (a create,
  not a no-op); deleting one that never reached the server just drops the
  pending create rather than tombstoning something that doesn't exist.
- `flushPendingBookmarks()` runs on both connectivity edges alongside
  `flushPendingProgress()`, and in the background task.

**Three** write sites were bypassing safety, not one - the audit turned up a
second delete path on the item screen doing optimistic-update-then-rollback
(same data loss, different screen) and the CarPlay create handler in
`PlayerHost`. All three now route through the store; `createBookmark` /
`deleteBookmark` have no callers left outside it.

### Files
`src/player/pendingBookmarks.ts` (new), `src/player/useBookmarks.ts`,
`app/item/[id].tsx`, `src/player/PlayerHost.tsx`, `src/player/connectivity.ts`,
`src/player/backgroundFlushTask.ts`, `src/api/ConnectionProvider.tsx`

### Acceptance
- [ ] Airplane mode -> add bookmark -> it appears in the list
- [ ] Reconnect -> it lands on the server, survives a refresh
- [ ] Airplane mode -> delete bookmark -> stays deleted after reconnect
- [ ] Kill the app right after bookmarking online: bookmark survives
- [ ] Same three checks from the CarPlay/Android Auto bookmark button
- [ ] Offline move (item 8) keeps exactly one bookmark at the new time

---

## P. Podcasts

*Absorb has built out a podcast vertical: subscriptions, auto-download
(`beece11`), episode badges (`0be92c6`), episode titles in now-playing
(`0b54d31`), a sleep-timer "end of episode" option (`efab45a`), queue/Up-Next
support (`f6beb1f`), and a listening-session fix (`2ea70b0`).*

### Status: RESEARCH

We have zero podcast support (`grep -ril podcast src` returns nothing).

ABS supports podcasts natively as a library type - a podcast library holds
podcast items, each with episodes, and ABS handles RSS feed subscription,
episode download, and episode-level progress server-side. So the ingest question
("how do podcasts get into ABS") has a supported answer: **add a podcast-type
library and subscribe to feeds by RSS URL**, either through the ABS web UI or
its API. No workaround needed.

### What to confirm before scoping
- ABS podcast API surface: item shape vs. book shape, episode listing, per-episode
  progress, feed search/add endpoints
- Whether `@hearthshelf/core` types already model podcasts (probably not)
- How episodes interact with things we've built around books: queue, downloads,
  offline catalog, Auto/CarPlay browse, stats, clubs

### Likely shape of the work
Podcasts are a second media type threading through nearly every surface we own.
This is not a screen - it's a type-level change to the catalog, player, queue,
downloads, offline store, and both car UIs. Expect it to be the largest item on
this list. Worth a dedicated design pass before any code.

### Notable smaller pieces worth lifting regardless
- Sleep timer "stop at end of episode" - our sleep timer could grow an
  "end of chapter" equivalent for books today, independent of podcasts
- Episode/chapter title in the now-playing surface rather than just the book
