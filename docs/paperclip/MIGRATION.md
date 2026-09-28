# Migration tooling and idle-office pilot runbook

Package F, approved AGE-9 plan revision 1 (`12c37805-d0dc-4bf7-8c38-cfaffdd2fd9b`).

## Delivery boundary

`src/server/migration/index.ts` provides deterministic inventory, private non-overwriting backup, a durable import state machine, and guarded cutover/rollback. `cli.ts` exposes offline dry-run and backup only. The engine accepts a trusted `MigrationPort`; tests use disposable in-memory remote records. **There is no production MigrationPort, production import command, live cutover or authorization claim in this revision.** The existing connected provider and command transport are not changed. This remains draft until the server adapter and independent verification exist.

The missing adapter is a concrete integration requirement: a maintenance lease that survives process restarts and prevents local dispatch; verified inert Paperclip creation with company/project validation, attribution and exact provenance lookup; complete remote quiescence under a lease preventing new work; atomic binding persistence; and local restore that permanently excludes imported task IDs. A boolean supplied by a browser is not proof. CEO owns unresolved identity/record-class policy, Connector Engineer owns the remote authorization/reconciliation boundary, and Migration Engineer owns adapter assembly. Do not pass a stub adapter to a real office.

## Mapping and compatibility

The input is one parsed version-1 or legacy queue document. Every task must have a unique ID, title, prompt and known status. Dry-run is pure and deterministic; hashes cover the entire source and each task, including unknown fields. Operation IDs cover office, connection, company, project, local ID and source hash. Changing source or scope after prepare is refused.

Only never-attempted queued tasks and completed tasks are eligible. Queued tasks become **unassigned backlog**, never todo. Running/review/blocked tasks and queued tasks with attempt, worker, start, outcome or nonempty history are excluded for explicit reconciliation. Completed tasks retain done status; local reviewer names do not establish upstream human attribution. No roles, shared agent instructions, assignment, local priority, model, attempts or execution receipts are translated silently. Dry-run lists unsupported field names and counts roles/assignments; full unsupported values/history remain in the private read-only `source.json` archive. Title/prompt alone are sent to the adapter; they still need an operator content review for sensitive text.

The archive is mode 0400; checkpoint and backup files are 0600, new directories 0700. Checkpoints use the existing `atomicJson` convention with an additional parent-directory fsync. Source archives, credentials, worker state and terminal transcripts must never be attached to a public PR or browser DTO. Backups are not encryption; use operator-controlled encrypted storage. `backupOffice` accepts only regular files/directories, rejects symlinks/sockets and overlapping roots, and never overwrites a destination. A partial failed backup is retained and must not be treated as complete. There is no automatic cleanup or deletion.

Only one process may use a migration directory. A crash leaves its exclusive `lock` file intentionally in place. Confirm the old process is dead and the office maintenance lease still prevents dispatch; inspect the checkpoint, preserve a copy, then explicitly remove only that stale lock. Never delete a pending receipt or restart with a new migration directory to bypass reconciliation. The maintenance lease must also prevent migrations using different directories for the same office.

A pending intent is durable before remote submission. Any exception or crash leaves it pending. Resume asks for an exact provenance match; null, auth failure, ambiguous results or absent records stop the import. Absence is **not** permission to retry: the original request may still be running. This favors safety over automatic recovery when the remote contract cannot establish an outcome. Confirmed receipts carry localId through the mapping plus remoteId, sourceVersion, operationId and scope. Mismatched or duplicate remote IDs are refused.

Rollback disables writes before inspection and never deletes remote records. Unresolved submissions and active/unknown remote work block restore. The adapter must suppress all imported local IDs before enabling local mode, including records now completed remotely; copying the original queue back wholesale can execute them twice. Connect/restore must be idempotent because a process may die after a mode transition but before its checkpoint save. The engine does not itself spawn a worker, update an agent, stop a PTY, or modify floors.json.

## Offline commands

From a checkout with development dependencies:

