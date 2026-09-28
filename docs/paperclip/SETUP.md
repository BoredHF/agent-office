# Browser-safe connected office setup

AGE-18 builds on the AGE-17 factory/refresh boundary and AGE-12 read provider. Server embedding configuration adds `connectedProvider.setupScopes(): readonly {connectionId, companyId, projectId}[]`. This explicit trusted allowlist is optional: absent configuration returns an empty catalog. The existing `resolveConnection(scope)` remains the only source of credentials and origins. No CLI credential provisioning is added.

The application currently authorizes every logged-in member (including shared-password guests) to create and access offices. Setup uses that same boundary. There is no new per-user company ACL: each allowlisted scope must be approved for this application's entire signed-in audience. Configure a narrower deployment if that audience cannot share these scopes. Reconnect neither grants permission nor provisions credentials.

## Exact UI contract

- `GET /api/paperclip/catalog` requires the normal session cookie. Response: `{projects: [{connectionId, companyId, projectId, name}]}`. Group these rows by connectionId/companyId for selectors. `name` is the validated upstream project name. Only configured tuples with successful current upstream scope/read validation appear. Revoked, unavailable and foreign-company scopes are omitted; an empty catalog is `{projects: []}`. Credentials, origins, raw upstream data, and resolver errors are never returned.
- `POST /api/paperclip/offices` requires session cookie and same-origin `Origin`. JSON body is exactly `{requestId, name, connectionId, companyId, projectId}`. Request ID: 1–100 ASCII letters, digits, underscores or hyphens; name: nonblank, at most 100 characters. No extra keys. Response 200: `{officeId, scope: {mode:'paperclip', officeId, connectionId, companyId, projectId}}`. Use existing `{t:'floor.go', floor:officeId}` after success.
- Keep the same requestId and payload when reconciling a lost creation response. The request key is scoped to account ID (or the shared-password principal) and saved with the office. Concurrent and post-restart identical submissions return the same office. Changed payload or archived office produces 409, never a new office. Even duplicate requests revalidate current remote authorization. No automatic remote write retry exists; setup performs only GETs upstream.
- HTTP errors: 401 missing/revoked session; 403 cross-origin POST; 400 invalid request shape; 409 unavailable scope or request conflict; 503 unavailable catalog or saved office that cannot open. Error DTO is `{error:string}` with fixed safe text. A saved office that fails to open can be reconciled with the same request ID.
- Existing WebSocket `{t:'orchestration.refresh', officeId, visible:boolean}` returns `{t:'orchestration', snapshot}`. New `{t:'orchestration.reconnect', officeId}` disconnects/clears the old provider, rechecks the trusted allowlist/resolver and remote scope using a fresh read provider, and returns the same snapshot DTO. Failures use existing toast messages and leave the office disconnected. Reconnect requires the sender to still occupy that office; late completion after leaving, session revocation or provider replacement is discarded. Clients must discard snapshots not matching their full active scope.

## Limits and implementation boundaries

This is explicit configured-scope discovery, not arbitrary upstream company enumeration. At most 100 setup scopes are accepted in a catalog. Validation uses the existing bounded read provider (including project ownership, tasks, optional agents/activity), so a project whose required task reads are denied cannot be selected. Catalog validation is sequential and fresh; large catalogs can be slow. Optional agent/activity denial can still yield a permitted project. Resolver implementations must recognize the reserved validation office IDs `setup-catalog` and `setup-create` as well as actual persisted office IDs. Scope permission must be independent of a not-yet-created office ID.

Connected creation persists the binding before opening the floor and never initializes git, workers, queues or meetings. Existing local creation remains unchanged. Reconnect changes only the connected provider; it cannot change office mode. No timers, command forwarding, permissions or deployment changes are included. READS.md contains transport, pagination and consistency limits. Tests use a real application HTTP/WebSocket server with deterministic upstream transport; they do not prove deployed identity behavior or browser UI acceptance.

## Reproduce

```sh
npm run build:client
node --import tsx --test tests/paperclip-setup.test.ts tests/paperclip-reads.test.ts tests/paperclip-contract.test.ts tests/orchestration.test.ts tests/connected-office.test.ts
npx tsc -p tsconfig.server.json --noEmit
npx tsc -p tsconfig.client.json --noEmit
git diff --check
```

Expected: 35 passing tests. Setup fixture covers missing auth, cross-origin writes, extra credentials/origin keys, foreign connection/company/project IDs, upstream foreign ownership, empty catalog, revoked credentials, concurrent duplicate creation, payload conflicts, durable restart deduplication, authentication halt/reconnect, resolver removal, stale office context and late reconnect suppression, secret-free responses and no local provider CLI invocation. The integrated lifecycle fixture separately proves untouched local sentinel state, startup/restart isolation and delayed-refresh suppression. Office Engineer owns setup UI integration/browser acceptance; Office QA owns independent reproduction. This branch is for draft PR review only.
