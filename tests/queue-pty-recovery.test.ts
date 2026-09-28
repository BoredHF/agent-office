import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WorkerManager } from '../src/server/workers.js';
import { Ledger } from '../src/server/usage.js';
import { TaskQueue } from '../src/server/queue.js';

test('real hosted PTY survives two manager restarts with the same attempt; dead PTY blocks', { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'queue-pty-'));
  const data = path.join(dir, '.agent-office'); mkdirSync(data);
  const log = path.join(dir, 'launches');
  const agent = path.join(dir, 'fixture-agent');
  // Fixture only records a PID, emits readiness and waits; no model or external requests.
  writeFileSync(agent, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, process.pid + '\\n');\nprocess.stdout.write('fixture ready\\r\\n');\nprocess.stdin.resume();\n`, { mode: 0o700 });
  const fakeBin = path.join(dir, 'bin'); mkdirSync(fakeBin);
  writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const oldPath = process.env.PATH; process.env.PATH = `${fakeBin}:${oldPath}`;
  const managers: WorkerManager[] = []; const queues: TaskQueue[] = [];
  t.after(() => { queues.forEach((q) => q.shutdown()); managers.forEach((m) => m.shutdown()); process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
  async function open() {
    let queue: TaskQueue | undefined;
    const workers = new WorkerManager(dir, data, agent, [], { url: 'http://127.0.0.1:1', token: '' }, {
      update: (w) => queue?.onWorker(w), remove: (id) => queue?.onWorkerGone(id), data() {}, screen() {}, toast() {},
    }, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
    managers.push(workers);
    queue = new TaskQueue(data, workers, false, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {} }, true);
    queues.push(queue);
    await workers.start(queue.state().tasks.flatMap((task) => task.workerId ? [task.workerId] : []));
    queue.start();
    return { workers, queue };
  }
  const a = await open(); a.queue.add('Synthetic work', 'QA');
  const task = a.queue.state().tasks[0];
  for (let i = 0; i < 100; i++) {
    try { if (readFileSync(log, 'utf8').trim()) break; } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }
  const pid = Number(readFileSync(log, 'utf8').trim());
  assert.ok(pid > 0);
  const saved = JSON.parse(readFileSync(path.join(data, 'workers.json'), 'utf8'));
  assert.ok(saved[0]?.pty?.id, 'fixture must use the surviving PTY host, not in-process fallback');
  a.queue.shutdown(); a.workers.shutdown(true);
  const b = await open();
  assert.equal(b.queue.state().tasks[0].status, 'running');
  assert.equal(b.queue.state().tasks[0].attemptId, task.attemptId);
  process.kill(pid, 0);
  b.queue.shutdown(); b.workers.shutdown(true);
  const c = await open();
  assert.equal(c.queue.state().tasks[0].status, 'running');
  assert.equal(c.queue.state().tasks[0].workerId, task.workerId);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
  c.queue.shutdown(); c.workers.shutdown();
  await new Promise((r) => setTimeout(r, 150));
  const d = await open(); d.workers.wakeAll(); d.queue.pump();
  assert.equal(d.queue.state().tasks[0].status, 'blocked');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
});

test('dispatch crash after worker persistence preserves its recovery association', { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'queue-pty-'));
  const data = path.join(dir, '.agent-office'); mkdirSync(data);
  const log = path.join(dir, 'launches');
  const agent = path.join(dir, 'fixture-agent');
  // Fixture only records a PID, emits readiness and waits; no model or external requests.
  writeFileSync(agent, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, process.pid + '\\n');\nprocess.stdout.write('fixture ready\\r\\n');\nprocess.stdin.resume();\n`, { mode: 0o700 });
  const fakeBin = path.join(dir, 'bin'); mkdirSync(fakeBin);
  writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  const oldPath = process.env.PATH; process.env.PATH = `${fakeBin}:${oldPath}`;
  const managers: WorkerManager[] = []; const queues: TaskQueue[] = [];
  t.after(() => { queues.forEach((q) => q.shutdown()); managers.forEach((m) => m.shutdown()); process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });
  async function open() {
    let queue: TaskQueue | undefined;
    const workers = new WorkerManager(dir, data, agent, [], { url: 'http://127.0.0.1:1', token: '' }, {
      update: (w) => queue?.onWorker(w), remove: (id) => queue?.onWorkerGone(id), data() {}, screen() {}, toast() {},
    }, new Ledger(data, { pauseHiring: false }, () => {}, () => {}));
    managers.push(workers);
    queue = new TaskQueue(data, workers, false, { update() {}, toast() {}, claimIssue: async () => undefined, refreshGitHub() {}, hiringPaused: () => undefined, emptied() {} }, true);
    queues.push(queue);
    await workers.start(queue.state().tasks.flatMap((task) => task.workerId ? [task.workerId] : []));
    queue.start();
    return { workers, queue };
  }
  const a = await open();
  const spawn = a.workers.spawn.bind(a.workers);
  a.workers.spawn = (...args) => {
    const worker = spawn(...args);
    assert.notEqual(typeof worker, 'string');
    const intent = JSON.parse(readFileSync(path.join(data, 'queue.json'), 'utf8')).tasks[0];
    assert.equal(intent.workerId, (worker as { id: string }).id);
    assert.equal(intent.status, 'blocked');
    throw new Error('simulated crash after workers.json persistence');
  };
  assert.throws(() => a.queue.add('Synthetic work', 'QA'), /simulated crash/);
  const task = a.queue.state().tasks[0];
  for (let i = 0; i < 100; i++) {
    try { if (readFileSync(log, 'utf8').trim()) break; } catch {}
    await new Promise((r) => setTimeout(r, 20));
  }
  const pid = Number(readFileSync(log, 'utf8').trim());
  assert.ok(pid > 0);
  const saved = JSON.parse(readFileSync(path.join(data, 'workers.json'), 'utf8'));
  assert.ok(saved[0]?.pty?.id, 'fixture must use the surviving PTY host, not in-process fallback');
  a.queue.shutdown(); a.workers.shutdown(true);
  const b = await open();
  assert.equal(b.queue.state().tasks[0].status, 'blocked');
  assert.equal(b.queue.state().tasks[0].attemptId, task.attemptId);
  process.kill(pid, 0);
  assert.match(b.queue.retry(task.id)!, /still active/);
  b.queue.shutdown(); b.workers.shutdown(true);
  const c = await open();
  assert.equal(c.queue.state().tasks[0].status, 'blocked');
  assert.equal(c.queue.state().tasks[0].workerId, task.workerId);
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
  c.queue.shutdown(); c.workers.shutdown();
  await new Promise((r) => setTimeout(r, 150));
  const d = await open(); d.workers.wakeAll(); d.queue.pump();
  assert.equal(d.queue.state().tasks[0].status, 'blocked');
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, 1);
});
