# Command receipts — AGE-14 scaffold

Approved source: AGE-9 plan revision 1, `12c37805-d0dc-4bf7-8c38-cfaffdd2fd9b`. This package is incomplete and must remain draft. No transport, provider wiring, command enablement, credential provisioning or permissions are included. Existing read-provider rejection and all false command capabilities remain authoritative.

`CommandReceiptLedger` is server-only offline scaffolding. Its key binds connection/company/project/office/authenticated actor/operation ID. The same operation ID with a different action or canonical intent digest conflicts. The future adapter must validate and authorize the human and complete scope before any ledger access, and derive the digest from the normalized command including target and expected upstream version. Browser-provided actors, roles, digests or capability flags are not authorization. A new operation ID is a new intent; the ledger cannot detect arbitrary new-ID duplicates.

The first atomic reservation is fsynced before permitting one submission. Its initial outcome is unknown. Concurrent calls, process restart, transport timeout, and duplicate submissions cannot release that slot. An incomplete or corrupt reservation fails closed with a fixed error. Only conclusive operation-specific evidence permits an applied/rejected/conflict resolution. A terminal resolution is immutable; a crash during resolution may leave unknown permanently until an operator reviews it. There is deliberately no retry/reset/delete API. A reservation before a network attempt can therefore remain unknown even if nothing was sent. Safety takes precedence over availability.

Receipts persist only version, hashed intent and allowlisted outcome, not task text, payloads, credentials, upstream bodies or caller-supplied errors. Opaque actor/scope are hashed in the directory name, not a replacement for upstream audit attribution. Hashes are not encryption. The trusted local parent directory must already exist and be inaccessible to untrusted writers. The filesystem must support atomic mkdir/rename and file/directory fsync (tested on this Linux workspace); network filesystems, Windows and multi-host replicas are unverified. Protect and back up the ledger with the connection; do not delete receipts while operation IDs can replay. No automatic retention or cleanup is implemented.

## Compatibility and remaining gates

- Installed `statusVersion` has not been proven to provide conditional update/CAS. A GET followed by PATCH is not sufficient to prevent stale edits. No PATCH adapter is implemented.
- Create/comment idempotency, authoritative operation lookup and safe reconciliation remain unproven. State/title equality is not proof of a command's outcome. No write headers or semantics are invented.
- Role/membership restrictions, human attribution, credential revocation, project isolation and upstream review preservation require the approved isolated target and supported human-bound identity. Offline ledger tests do not prove these.
- Wake/pause/cancel/hire/instruction commands remain unsupported with canonical UI fallback. No local execution fallback, fake checkout/run IDs or recurring timers are added.
- AGE-4 local controls retain their requestId/expectedVersion behavior. AGE-8 is a contract proposal; neither implies upstream CAS. Package B owns any future shared protocol/server boundary changes. D should continue rendering disabled actions. Receipt storage alone does not add a browser command endpoint.

The existing AGE-14 operator interaction `0745fcda-389a-47a5-91ce-952cab2f4ec9` remains the live waiting path. CEO coordinates containment/provisioning evidence; Connector Engineer resumes supported adapter work after the relevant gates pass. Office QA must independently verify the final integration.

## Reproduce

```sh
node --import tsx --test tests/paperclip-receipts.test.ts
```

Six focused tests cover concurrent instances, restart/unknown outcome, changed intent, scope/actor lookup isolation, terminal outcome persistence, corrupt storage, redaction and path validation. This scaffold intentionally depends only on Node built-ins and introduces no shared protocol changes.
