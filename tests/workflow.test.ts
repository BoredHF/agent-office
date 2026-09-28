import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Building } from '../src/server/building.js';
import { TaskQueue, type QueueWorkers } from '../src/server/queue.js';
import type { WorkerInfo } from '../src/shared/protocol.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'office-workflow-'));
  const queues: TaskQueue[] = [];
  t.after(() => { queues.forEach((q) => q.shutdown()); rmSync(root, { recursive: true, force: true }); });
  const open = (name: string, workers: WorkerInfo[] = [], defer = false) => {
    const dir = path.join(root, name); mkdirSync(dir, { recursive: true });
    const prompts: string[] = [];
    const manager: QueueWorkers = {
      defaultProvider: 'custom', list: () => workers, deskOccupied: (desk) => workers.some((w) => w.deskId === desk),
      spawn(deskId, by, prompt) {
        const w = { id: `${name}-${workers.length}`, deskId, name: 'Agent', kind: 'agent', status: 'working', viewers: [], viewerIds: [], createdBy: by } as unknown as WorkerInfo;
        workers.push(w); prompts.push(prompt); return w;
      },
      prompt(id, text) { prompts.push(text); workers.find((w) => w.id === id)!.status = 'working'; },
      kill: async () => ({}),
    };
    const q = new TaskQueue(dir, manager, false, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {} }, defer);
    queues.push(q);
    return { q, workers, prompts, dir, manager };
  };
  return { root, open };
}

test('offices migrate once, keep roots separate, and persist rename/archive/restore', (t) => {
  const f = fixture(t);
  const legacy = [{ id: 'default', name: 'Default', dir: f.root, palette: 0, addedBy: 'Owner', addedAt: 1 }];
  const file = path.join(f.root, 'floors.json');
  writeFileSync(file, JSON.stringify(legacy));
  const building = new Building(f.root, f.root);
  const second = building.create('Other', 'Owner');
  assert.notEqual(second.dir, f.root);
  assert.equal(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: second.dir, encoding: 'utf8' }).trim(), second.dir);
  building.rename(second.id, 'Renamed'); building.archive(second.id, true);
  const restored = new Building(f.root, f.root);
  assert.equal(restored.list()[1].name, 'Renamed'); assert.ok(restored.list()[1].archivedAt);
  restored.archive(second.id, false);
  assert.equal(new Building(f.root, f.root).list()[1].archivedAt, undefined);
  assert.deepEqual(JSON.parse(readFileSync(file + '.legacy.bak', 'utf8')), legacy);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);
});

test('malformed and overlapping office stores fail visibly without replacement', (t) => {
  const f = fixture(t); const file = path.join(f.root, 'floors.json');
  writeFileSync(file, '{broken');
  assert.throws(() => new Building(f.root, f.root));
  assert.equal(readFileSync(file, 'utf8'), '{broken');
  writeFileSync(file, JSON.stringify([{ id: 'a', name: 'A', dir: f.root }, { id: 'b', name: 'B', dir: f.root }]));
  assert.throws(() => new Building(f.root, f.root), /overlapping/);
});

test('roles, assignments and tasks stay office-scoped and survive restart', (t) => {
  const f = fixture(t); const a = f.open('a'); const b = f.open('b');
  a.q.setLimit(0); b.q.setLimit(0);
  assert.equal(a.q.saveRole({ id: '', name: 'Engineer', responsibilities: 'Build', instructions: 'Test' }), undefined);
  const role = a.q.state().roles![0];
  assert.match(b.q.add('Task', 'Owner', undefined, undefined, 'custom', undefined, undefined, { roleId: role.id })!, /No such role/);
  a.q.add('Task A', 'Owner', undefined, undefined, 'custom', undefined, undefined, { roleId: role.id });
  b.q.add('Task B', 'Owner');
  const task = a.q.state().tasks[0];
  assert.match(b.q.update(task.id, task.version!, { note: 'wrong office' }, 'Owner')!, /No such task/);
  a.q.shutdown();
  const restored = f.open('a');
  assert.deepEqual(restored.q.state().roles, a.q.state().roles);
  restored.q.setLimit(1);
  assert.match(restored.prompts[0], /Responsibilities: Build\nInstructions: Test/);
  assert.equal(restored.q.state().tasks[0].roleSnapshot?.version, 1);
  restored.q.saveRole({ ...role, instructions: 'Changed' }, 1);
  assert.equal(restored.q.state().tasks[0].roleSnapshot?.instructions, 'Test');
  assert.equal(b.q.state().tasks[0].title, 'Task B');
});

