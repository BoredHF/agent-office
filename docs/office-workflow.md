# Offices, roles and task workflow

The office picker (project name, or **Menu → Offices**) creates, switches,
renames, archives and restores offices. Existing repository floors keep their
IDs and paths. A legacy single-project office remains the default office.
New local offices get distinct storage directories and their own Git roots,
even when the building itself lives inside a checkout. Repository addition
through the elevator remains available; adding the same repository twice is
still rejected. This does not provision a second checkout of the same remote.

**Task queue → Roles** defines reusable responsibilities and instructions and
assigns them to existing agents. Task creation selects priority, role override
and either an existing agent or a fresh worker. Role assignments persist;
each attempt stores its role version and instruction snapshot in task history.
Editing a role applies to future attempts. The roles window shows each agent's
current task and latest activity.

Tasks move through queued, running, blocked, review and done. A completed agent
turn enters review; **Details / review → Accept result** records the reviewer
and marks it done. Progress notes, blocker reasons and assignment changes are
recorded in history. To hand work off, stop any active attempt, choose another
agent, add a handoff note and queue the next attempt. Busy assigned agents wait;
missing agents block visibly. Queue priority is urgent, high, medium, low, with
stable existing queue order for ties. Arrows reorder only within a priority.

Archiving preserves records and requires no active agents or queued/running
tasks. Restore reopens the same office. The task board and queue expose blocked
and review work. Budget and capacity checks still gate execution.

## Persistence and recovery

`floors.json` and each office's `queue.json` are version 1 documents. Legacy
files are backed up once as `.legacy.bak` before migration. Writes use a
same-directory temporary file, file fsync and atomic rename. Malformed records
surface an error and are not overwritten; queue storage errors stop dispatch.
Correct the filesystem/store problem and restart to reload authoritative state.
Do not restore a legacy backup over newer work without reviewing the changes.

Legacy successful completions enter review; failed/stopped completions enter
blocked recovery. Worker/branch/PR/timestamp history is retained. Running tasks
are reconciled after PTY adoption. Queue-owned workers whose PTYs cannot be
adopted are excluded from automatic wake-up, including later office arrival.
They require explicit recovery rather than silently launching another attempt.
A durable dispatch intent precedes PTY effects; if interrupted, its visible
blocked state asks the operator to inspect the worker before retrying.

Modern browser commands carry the office visible when issued. Stale contexts
and old clients without office context receive an error requesting reload.
Worker commands resolve only within that office. Chat history, live chat,
roles, task updates and terminals remain scoped across office switches.
Authenticated provider hooks retain their worker-specific token checks.
Accounts, machine capacity, budget ledger and rooftop remain shared building
features; offices are not hostile-tenant security sandboxes.

## Controls integration seam

- `officeId`: `FloorInfo.id`; existing floor IDs are preserved.
- `taskId`, expected version and attempt: `QueueTask.id`, `.version`, `.attemptId`.
- New/legacy tasks start at version 1; a migration history event increments it.
  Historical legacy attempts may have no attempt ID; new dispatches always do.
- `task.update.version` is the expected version. Stale edits are rejected.
- `TaskQueue.changed()` calls `persist()` then publishes state. Tasks, roles and
  agent-role assignments share the same atomic document.
- Follow-up controls must add durable command receipts to that document and
  resolve replay before stale-version checks. Request-ID receipts, run-now,
  urgency acknowledgments, instruction redirection and sensitivity settings
  belong to the subsequent controls implementation.

## Verification and reproducible QA handoff

From repository root with existing dependencies installed:

```sh
node --import tsx --test tests/queue.test.ts tests/office-queue.test.ts tests/workers.test.ts tests/history.test.ts tests/workflow.test.ts tests/office-isolation.test.ts tests/qa-regression.test.ts tests/queue-pty-recovery.test.ts
npm run typecheck
npm run build
```

Verified on 2026-09-28: **61 passed, 0 failed, 0 skipped/TODO**; both TypeScript
checks and the production build passed. Retained output: `docs/evidence/age3-tests.txt`.

The focused checks use temporary roots and fake providers, not paid model calls.
`office-isolation.test.ts` starts a loopback HTTP/WebSocket fixture and exercises
two offices, foreign worker/task IDs, stale/missing office context, chat,
rename and archive guards/restore. `queue-pty-recovery.test.ts` uses a real hosted
PTY: two manager restarts retain the same worker/attempt with one fixture
invocation; after killing that PTY, restart/wakeAll block without relaunching.
It tests manager/host recovery, not arbitrary OS power loss or all PID-reuse
faults. The host identifies sessions by its authenticated session ID, not PID.

`qa-regression.test.ts` preserves Office QA's seven probes from commit
`cd116576bb56527a3e1f20deec66a36f139db0c0`, changing F1/F2 assertions to the intended
acceptance behavior. F1 verifies an actionable error and unchanged malformed
bytes after `setLimit(0)`; F2 verifies a reported live survivor stays running
with no additional attempt. Original QA worktree/evidence are untouched.

Local 20-sample `TaskQueue.add` entry → fake spawn entry benchmark with atomic
writes: minimum 1.13 ms, median 2.30 ms, p95 4.26 ms, maximum 5.59 ms. This
excludes browser/network, real process readiness and provider/model work.
Atomic writes add local dispatch overhead; no model speedup is claimed.

Browser acceptance is handed to Office QA in the existing release-verification
task. Use a disposable managed preview and a synthetic provider:

1. Start with an empty building. Menu → Offices → Create office A and B.
   Rename B; switch through the picker. Create same-named Engineer roles with
   different instructions. Confirm each office shows only its own role.
2. Hire a fixture agent, assign its role, pause new dispatch with Workers at
   once = 0, then create tasks with different priorities and assignees.
   Release one slot and confirm the visible and actual dispatch order agree.
3. Inspect progress and history; finish the fixture turn. Verify review, accept
   the result, block a task with an owner/action note, and hand it to another
   agent. Editing the role must not rewrite the previous attempt snapshot.
4. Reload and restart. Confirm offices, roles, assignments, task history and
   chat persist; surviving attempts stay associated and dead ones block.
5. Archive an inactive office, reload, restore it and inspect the same records.
   Archive with queued/running work must report why it cannot proceed.
6. Verify hire/terminal, floor/elevator, queue CLI and provider resume flows.
   Check keyboard focus and long labels at 1280×720 and 800×600. The new forms
   must not leak movement/terminal shortcuts. Capture screenshots and failures.

No browser visual approval or production deployment is claimed by the engineer.
