# Installed Paperclip contract — package A

Verified 2026-09-28 against the assigned instance over direct HTTPS, using the current Connector Engineer run identity for research only. Approved source: [AGE-9 plan](/AGE/issues/AGE-9#document-plan), revision 1, `12c37805-d0dc-4bf7-8c38-cfaffdd2fd9b`. Repository base `7f200ded993d381b536a74bd1f3b72cab769b1fd`. `evidence.json` pins the full installed OpenAPI by SHA-256; API `info.version=1.0.0` alone is not a compatibility guarantee.

## Evidence levels and capability matrix

All live probes were GETs within the assigned company. No real tasks, keys, permissions, timers, or remote records were created/changed to test behavior. Ordinary task coordination is separate. Live results prove the run identity only, not a future connector key. Fixtures retain selected structural fields with consistent replacement IDs; text, names, configs, environment, metadata, URLs and credentials are excluded. They are deliberately projections, not full response recordings.

Paths below are relative to `/api`. C = configured company, P = bound project, I = issue, A = agent.

| Capability | Endpoint | Installed evidence | Connector decision |
| --- | --- | --- | --- |
| List agents | GET companies/C/agents | 200 array, six agents at capture | Read candidate; agents are company scoped, not project owned. Never expose adapterConfig/runtimeConfig/metadata. |
| List projects | GET companies/C/projects | 200 array, one project | Read candidate; omit env/workspaces/raw configuration. |
| List tasks | GET companies/C/issues | 200 array, 16 records in project at capture | Require project filter and revalidate every returned company/project. |
| Task detail | GET issues/I | 200 for assigned and prerequisite tasks | Validate company/project before projecting detail. |
| Comments | GET issues/I/comments | 200 array; empty current thread; order=asc&limit=1 returns one on completed controls task | Read candidate; cursor semantics below. |
| Activity | GET companies/C/activity?limit=1 | 200 one-element array | Company activity is not automatically office activity. Resolve entity to scoped task/project before displaying. |
| Configuration discovery | GET companies/C/agent-configurations | 403, deny_missing_grant, agents:suggest-changes | Permission-limited; never infer from job title or agent-list success. |
| Board keys | GET board-api-keys | 401 Board authentication required for this agent | Board-only identity boundary; not equivalent to invalid agent credentials on all endpoints. |
| Agent keys | POST agents/A/keys; DELETE agents/A/keys/K | Declared in installed schema; no mutation probe | Long-lived revocable service identity candidate; provision only through approved admin workflow. |
| Board keys | POST board-api-keys; DELETE board-api-keys/K | Declared board-only; optional expiresAt/requestedCompanyId | Human-associated identity candidate; no lifecycle or scope enforcement claim yet. |
| Create task | POST companies/C/issues | Route declared; installed request schema is empty | Disabled pending isolated authorization, idempotency and attribution tests. |
| Assign/status | PATCH issues/I | Fields declared, native enums confirmed | Disabled; no expectedVersion/If-Match contract established. |
| Comment | POST issues/I/comments | clientRequestId UUID and onBehalfOfUserId declared | Disabled until dedup/attribution behavior is tested with deployed identity. |
| Wake/pause/cancel/hire/instructions/terminal | Various control routes; no command probes | Not validated by this package | Disabled; canonical Paperclip UI for supported upstream operations. No remote terminal claim. |
| Missing credentials | GET companies/C/projects without Authorization | 401 Unauthorized | Stop auth retries, require reconnection. |

Installed OpenAPI describes these successful lists as generic objects (`additionalProperties`) while the server returns arrays. Many query parameters are absent from it. `installed-schema.json` is an exact selected-path extract; `observed.json` records sanitized actual structures. Validate against the narrow runtime projection; do not generate and blindly trust an object-shaped SDK from this schema.

## Filters, pagination and completeness

Live issue probes verified `projectId`, `status=done`, `assigneeAgentId`, `q` yielding an empty result, and `limit`. Three consecutive probes against six completed records established `limit=1&offset=0` and `limit=1&offset=1` match positions zero and one of the full completed list. Offset is observed on this installation, although absent from the installed OpenAPI and public issue filter table. It is a result window, not a snapshot cursor. No maximum limit, stable tie ordering, total count or next-page token was established. Concurrent updates can shift offsets; C must deduplicate by ID, bound page count/response size and report incomplete/stale sync if pages repeat or a bound is reached. Never interpret one capped list as complete.

For the pilot, full project-scoped bounded reads are an alternative for small projects, but must surface truncation. `includeRoutineExecutions=true` was accepted on the full project read; no routine records existed to establish its inclusion behavior. Public documentation says routine executions are excluded by default. Verify this flag with an isolated fixture before claiming all-task completeness.

Public comments documentation specifies `after`/`afterCommentId`, `order` and limit capped at 500. Only order/limit were live-tested here; C must test cursor traversal. Project and agent collections returned arrays without cursor metadata; pagination for large collections is unverified. Activity limit worked, but project filtering, paging and replay guarantees are unverified. Do not assume streaming or webhooks.

## Identity, authorization and human attribution

Supported mechanism evidence: installed security schemes advertise Agent API Key or Agent JWT; agent key create/delete routes exist and public authentication documentation identifies persistent agent keys. The installed schema also advertises Board API Key and board create/revoke routes, including optional expiry. No key was provisioned, granted new rights, fetched, or revoked here. Therefore deployment revocation behavior remains a release gate, not a passed test.

Recommended service design: an explicitly approved dedicated connector identity, separate from a working engineer, credential in server secret storage, company/project binding enforced by the connector and upstream policy, rotation/revocation owned by the administrator. Never deploy the heartbeat JWT or invent a run ID. Agent `task_bridge` scope appears in the key schema, but its read coverage and command eligibility have not been verified; do not select it just because it sounds narrower.

For human commands, preserve authenticated human authority. The installed schema exposes `onBehalfOfUserId`, but its presence does not permit arbitrary attribution. Public issue documentation says the responsible user is derived from authentication, and body spoofing is rejected. A shared agent key cannot be assumed to act as every office user. Prefer a supported human-bound server credential/session flow once the CEO selects the identity model and verifies its scopes. A shared board key would attribute actions to its owner; do not label those as individual office users. Local audit receipts supplement upstream attribution; they cannot replace it. No browser-supplied user ID, role or capability may confer authority.

CEO owns the identity choice and approved isolated verification environment. E must prove key revocation, membership/role denial, cross-office/company/project rejection, human attribution, run-lock behavior and task command deduplication before enabling writes. A can hand off read research without falsely claiming these gates have passed.

## Existing controls reconciliation

[AGE-4](/AGE/issues/AGE-4) authoritative implementation: `1923d4646cd15552a0fb0c95ac7831ce1e462542`, `.controls-age4`, branch `controls/age-4-integration`. [AGE-8](/AGE/issues/AGE-8) preparation: `ca2cdb6f244af6fb3f8951b1c2c8e11ea8d9e7ae`, `.controls-age8`. Both issue statuses and handoff comments were read. The main inherited workspace remains at the office core base; those concurrent worktrees were preserved.

Reuse requestId, officeId, acknowledged results, durable duplicate receipts and capability reasons from the actual AGE-4 implementation. AGE-8's types are a proposal, not a second authoritative protocol. B owns all shared protocol edits. Current local ControlResult codes (`accepted`, `stale`, `unsupported`, `invalid`, `storage_error`) lack a precise remote outcome-unknown state: B/E must add one without calling a timeout failure or success. Paperclip native priority is `critical`, not local `urgent`; B/D must explicitly map it. Preserve native task statuses; `todo` is not evidence of queued local execution, and a completed run is not task completion.

Local expectedVersion is not interchangeable with Paperclip statusVersion. Installed PATCH has no declared expectedVersion, and no compare-and-swap guarantee was proven. Existing local dispatch pause leaves active work running; it must not become a guessed remote agent pause/cancel call. Retry, queued redirect/scream and run-now are not automatically portable. Retain local-only control semantics; connected unsupported commands link to Paperclip.

## Security contract and tests

`contract.ts` is executable reference code for C, not a production connector. It restricts origins to a trusted server-configured exact HTTPS allowlist, rejects credentials/path/query/fragment origins, uses redirect:error, emits fixed errors without remote bodies, and allowlists issue projection fields. Deployment must additionally control DNS/egress; this helper does not implement DNS pinning or private-network policy. Do not accept origin allowlists from the browser.

Office QA can reproduce offline from repository root:

```sh
node --import tsx --test tests/paperclip-contract.test.ts
```

Result: 12/12 passed. Tests cover schema drift, native enums, observed offset slices, empty/malformed data, scope rejection, secret-field omission, unsafe origins, redirect and status failures, no second credential dispatch and per-operation denial. These are deterministic fixture/reference tests, not live revocation, browser security, or full connector acceptance tests. No full build was needed: production application code and shared protocol are unchanged.

For permitted live re-verification, use direct approved HTTPS, no redirect following, and a server-held research credential. GET the table's read endpoints, compare scoped list IDs across a stable status subset, and inspect HTTP status before JSON validation. Never use mutation probes on real tasks. Re-capture only allowlisted fields; raw project/agent responses can contain sensitive configuration.

## Estimates and next owners

C / [AGE-12](/AGE/issues/AGE-12): estimate 2–3 engineering sessions for validated transport/projections, scoped snapshot pagination, polling/backoff and deterministic stale/auth/reconnect tests. This excludes waiting for a provisioned deployment identity and requires B's provider boundary. D / [AGE-13](/AGE/issues/AGE-13) may use this matrix for permission-limited read setup; all unverified writes remain disabled.

E: estimate 3–5 engineering sessions after B/C and the identity decision, including durable command receipts, conflict refresh, timeout reconciliation and isolated upstream verification. No delivery date: absent generic CAS/idempotency and human credential semantics can reduce supported MVP commands or require a separate upstream decision. Begin with unknown outcomes retained for reconciliation; never silently replay writes. CEO owns scope/identity decisions, B owns protocol reconciliation, C/E own adoption, Office QA owns independent release evidence under G.

Sources: installed `/api/openapi.json` (hash in evidence.json); scoped GET observations in fixtures; [official authentication source](https://raw.githubusercontent.com/paperclipai/paperclip/master/docs/api/authentication.md); [official Issues API](https://docs.paperclip.ing/reference/api/issues/). Public sources support the design and are not proof of this installation's write behavior.