test('priority is stable, finished turns require review, stale acceptance is rejected', (t) => {
  const f = fixture(t); const a = f.open('a'); a.q.setLimit(0);
  for (const [prompt, priority] of [['low', 'low'], ['high first', 'high'], ['high second', 'high']] as const) a.q.add(prompt, 'Owner', undefined, undefined, 'custom', undefined, undefined, { priority });
  a.q.setLimit(1); assert.equal(a.prompts[0], 'high first');
  a.workers[0].status = 'done'; a.q.onWorker(a.workers[0]);
  assert.equal(a.prompts[1], 'high second');
  const task = a.q.state().tasks.find((x) => x.title === 'high first')!;
  assert.equal(task.status, 'review');
  assert.equal(a.q.update(task.id, task.version!, { status: 'done', note: 'Verified' }, 'Reviewer'), undefined);
  assert.match(a.q.update(task.id, task.version!, { status: 'queued' }, 'Reviewer')!, /changed/);
  assert.equal(a.q.state().tasks.find((x) => x.id === task.id)!.reviewedBy, 'Reviewer');
});

test('worker adoption gates dispatch; live attempts persist and missing workers block', (t) => {
  const f = fixture(t); const a = f.open('a'); a.q.add('Running', 'Owner');
  const attempt = a.q.state().tasks[0].attemptId;
  a.q.shutdown();
  const restored = f.open('a', [], true);
  restored.q.pump(); assert.equal(restored.q.state().tasks[0].status, 'running');
  restored.workers.push(...a.workers); restored.q.start();
  assert.equal(restored.q.state().tasks[0].attemptId, attempt);
  assert.equal(restored.prompts.length, 0);
  assert.match(restored.q.retry(restored.q.state().tasks[0].id)!, /still on/);
  restored.workers.length = 0; restored.q.pump();
  assert.equal(restored.q.state().tasks[0].status, 'blocked');
});

test('legacy completion migrates to review/recovery, backs up once, and preserves PRs', (t) => {
  const f = fixture(t); const a = f.open('a'); a.q.shutdown();
  const legacy = { maxWorkers: 0, tasks: [
    { id: 'ok', prompt: 'A', title: 'A', status: 'done', outcome: 'done', pr: { number: 12, url: 'https://example.test/pr/12' } },
    { id: 'bad', prompt: 'B', title: 'B', status: 'done', outcome: 'failed' },
  ] };
  writeFileSync(path.join(a.dir, 'queue.json'), JSON.stringify(legacy));
  const b = f.open('a');
  assert.deepEqual(b.q.state().tasks.map((x) => x.status), ['review', 'blocked']);
  b.q.shutdown(); const c = f.open('a');
  assert.equal(c.q.state().tasks[0].pr?.number, 12);
  assert.equal(c.q.state().tasks[0].history!.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path.join(a.dir, 'queue.json.legacy.bak'), 'utf8')), legacy);
});

