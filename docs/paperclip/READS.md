# Paperclip reads and synchronization — package C

Source: accepted AGE-9 plan revision 1, `12c37805-d0dc-4bf7-8c38-cfaffdd2fd9b`. Consumes package A `f6d0f97b04bfa6ca5686fc6ea04bc46f5a4afd78` and package B contract `1132af7480aaf2a45606f4256e364d7b7e372ede` without modifying shared files.

`src/server/paperclip/reads.ts` exports `PaperclipReadProvider`, implementing the existing `OrchestrationProvider`. The connection contains a server-only credential resolver and approved HTTPS origin. Do not serialize it, pass it from browser input, or populate it with an engineer heartbeat JWT. The configured connection/company must match the immutable office binding; each provider has separate state. The trusted company UI prefix constructs canonical record URLs. All commands remain rejected and all write/terminal capabilities false.

## Integration boundary

Construct one provider per authorized connected office with a trusted server connection registry. Call `refresh(visible)` from an authenticated office snapshot request, then emit the existing `{t: 'orchestration', snapshot}` message. `snapshot()` is synchronous and defensive; `projects()` shares the bounded refresh and returns sanitized company projects after validating the selected project. This is discovery within an existing binding, not an unauthenticated company/project picker.

No timers are installed. Visible refresh calls run at most every 5–6 seconds; inactive calls every 30–36 seconds. Simultaneous callers share a promise. Repeated failures use exponential backoff capped at five minutes; 429 Retry-After supports seconds and dates, capped at five minutes. A 401 or scope violation stops reads immediately and clears records. An authorized reconnect resets the circuit using the server resolver; replacing the binding/connection requires a new instance. Disconnect and shutdown abort in-flight work and prevent late publication. A synchronous snapshot becomes stale after 60 seconds without successful refresh.

The current application factory still selects its disconnected placeholder. Package B owns the narrow factory/configuration/refresh-route insertion; until that integration is completed, this module is tested but not reachable from the application UI. Do not report application synchronization or deployed identity verification as passed.

## Read and compatibility limits

- Tasks: project filter, observed offset/limit windows, IDs/native status/native critical priority/statusVersion, explicit field allowlist. `statusVersion` is source evidence, not a verified CAS token. Page size defaults to 100, maximum 20 pages. Short final page required. Duplicate/shifted/repeated IDs, excess rows, or exhausted bounds fail the refresh without publishing partial task state. A prior validated snapshot is retained as stale on transient/schema/incomplete errors.
- Offset traversal is not an atomic upstream snapshot. Changes that shift offsets without duplicate IDs cannot be detected reliably; periodic full refresh is eventual convergence, not a consistency guarantee. `includeRoutineExecutions=true` is sent but installed routine inclusion remains unverified.
- Projects and agents: installed array contract, company ownership validated on every record, unique IDs required, 2,000-row safety bound. Upstream pagination and truncation signaling are unverified; this module supports the pilot-sized full-array contract only. Do not claim large-collection completeness without installation-specific verification.
- Agents stay company-scoped. `activeTaskIds` contains only this project's in-progress assigned tasks. Agent native status does not imply office activity.
- Activity is a recent window of at most 100 company events; only issue events resolved against validated project task IDs are exposed. Unknown entity types and unrelated tasks are excluded. No history completeness, replay, streaming, project filter or run-terminal support is claimed. Activity text uses the action label; raw details are omitted.
- 403 on optional agents/activity yields permission-limited snapshots with allowed tasks; 403 on required projects/tasks clears cached records. Last successful sync remains historical evidence. 401 at any endpoint halts the whole provider.
- Every response is bounded to 2 MB by streaming byte count; each request has a 10-second deadline covering credential lookup, fetch and body. Bounds are server-configurable within hard limits. Errors omit raw bodies, transport messages and credentials. Redirect following is forbidden. Deployment still needs DNS/egress controls for trusted configured origins.
- All remote response fields are untrusted. DTOs are explicit projections. Existing local-mode controls and migrations are unchanged. Credentials, permission grants and recurring timers are not provisioned by this package.

## Office QA reproduction

```sh
node --import tsx --test tests/paperclip-reads.test.ts tests/paperclip-contract.test.ts tests/orchestration.test.ts tests/connected-office.test.ts
npx tsc -p tsconfig.server.json --noEmit
git diff --check
```

33 tests passed: 17 connector tests, 12 installed contract tests, 4 provider boundary/real-server tests. Tests include empty/malformed/paginated data, foreign scope, canonical links, secret omission, 401 revocation/halt/reconnect, optional and required permission failures, stale snapshots, bounded jitter/backoff, Retry-After, concurrent coalescing, disconnect race, unsafe origins/redirects, response size and body deadline. Typecheck and whitespace check passed.

These are deterministic transport simulations plus the existing disconnected-server regression; no live key revocation, deployed reads, browser connected-data flow, write authorization or production release is claimed. The integration owner must wire the authenticated seam and add a real-server read test before AGE-12 is complete. Office QA retains independent release checks under AGE-16.
