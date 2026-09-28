# Provider boundary and migration inventory (package B)

Accepted source: AGE-9 plan revision 1, `12c37805-d0dc-4bf7-8c38-cfaffdd2fd9b`.
Base inspected: `7f200ded993d381b536a74bd1f3b72cab769b1fd`.
Owner: Migration Engineer. No production deployment, remote import, permission change or deletion is included.

## Implemented boundary

`FloorDef.orchestration` is either `{mode: 'local'}` or `{mode: 'paperclip', connectionId, companyId, projectId}`. Absence alone retains legacy local behavior. Malformed values, unknown modes, extra fields (including credentials), and incomplete bindings throw before local construction. Building load validates persisted bindings. The selected provider scope is copied and frozen; changing the floor definition or disconnecting cannot change execution mode.

`createOrchestrationProvider` accepts a **lazy** local factory. Only the local branch constructs WorkerManager, TaskQueue and MeetingRoom. LocalOrchestrationProvider owns startup (worker reconciliation before queue start) and shutdown. Floor's legacy workers/queue/meetings accessors reject connected access; Floor.local is absent. Cross-floor capacity pumps, ownership lookup, terminal snapshots, arrival wake, search and disconnect skip absent local resources. Connected mode neither reads nor repairs local execution stores.

The default connected provider is deliberately disconnected, with empty projections and all capabilities false. Package C supplies its authenticated implementation at the connected factory branch. There is no fallback to local mode on configuration, authentication, refresh, restart or disconnect failure. This is a safe boundary, not a working remote connector.

## Contract for C, D and E

- Browser-safe contract: `src/shared/orchestration.ts`; server interface: `src/server/orchestration.ts`.
- Scope includes officeId, mode, connectionId, companyId and projectId. `sameProviderScope` checks every dimension. Remote adapters must validate scope and remote ownership server-side, including targets and assignment IDs; the helper alone is not authorization.
- `OrchestrationProvider.snapshot()` returns the last projection synchronously. C owns asynchronous refresh/cache and emits `{t: 'orchestration', snapshot}` through the existing floor event channel. Initial welcome and floor-enter include `FloorView.orchestration`. These are projections, not persisted authoritative tasks.
- Each task/agent/activity has a source ID and optional canonical URL/source version. Native task status is retained separately from displayStatus. Paperclip's seven statuses are listed in PaperclipTaskStatus; a completed run does not mutate task status. Local history maps to activity without inferring completion.
- Capabilities explicitly enumerate task create/comment/assign/status, agent wake/pause/cancel/hire/instructions, terminal and meetings. False is authoritative. No remote terminal or meeting support is claimed.
- Commands carry operationId, full scope, target/source version and payload. Results distinguish applied/rejected/conflict/unknown. C/E must runtime-validate payloads; this interface does not confer write permission. Unknown requires reconciliation, never automatic replay.
- B's generic command method rejects; legacy local endpoints keep their current behavior. D should use mode plus capabilities, retaining local views for local offices. E adds verified command handling and durable remote receipts; it must not map native review/approval to a local queue shortcut.
- No credential, configured origin or transport object is accepted in persisted OfficeBinding or browser DTOs. ConnectionId refers to server-owned configuration.

## Execution inventory

