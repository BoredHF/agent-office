# Authenticated read integration — AGE-17

Approved scope: AGE-9 plan revision 1 (`12c37805-d0dc-4bf7-8c38-cfaffdd2fd9b`). Integration depends on connector C commit `9266b851c2b365c4a8c4feb8ca679bb00348e0cd` (three connector-owned files), on baseline B `1132af7480aaf2a45606f4256e364d7b7e372ede`. The integration commit contains only provider/server/shared wiring, tests and this document; apply it after C when assembling a branch.

## Server and UI contract

The embedding server calls `startServer(cfg, { connectedProvider: { resolveConnection, readOptions? } })`. The synchronous trusted resolver receives a frozen office/connection/company/project scope and returns a server-only `PaperclipConnection`, or undefined for disconnected. Connection/company mismatches and invalid origins fail closed before any local runtime construction. Selected project existence/ownership is validated by the connector's first read. Origin allowlist and credential callback stay in trusted server code. `readOptions` supports deterministic injection; it is not a client protocol field. No production credential registry or CLI credential provisioning is added.

After authenticated welcome or floor entry, D UI can send `{ t: 'orchestration.refresh', officeId, visible: boolean }`. The reply uses the existing `{ t: 'orchestration', snapshot }` DTO. The requester must currently occupy that office; the existing session/office model is the authorization boundary, not a new per-office user ACL. Wrong office requests reject before remote access. Missing/invalid visibility rejects. Only the requesting client receives the refreshed snapshot; other clients request their own snapshots. Welcome/floor-entry snapshots remain synchronous cached reads.

On completion the server rechecks client identity, floor identity and provider identity before delivery. Leaving the office during a read suppresses delivery. Disconnect/revocation clears connector records and never invokes local resources. Missing configuration stays disconnected. The default CLI still has no configured connection. No automatic fallback, recurring refresh timer, credential provisioning, permissions, commands, or browser-supplied origin/credential fields are introduced. Connector rate limits, coalescing, backoff and all compatibility limits in READS.md remain authoritative.

## Reproduce

```
node --import tsx --test tests/paperclip-reads.test.ts tests/paperclip-contract.test.ts tests/orchestration.test.ts tests/connected-office.test.ts
npx tsc -p tsconfig.server.json --noEmit
git diff --check
```

34 tests: 17 connector, 12 contract, 4 provider factory/boundary, 1 real-server lifecycle. Initial combined 33-test suite passed before adding the factory case and delayed-response assertions; the updated 5-test integration/provider suite, server typecheck and whitespace check passed afterward. Unchanged connector/contract cases were not rerun unnecessarily.

The real-server fixture logs in, injects remote reads, checks task delivery and secret omission, rejects foreign-office requests, changes to the rooftop during a gated read and proves no late delivery, verifies rate limiting, revokes credentials, disconnects and restarts twice with configured providers. Sentinel local state remains untouched and fake provider CLIs are never invoked. The original unconfigured-server case remains covered.

## Handoff and delivery limits

Connector Engineer: assemble this integration revision after C and run the reproduction above for final integrated C verification. D UI owner: use the request/reply contract above and discard snapshots whose full scope no longer matches the active office. Office QA: independently reproduce lifecycle/isolation coverage; these are deterministic transports, not deployed identity or live revocation verification.

CEO: coordinate application/A/B dependency delivery before making C draft PR #1 ready: https://github.com/BoredHF/agent-office/pull/1 (reported C remote revision `644df85960aa3955bda1369ac365dc8a59a2a9e2`). No integration PR was opened, no PR was made ready, and nothing was merged or deployed. Remote PR state has not been independently refreshed in this heartbeat.

Paperclip coordination uses the HTTPS endpoint observed in the supplied HTTP URL’s redirect. Direct HTTPS requests authenticate successfully; redirect-following reads initially failed. No credential or permission changes were needed.
