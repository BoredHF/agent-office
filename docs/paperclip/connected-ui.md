# Connected office views — package D

Approved source: AGE-9 revision 1, `12c37805-d0dc-4bf7-8c38-cfaffdd2fd9b`.
Base: `1132af7` (provider boundary), including `f6d0f97` (installed contract).

The browser consumes initial and incremental provider snapshots. Incremental updates must match office, connection, company, project and mode. Entering another office clears/replaces the projection. Socket loss marks remote data stale; a new welcome restores server state.

Connected task boards, roles, hiring, terminal and meeting entry points open the connected view. It shows native task groups (including unknown future states), assignments, agents and project task counts, activity, last sync, stale/disconnected/permission-limited evidence, and canonical record links. Run completion never moves tasks between status groups. All remote writes remain unavailable in accordance with package A's unverified authorization matrix. HTTPS record URLs reject embedded credentials and query parameters. Remote content is rendered as text, not HTML.

Dialog focus starts on Close, traps Tab, restores the opener, follows a surviving record link across refresh, and closes on office switch. Wrapping text and a constrained modal support narrow screens. Browser QA remains required; these accessibility behaviors are implemented but have not been independently browser-verified.

## Server-backed setup and refresh

Integrated AGE-18 setup contract revision 3aaa0428-c73f-4f8f-8c38-75bc84b69059 from PR #5 (published 60e1223b430a39880df7f28c47944bd85cd72b33; local equivalent 3f27753). Offices → Connect Paperclip office loads the authenticated catalog and groups selection by connection/company/project. Only IDs and validated project names enter the browser. Existing local creation remains available.

Creation freezes the exact payload and request ID. Failed, timed-out or malformed responses retain it for reconciliation; closing/reopening and same-tab reload retain it in sessionStorage when available. Fields remain locked until a verified matching response returns. No optimistic office navigation occurs. A successful response sends floor.go; closing the dialog before completion suppresses navigation. Catalog/create fetches have 30-second deadlines. Empty catalogs, session failures and request/scope conflicts show actionable text. Reconnect and Refresh send explicit office-scoped WebSocket requests with visibility. No polling timer is added.

The setup authorization boundary remains the application's signed-in audience, including shared-password guests. Configure scopes only for that audience. This UI does not provision credentials, instantiate servers or grant access.

## Controls reconciliation

Reviewed AGE-8 controls and AGE-4 `net.command`/outbox implementation in the existing worktree. They are absent from this base. D does not reuse local task statuses, receipt IDs or outbox commands for remote actions. Its early entry guards must stay before local control UI construction when branches are integrated. Preserve the original controls command-to-start latency measurements; no remote command latency or speed improvement is claimed. Shared server/protocol integration and typed unsupported acknowledgments remain B/E ownership.

## Verification

Current integration: eight focused tests pass (connected UI model, real-server setup, connected lifecycle isolation); client typecheck and production build pass. Commands:
- node --import tsx --test tests/connected-ui.test.ts tests/paperclip-setup.test.ts tests/connected-office.test.ts
- npx tsc -p tsconfig.client.json --noEmit
- npm run build:client

Earlier view-only evidence:

- `node --import tsx --test tests/connected-ui.test.ts tests/orchestration.test.ts tests/paperclip-contract.test.ts` — 19 passed.
- `node --import tsx --test tests/connected-office.test.ts tests/workflow.test.ts` — 9 passed.
- `npx tsc -p tsconfig.client.json --noEmit` — passed.
- `npm run build:client` — passed after linking the inherited installed node_modules into the isolated worktree; no dependency installation or manifest change.

## Reproducible QA handoff

On the integrated fixture-backed connector build, bind an idle test office to one test project with all seven native statuses, an unknown status, at least two agents, and completed-run activity for an in_review task. Open the queue, issue board, roles, hire desk, terminal and meeting surfaces: all must show connected records and no local command form. Verify every remote control is explicitly unavailable and canonical task/agent links open safely. Verify completed-run activity leaves in_review unchanged.

Send a foreign-office, foreign-company, foreign-project and foreign-connection snapshot: each must be ignored. Switch to a local office: prior remote records must disappear and original queue/roles/terminal/meeting flows remain available. Switch offices with the dialog open: it must close.

At 360px and desktop widths, Tab/Shift+Tab through links and Close, expand details, press Escape, and verify focus restoration and no horizontal overflow. Refresh while focused on a canonical link; preserve focus when it survives, otherwise return to Close. Disconnect WebSocket: last records remain marked stale. Reconnect: restored snapshot replaces them. Exercise stale, permission-limited, disconnected, no last sync, empty task/agent/activity and remote error snapshots. Inspect browser network/storage for absent credentials. Remote writes remain explicitly disabled. For setup, use the deterministic setup fixture transport with two connections, repeated company/project IDs across connections, and different project names. Verify dependent selectors reset correctly, empty/revoked/error catalogs never enable unapproved creation, and selecting the correct tuple opens only that office. Delay/drop a creation response: fields lock, retry/close/reopen/reload preserve the exact request ID and payload, and only one office exists. Return a mismatched scope: no navigation occurs. Check Escape/focus restoration and all selectors/buttons at 360px. Click Refresh and Reconnect in the active office; switching offices during a delayed response must not show foreign records. Inspect request bodies and storage for absence of credentials/origins. Browser capability is unavailable in the engineering runtime; independent browser verification is assigned to QA under AGE-16.