```sh
node --import tsx src/server/migration/cli.ts dry-run /private/stopped-office/queue.json office-id connection-id company-id project-id
node --import tsx src/server/migration/cli.ts backup /private/stopped-office /private/new-backup-directory
node --import tsx --test tests/migration.test.ts
npx tsc --noEmit --types node --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck src/server/migration/index.ts src/server/migration/cli.ts
git diff --check
```

Dry-run does not prove an office idle. Backup requires all writers stopped for a coherent snapshot. The CLI prints a fixed refusal without parse excerpts or raw error content. It does not load credentials, start local orchestration, create recurring timers or make network requests.

## Idle-office pilot (later explicit approval required)

1. CEO selects one disposable idle office and approves exact source hash, scope, eligible record classes, identity/attribution, parity policy and adapter evidence. Live production migration is a separate decision. Verify B's no-local-execution tests and C's complete scoped reads on the assembled revision.
2. Enter maintenance: stop admission/dispatch using existing local controls. Pause does not stop active work. Drain workers and meetings or use explicitly approved stop actions. Stop the office server and detached PTY host after checking every worker, shell/station, meeting and pending queue intent. Record process/queue evidence. Keep dispatch disabled across restarts.
3. Back up the building registry and every relevant office data root to new private destinations. Detached sockets are runtime artifacts, not portable backup data: stop/remove them through the normal host shutdown procedure before backup. Include queue, roles, assignments, workers, meetings, history, visual state and configuration in the operator backup inventory. Verify backup contents/hash manifest independently; never overwrite the original or import tokens.
4. Run dry-run twice on the frozen queue; compare counts, hashes and unsupported fields. Review every excluded task and assignment separately. Preserve the source as read-only evidence. Abort on any source change. No shared agent mutation is authorized by role similarity.
5. Construct the verified server-side adapter under its maintenance lease. Call `prepare(source, scope, approvedSourceVersion)`, then `resume()`. After interruption retain the same directory; recover the lock only after the dead-process check above. Reconcile pending records by exact scoped provenance. Never replay an uncertain create.
6. Compare imported counts and mappings against dry-run. All queued records must be unassigned backlog; all historical completed records must remain completed. Compare agents without mutating shared agents. Verify no local or remote execution was triggered. Call `cutover()` only after parity; it disables connector writes and rechecks local idle before persisting the connected binding. Restart using the validated binding and prove no local recovery.
7. Office QA records exact commit, fixture/live distinction, source/report hashes, counts, receipts (redacted), process evidence, scope checks and rollback rehearsal. Write enablement requires a later explicit decision and verified command contract; this engine never enables it.
8. To roll back, call `rollback()` with connector writes disabled and the remote maintenance lease held. Complete remote reconciliation and stop/drain remote work using authorized upstream controls. Refuse stale/incomplete reads. Restore local presentation/configuration while suppressing every imported local task ID before dispatch resumes. Keep all remote records and backups. Test that no migrated job launches locally. Any uncertainty leaves writes and local dispatch disabled; escalate to CEO with the operation IDs and owner/action.

## Verification handoff

Eight focused fixture tests cover deterministic reports/counts, active-attempt exclusion, durable timeout resume without duplicate creation, unknown outcome refusal, local idle, source/scope mismatch, immutable archive tamper detection, foreign/duplicate remote receipts, cutover order, rollback active-work refusal, permanent local exclusions, repeated rollback, stale lock refusal and non-overwriting/symlink-safe backups. The tests never contact Paperclip or launch real workers.

The module-only strict typecheck passes. Full server typecheck on the inherited base fails because `src/server/paperclip/reads.ts` is not tracked there (C's files remain in a separate worktree); this is an assembly prerequisite, not evidence that the integrated application passes. No production build or browser checks were run for this standalone engine. AGE-4 controls/AGE-8 contracts are preserved as opaque source fields; no second controls store or command protocol was introduced.

Office QA should reproduce fixtures first, then require a real trusted adapter and test process-death recovery, local/remote leases, actual backup parity and binding/queue restoration on disposable data before package F or the pilot is marked complete.