test('assigned idle agent receives one task, role assignment persists, foreign agents are rejected', (t) => {
  const f = fixture(t); const a = f.open('a'); a.q.add('First', 'Owner');
  const w = a.workers[0]; w.status = 'done'; a.q.onWorker(w);
  a.q.saveRole({ id: '', name: 'Engineer', responsibilities: 'Build', instructions: 'Check' });
  const role = a.q.state().roles![0]; a.q.assignRole(w.id, role.id);
  w.status = 'idle'; a.q.setLimit(1);
  assert.equal(a.q.add('Assigned', 'Owner', undefined, undefined, 'custom', undefined, undefined, { assigneeId: w.id }), undefined);
  a.q.pump(); assert.equal(a.workers.length, 1); assert.equal(a.prompts.length, 2);
  assert.match(a.prompts[1], /Instructions: Check/);
  assert.match(f.open('b').q.assignRole(w.id, '')!, /No such agent/);
  a.q.shutdown(); assert.equal(f.open('a', a.workers).q.state().assignments?.[w.id], role.id);
});

test('write failures stop dispatch; malformed stores cannot be silently reset', (t) => {
  const f = fixture(t); const a = f.open('a');
  mkdirSync(path.join(a.dir, 'queue.json'));
  assert.match(a.q.add('Must not run', 'Owner')!, /storage failed/);
  assert.equal(a.workers.length, 0); assert.ok(a.q.state().error);
  a.q.shutdown(); rmSync(path.join(a.dir, 'queue.json'), { recursive: true });
  writeFileSync(path.join(a.dir, 'queue.json'), '{bad');
  const b = f.open('a'); assert.match(b.q.add('No reset', 'Owner')!, /could not be read/);
  assert.equal(readFileSync(path.join(a.dir, 'queue.json'), 'utf8'), '{bad');
});

test('Queue next attempt clears the accepted result before a new attempt without a PR', (t) => {
  const f = fixture(t); const a = f.open('a'); a.q.add('Work', 'Owner');
  a.workers[0].status = 'done'; a.q.onWorker(a.workers[0]);
  let task = a.q.state().tasks[0];
  a.q.update(task.id, task.version!, { status: 'done' }, 'Reviewer');
  a.q.shutdown();
  const saved = JSON.parse(readFileSync(path.join(a.dir, 'queue.json'), 'utf8'));
  Object.assign(saved.tasks[0], { branch: 'old-branch', pr: { number: 9, url: 'old', state: 'OPEN', title: 'Old' }, roleSnapshot: { id: 'old', name: 'Old', responsibilities: '', instructions: '', version: 1 } });
  saved.maxWorkers = 0; writeFileSync(path.join(a.dir, 'queue.json'), JSON.stringify(saved));
  const b = f.open('a', a.workers); task = b.q.state().tasks[0];
  const oldAttempt = task.attemptId;
  assert.equal(b.q.update(task.id, task.version!, { status: 'queued' }, 'Owner'), undefined);
  task = b.q.state().tasks[0];
  for (const key of ['workerId', 'workerName', 'attemptId', 'roleSnapshot', 'branch', 'pr', 'startedAt', 'finishedAt', 'reviewedBy', 'outcome', 'error'] as const) assert.equal(task[key], undefined, key);
  assert.ok(task.history!.some((h) => h.attemptId === oldAttempt));
  b.q.setLimit(1); b.workers.at(-1)!.status = 'done'; b.q.onWorker(b.workers.at(-1)!);
  task = b.q.state().tasks[0]; assert.equal(task.status, 'review'); assert.notEqual(task.attemptId, oldAttempt);
  assert.equal(task.pr, undefined); assert.equal(task.reviewedBy, undefined);
});


test('assigned worker is durably associated and held before its prompt is sent', (t) => {
  const f = fixture(t); const a = f.open('a'); a.q.add('First', 'Owner');
  const worker = a.workers[0]; worker.status = 'done'; a.q.onWorker(worker);
  const held = new Set<string>(); a.manager.holdRecovery = (id) => { held.add(id); };
  a.manager.prompt = (id) => {
    const intent = JSON.parse(readFileSync(path.join(a.dir, 'queue.json'), 'utf8')).tasks.at(-1);
    assert.equal(intent.workerId, id); assert.ok(held.has(id));
    throw new Error('interrupted prompt');
  };
  assert.throws(() => a.q.add('Assigned', 'Owner', undefined, undefined, 'custom', undefined, undefined, { assigneeId: worker.id }), /interrupted prompt/);
});