| Surface | Spawn/wake/dispatch/recovery chain | Connected handling |
| --- | --- | --- |
| Floor constructor / server openFloor | WorkerManager constructor restores worker metadata, creates TaskNamer/PtyHost, schedules screen/usage/save work; TaskQueue restores/reconciles and schedules pump; MeetingRoom restores rounds and schedules tick | Branch before all three constructors |
| Local provider startup | workers.start holds queue-managed recovery IDs, connects PTY host, adopts saved terminals, kills unclaimed terminals, calls wakeAll; then queue.start/pump | Provider has no local runtime or ready recovery work |
| Worker lifecycle | spawn/resume/station → launch → PtyHost.spawn or direct node-pty fallback; station may prompt an existing worker or resume it | Legacy accessor rejects, WS family guard blocks |
| Automatic worker recovery | wakeAll on startup and arrival; follow() handles lost host with resume; failed Claude resume can launch a fresh conversation | No manager, events or recovery timers exist for connected floors |
| Queue | add/update/retry/limit/move and start/timer/onWorker/onWorkerGone/onPulls/capacity freed → pump; selects assignment prompt or spawns worker; persists attempt/role snapshot before dispatch | No queue constructed; cross-floor pump skips connected |
| Meetings | start seats workers; tick reissues missed turns, prompts/writes round instructions, persists outcomes; restart reloads a running meeting; stop/clear kill workers and may tidy worktrees | No meeting constructor or tick; WS meeting family blocked |
| WS execution | worker.spawn/resume/prompt/kill/attach/pr; station.prompt; term.input/resize; queue.*; task.update; role.*; meeting.* | Family guard before dispatch; unsupported toast; current office context still checked |
| WS controls from AGE-4 | `control` → queue.command → receipt/version/attempt validation → run/priority/urgency/pause/resume/retry/redirect/scream → pump | `control` explicitly blocked in connected mode; not translated to remote commands |
| HTTP station queue | /office/queue authenticates worker token; POST adds, DELETE removes | workerFloor only searches local runtimes; old connected-office worker IDs get 401 |
| HTTP hooks | /hooks/claude, /hooks/opencode, /hooks/codex authenticate worker and can emit queue/meeting events | Same local-only lookup rejects connected IDs |
| HTTP/WS GitHub and Changes | GH claim/close/merge and Changes worktree/commit/PR surfaces can alter queue or local work artifacts | WS families blocked; floor-scoped HTTP GH/Changes reject with 403 |
| Arrival/reconnect/elevator | server connection and goToFloor call wakeAll; terminal resync and close/leave attach/detach workers | Local optional checks; empty terminal/queue/meeting projections |
| Shutdown/restart/archive | local queue/meeting stop then worker shutdown; keep=true retains PTYs for local restart | Connected shutdown has no execution resources; archive/unarchive retains binding |
| Task naming | WorkerManager TaskNamer → debounced/concurrency-limited tasks.ts Claude Haiku subprocess | No WorkerManager means no namer or naming queue |
| Plan limits | limits.ts asks Claude via a subprocess; constructor schedules polling; server arrival/limits.refresh requests refresh | Wanted predicate requires a client on a local floor; connected-only viewers cannot start it |
| Model discovery | models.ts execFile(opencode, models) on HTTP request | Explicit connected floor rejected; legacy request rejected when every open floor is connected |
| PTY host server | ptys.ts launches detached ptyhost; host accepts spawn IPC and calls node-pty | No connected PtyHost created or attached. Pre-existing detached local processes require drain before cutover |

Additional child-process sites were inspected: building/config/worktrees/prune use git/filesystem setup; changes/github/meetings use git/gh operations; machine/services use OS process/network inspection; team/upgrade operate building administration. They are not alternate task schedulers. Shared building administration remains available under existing authorization. No new grant or administrative bypass was added.

## Persisted data inventory and migration disposition

Paths are relative to the configured building data root or each floor's `dir/.agent-office`. This is a schema/call-site inventory, **not a census of live customer records**; F produces per-office counts without printing secret-bearing contents.

| Store | Contents and ownership | F disposition / limits |
| --- | --- | --- |
| Building floors.json | Version 1 offices array; legacy array supported with backup; office ID/name/dir/repo/palette/addedBy/addedAt/archivedAt and optional orchestration binding | Preserve office IDs and visual settings. Map each approved office to one connection/company/project. Validate disjoint real storage paths. Never infer company from a repository |
| projects-folder.json | Local clone root and attribution | Keep local; no Paperclip equivalent |
| Per-office queue.json | Version 1 tasks, maxWorkers, roles, assignments; legacy unversioned supported with backup | Source version/hash plus local→remote mapping and checkpoints. Import only approved inert records; running/uncertain attempts require reconciliation |
| Queue tasks | ID/version/title/prompt/priority/status, provider/model/effort, roleId/assigneeId, issue/PR/worktree links, workerId/name, timestamps, attemptId, outcome/error, reviewer and history | queued→todo only after explicit import policy; running is not a new runnable remote task; review→in_review, blocked→blocked, done retains review provenance. Provider/model/effort and GH links require supported metadata or provenance attachment, not silent loss |
| Queue roles | ID/version/name/responsibilities/instructions | Review instruction parity before creating/updating any Paperclip agent. Shared agent changes need explicit policy; never infer permission from a role name |
| Queue assignments | Worker ID→role ID; task assigneeId and historical roleSnapshot | Resolve company-scoped identity separately from desks. Keep historical role snapshots immutable |
| Queue history | at/by/note/attemptId/roleSnapshot; task reviewedBy and lastUpdate | Preserve as read-only provenance when no exact event equivalent exists. Local display names are not authenticated human identity |
| AGE-4 queue extensions | dispatchPaused, controlVersion, receipts keyed by principal/requestId with fingerprint/result, task dispatch metadata | Preserve during backup/import. Never use local control receipts as proof of remote idempotency. Receipt capacity/atomic dispatch intent semantics remain unchanged |
| workers.json | Worker IDs, desks/kinds, provider/native session IDs, prompts/status, hook/PTY recovery information, worktrees, activity and usage | Treat as sensitive execution state. Do not copy tokens/session recovery credentials into DTOs or import; drain/adopt/reconcile locally before cutover. Shell/station workers have no automatic remote-agent mapping |
| pty-host.json / pty.sock / pty-host.log | Detached runtime identity/socket/log; socket can be hashed under system temp for long paths | Not importable. Detect active local host/processes; stop/drain by explicit policy. A connected startup intentionally does not attach or kill them |
| claude-hooks.json and provider helper files | Local hook configuration | Secret-bearing operational config stays server-side, outside exported provenance |
| meetings.json and .meetings/worktrees output | Current/past meeting rounds, worker participation, notes, decisions/reviews and files | Archive evidence; do not import as runnable meetings. Active meeting blocks cutover |
| scrollback/ | Per-worker serialized terminal and searchable text history | Read-only evidence, potentially sensitive; no remote terminal parity claim |
| chat.jsonl | Bounded office chat; legacy building chat copied once to default office; separate rooftop chat | Remains presentation/collaboration data, not task comments by default |
| Decor, whiteboard files/state, dog, jukebox, arcade | Office visual/collaboration state | Keep local keyed by stable office ID; back up with office |
| Accounts/config/usage/settings at building root | Authentication, credentials, budget and shared settings | Back up securely, do not import credentials. Paperclip budgets/permissions remain upstream authority |

