# Spec + Implementation Guide: Server Admin Credential Health (Mobile)

Status: **Proposed** (mobile has no server-administration surface yet)
Author: platform
Related: HearthShelf `server/lib/serviceCredential.js`, `@hearthshelf/core`
`HSServiceHealth`, WebApp/self-hosted `ServiceAccountHealth.tsx`

---

## 1. Why this exists

In hosted mode, a HearthShelf box provisions each invited user into ABS using a
single server-side **admin credential**. That credential used to be a perishable
ABS *session* token; when it died (its ABS user was deleted, or it expired),
**every new invitee silently failed to be created** with `ABS 401`, while
existing users kept working. The failure was invisible in the UI.

The server fix (already shipped) makes the credential a **durable API key** that
**self-heals**, and exposes its health as a state machine. The self-hosted web UI
and the hosted WebApp now show that health and let an admin repair it. **The
mobile app has no equivalent surface** - an admin on their phone cannot see that
invites are broken, nor fix it. This spec adds that.

Scope is deliberately narrow: **surface the health, and offer the same two
repair actions the web has.** This is the first server-administration feature in
the mobile app; it is not a general "server admin console."

---

## 2. Backend contract (already implemented, no server work needed)

All endpoints live on the connected server's own origin (the same origin the app
already calls for `/hs/hosted/connect`), authenticated with the per-server ABS
bearer token the app already holds after connecting. They require the caller to
be an ABS admin/root (the backend enforces this; a non-admin gets `401/403`).

### `GET /hs/hosted/service-health`
Returns `HSServiceHealth` (from `@hearthshelf/core`):

```ts
interface HSServiceHealth {
  state: 'valid' | 'stale' | 'broken' | 'absent'
  paired: boolean
  hasCredential: boolean
  canSelfHeal?: boolean
  hasServicePassword?: boolean
  absUserId?: string | null
  username?: string | null
  isService?: boolean
}
```

- `valid` - credential works; invites are created automatically. Nothing to do.
- `stale` - credential is dead but auto-recoverable (`canSelfHeal: true`).
- `broken` - dead and not auto-recoverable; needs an operator action.
- `absent` - hosted admin work isn't set up on this box; show nothing.

### `POST /hs/hosted/service-credential/reset`
Body: none. Mints a fresh durable key from the **caller's own admin session**
(the app's connected admin token). Response `{ ok: true, status: 'valid' }`.
Primary one-click fix. Errors: `502 mint_failed`, `401 unauthorized`.

### `POST /hs/hosted/service-credential/override`
Body (`HSServiceCredentialOverrideRequest`), one of:
- `{ servicePassword: string }` - a new `hearthshelf-service` password; the
  server validates it, re-syncs it, and re-mints. Error `422 bad_service_password`.
- `{ absAdminToken: string }` - a known-good admin/root token/key to store
  directly. Error `422 token_not_admin`.
Response `{ ok: true, status: 'valid' }`. Missing both -> `400 missing_input`.

`GET /hs/hosted/config` (already called by the app's connect flow indirectly)
also now returns `adminCredStatus` + `canSelfHeal` on `HSHostedConfigStatus`, so
a lightweight "invites broken" badge can be derived without a second request if
the app already fetches config.

---

## 3. Mobile UX

### 3.1 Entry point
Add a **Server** section to Settings, visible **only when the connected user is
an admin/root** on the active server (`me.type === 'admin' | 'root'`; the app
already fetches `me` via `src/api/me.ts`). If mobile has no Settings > Server
area yet, create a single screen: **"Server health"**.

Within it, a **Service account** row that reflects `state`:

| state    | row appearance                                   | tap target        |
|----------|--------------------------------------------------|-------------------|
| valid    | green check, "Invites working"                   | none / detail     |
| stale    | amber, "Reconnecting needed"                     | opens fix sheet   |
| broken   | red, "Invites are broken"                        | opens fix sheet   |
| absent   | row hidden                                        | -                 |

If `state` is `stale`/`broken`, also surface a **badge on the Settings tab / the
Server row** so an admin notices without drilling in. Optionally raise a
one-time local notification ("New members can't be added to <server>") - reuse
the existing push/local-notification plumbing in `docs/PUSH_SETUP.md`; keep it
opt-in and de-duplicated (only when transitioning into broken, not every poll).

### 3.2 Fix sheet (bottom sheet / modal)
Mirror the web `ServiceAccountHealth` component:

1. **Primary button - "Reset service credential"** -> `POST .../reset`.
   On success: toast "Fixed - members can be added again", refetch health, dismiss.
2. **"Manual options"** disclosure, shown when reset fails or on demand:
   - **New service password** field (secure text) -> `override({ servicePassword })`.
   - **Paste admin token** field (secure text) -> `override({ absAdminToken })`.
   Map error codes to copy exactly as the web does:
   - `bad_service_password` -> "That service password did not work."
   - `token_not_admin` -> "That token is not an admin/root token."
   - anything else -> "Could not update. Check the value and try again."

Both secure fields: `secureTextEntry`, `autoCapitalize="none"`,
`autoComplete="off"`, no clipboard history. Never log the token/password.

### 3.3 Copy
Match the web's plain, non-alarming language. Users see "invited people," never
"ABS 401" or "credential." "Service account" is the only slightly-technical term
and is acceptable for an admin-only screen.

---

## 4. Implementation plan

### 4.1 API client - `src/api/serverAdmin.ts` (new)
Follow the existing `src/api/connect.ts` / `src/api/social.ts` pattern: functions
take the connected server's `{ serverUrl, token }` (however the app currently
threads the active server + ABS token; see `ConnectionProvider.tsx`) and use
`fetchWithTimeout`.

```ts
import { fetchWithTimeout } from './fetchWithTimeout'
import type {
  HSServiceHealth,
  HSServiceCredentialOverrideRequest,
} from '@hearthshelf/core'

function origin(u: string) { return u.replace(/\/$/, '') }

async function hs<T>(serverUrl: string, token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetchWithTimeout(`${origin(serverUrl)}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init?.headers },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `http_${res.status}`)
  return data as T
}