## Controls reconciliation and integration limits

AGE-8 preparation: `ca2cdb6f244af6fb3f8951b1c2c8e11ea8d9e7ae`. AGE-4 integration: `1923d4646cd15552a0fb0c95ac7831ce1e462542` in `.controls-age4`. These changes are not in this base. Their worktrees were read, not edited or merged. There is no second local command/receipt store in B. Integration must preserve AGE-4's acknowledged controls route and return its typed unsupported acknowledgment for connected control requests when merging its client outbox. B currently returns the existing toast because that control DTO is absent from this base. No controls UI release acceptance is claimed here.

Connected setup UI, connection credentials, remote reads/pagination, command authorization, receipt reconciliation and live migration are owned by C/D/E/F. No live mode-switch API exists in B. Persist a binding only through an approved idle-office cutover procedure; arbitrary editing of floors.json is not a supported migration. Removing a binding would opt back into legacy local startup and must never be used as rollback without reconciling remote active work.

Disconnect cannot resume local work. Rollback must disable connector writes, retain remote records, reconcile all remote active attempts, then restore local dispatch explicitly. B does not drain already-running detached PTYs; that is a hard precondition for F's cutover, not a claim that selecting Paperclip kills existing work.

## Verification and QA handoff

From the inherited project workspace with dependencies and the existing client bundle installed:

```sh
node --import tsx --test tests/orchestration.test.ts tests/connected-office.test.ts
node --import tsx --test tests/office-isolation.test.ts tests/office-queue.test.ts tests/queue.test.ts tests/queue-pty-recovery.test.ts tests/workers.test.ts tests/meetings.test.ts
npx tsc -p tsconfig.server.json --noEmit
npx tsc -p tsconfig.client.json --noEmit
```

Recorded: 4 provider/real-server boundary tests and 50 local regression tests pass; both typechecks pass. The connected test runs two real server lifecycles, authenticates HTTP/WS, rejects every legacy execution family (including control), exercises stale worker-token HTTP, denies model discovery and Changes, disconnects and preserves chat. It asserts no local runtime, no PTY log/provider CLI invocation, and byte-identical local execution stores. Contract tests prove scope isolation, all-disabled capabilities and fail-closed malformed bindings.

Office QA should repeat these commands on the integrated revision, then add C/D/E/F release-gate/browser tests to AGE-16. No full integration build, browser visuals, remote authorization, import, or production rollout is claimed by this package.

## Package F estimate and next action

Estimate after B inspection: **3–5 engineering days**, excluding dependency/auth decisions and independent QA. Rough allocation: one day inventory/dry-run/backups; one to two days approved inert import, source mappings/checkpoints and duplicate-safe interruption recovery; one day rollback/cutover guards and tests; up to one day pilot runbook and review fixes. This is effort, not a delivery date.

F starts after B and C's scoped reads contract. It needs CEO decisions on approved record classes, attribution and agent-instruction parity if not resolved by A/E. The first executable F milestone is a read-only per-office dry-run report with counts, source hashes, unsupported fields and active-local-work blockers. No import or live pilot should be inferred from B completion.