export const getServiceHealth = (u: string, t: string) =>
  hs<HSServiceHealth>(u, t, '/hs/hosted/service-health')

export const resetServiceCredential = (u: string, t: string) =>
  hs<{ ok: true; status: string }>(u, t, '/hs/hosted/service-credential/reset', { method: 'POST' })

export const overrideServiceCredential = (u: string, t: string, body: HSServiceCredentialOverrideRequest) =>
  hs<{ ok: true; status: string }>(u, t, '/hs/hosted/service-credential/override', {
    method: 'POST',
    body: JSON.stringify(body),
  })
```

The `@hearthshelf/core` types are already available (the app consumes core via
the `packages/core` submodule). Bump the submodule to a ref that includes
`HSServiceHealth` + `HSServiceCredentialOverrideRequest` (added in Core commit
introducing `HSAdminCredStatus`). To bump: in `packages/core` run
`git fetch && git checkout origin/main`, then commit the updated submodule ref in
the mobile repo (do **not** edit files inside the submodule checkout in place).

### 4.2 Data hook
Add a query (React Query if the app uses it, else the app's data pattern) keyed
by server id, e.g. `['server-health', serverId]`, `staleTime` ~30s, `enabled`
only when the connected user is admin. Poll lightly (e.g. `refetchInterval` 60s
while the screen is focused; stop when backgrounded) so a broken state is noticed
without hammering the box.

### 4.3 Screens / components
- `src/screens/ServerHealthScreen.tsx` (or wherever screens live) - the row list.
- `src/components/ServiceAccountFixSheet.tsx` - the repair sheet.
Reuse existing design-system primitives (buttons, secure inputs, bottom sheet)
from the current redesign (`docs/redesign/`, `docs/material-redesign-plan.md`).
Do not hand-roll new visuals - match the in-flight Material redesign.

### 4.4 Admin gating
Gate every entry point on admin/root. A non-admin must never see the Server
section (the backend will 401/403 anyway, but the UI should not offer it).

### 4.5 Out of scope (explicitly)
- Full server admin (users, libraries, backups) - not in this spec.
- Editing pairing / hs.direct / email relay from mobile - not here.
- Any write to ABS beyond the two credential-repair endpoints.

---

## 5. Test plan

1. **valid** - healthy box: row shows green, no actions, no badge.
2. **stale** - simulate by pointing at a box whose stored credential is dead but
   whose service password is intact: row amber, Reset succeeds, returns to valid.
3. **broken** - dead credential + desynced service password: Reset fails ->
   manual options appear; a correct new service password fixes it; a wrong one
   shows `bad_service_password` copy; a pasted admin token also fixes it; a
   non-admin token shows `token_not_admin`.
4. **absent** - unpaired box: Server section hidden.
5. **non-admin** - connected as a regular user: Server section hidden; direct API
   calls (if forced) return 401/403 and are handled gracefully.
6. **security** - confirm secure fields don't leak to logs, clipboard, or crash
   reports; tokens never printed.

---

## 6. Rollout

Ship behind the existing admin gate (no separate flag needed - it's inert for
non-admins and for `absent` boxes). Land the Core submodule bump first, then the
API client, then the screen. No server deploy required (backend already live).
