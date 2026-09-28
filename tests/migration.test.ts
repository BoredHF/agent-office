import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, symlinkSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Migration, backupOffice, dryRun, type MigrationPort, type Receipt, type Source } from '../src/server/migration/index.js';
const scope = { officeId: 'office', connectionId: 'connection', companyId: 'company', projectId: 'project' };
const source: Source = { version: 1, tasks: [ { id: 'a', title: 'Queued', prompt: 'Work', status: 'queued', version: 2 }, { id: 'b', title: 'Done', prompt: 'History', status: 'done', history: [{ note: 'review evidence' }] }, { id: 'c', title: 'Active', prompt: 'No replay', status: 'running', attemptId: 'attempt' } ], roles: [{ instructions: 'private role' }], assignments: { worker: 'role' }, dispatchPaused: true, receipts: [] };
function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), 'migration-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = new Map<string, Receipt>();
  const events: string[] = []; let idle = true, quiet = true, timeout = false, creates = 0; let excluded: string[] = [];
  const port: MigrationPort = {
    exclusive: async work => work(), localIdle: async () => idle,
    reconcile: async (_scope, mapping) => remote.get(mapping.operationId) ?? null,
    create: async (s, m) => { creates++; events.push(`create:${m.status}`); const r = { scope: s, operationId: m.operationId, sourceVersion: m.sourceVersion, remoteId: `remote-${m.localId}` }; remote.set(m.operationId, r); if (timeout) { timeout = false; throw Error('timeout'); } return r; },
    disableWrites: async () => { events.push('disable'); }, remoteQuiescent: async () => { events.push('reconcile'); return quiet; }, connect: async () => { events.push('connect'); },
    restoreLocal: async (_s, ids) => { events.push('restore'); excluded = ids; },
  };
  return { dir, port, remote, events, engine: new Migration(dir, port), idle: (v: boolean) => { idle = v; }, quiet: (v: boolean) => { quiet = v; }, timeout: () => { timeout = true; }, creates: () => creates, excluded: () => excluded };
}
test('dry run is deterministic, counts unsupported controls and never promotes attempts', () => {
  const report = dryRun(source, scope);
  assert.deepEqual(report, dryRun(JSON.parse(JSON.stringify(source)), scope));
  assert.deepEqual(report.counts, { tasks: 3, eligible: 2, excluded: 1, roles: 1, assignments: 1 });
  assert.deepEqual(report.excluded, ['c']); assert.deepEqual(report.mappings.map(m => m.status), ['backlog', 'done']);
  assert.ok(report.unsupported.includes('receipts')); assert.ok(report.mappings[1].unsupported.includes('history'));
  assert.ok(!JSON.stringify(report).includes('private role'));
  assert.equal(dryRun({ tasks: [{ ...source.tasks[0], attemptId: 'old' }] }, scope).counts.eligible, 0);
  assert.throws(() => dryRun({ tasks: [source.tasks[0], source.tasks[0]] }, scope), /duplicate/);
  assert.throws(() => dryRun({ ...source, version: 2 }, scope), /schema/);
});
test('interrupted resume reconciles once, preserves provenance and dry-run/import counts agree', async t => {
  const f = fixture(t); const report = dryRun(source, scope);
  await f.engine.prepare(source, scope, report.sourceVersion); f.timeout();
  await assert.rejects(f.engine.resume(), /timeout/);
  await new Migration(f.dir, f.port).resume(); await f.engine.resume();
  assert.equal(f.creates(), 2); assert.equal(f.remote.size, report.counts.eligible);
  assert.equal(statSync(join(f.dir, 'source.json')).mode & 0o777, 0o400);
  assert.deepEqual(JSON.parse(readFileSync(join(f.dir, 'source.json'), 'utf8')), source);
  assert.equal(f.events.includes('create:todo'), false);
});
test('unknown outcomes never resubmit, and block rollback with writes disabled', async t => {
  const f = fixture(t); await f.engine.prepare(source, scope, dryRun(source, scope).sourceVersion);
  f.port.create = async () => { throw Error('lost before response'); };
  await assert.rejects(f.engine.resume(), /lost/);
  let retried = false; f.port.create = async () => { retried = true; throw Error('WRONG'); };
  await assert.rejects(f.engine.resume(), /Outcome unknown/); assert.equal(retried, false);
  await assert.rejects(f.engine.rollback(), /Unresolved/); assert.deepEqual(f.events, ['disable']);
});
test('idle guards, scope/source approval and backup integrity fail closed', async t => {
  const f = fixture(t); const report = dryRun(source, scope); f.idle(false);
  await assert.rejects(f.engine.prepare(source, scope, report.sourceVersion), /drained/);
  f.idle(true); await assert.rejects(f.engine.prepare(source, scope, 'old'), /changed/);
  await f.engine.prepare(source, scope, report.sourceVersion);
  await assert.rejects(f.engine.prepare(source, { ...scope, companyId: 'foreign' }, report.sourceVersion), /scope/);
  f.idle(false); await assert.rejects(f.engine.resume(), /stopped/); assert.equal(f.creates(), 0);
  f.idle(true); chmodSync(join(f.dir, 'source.json'), 0o600); writeFileSync(join(f.dir, 'source.json'), JSON.stringify({ tasks: [] }));
  await assert.rejects(f.engine.resume(), /Backup changed/);
});
test('foreign provenance and duplicate remote IDs do not advance checkpoint', async t => {
  const f = fixture(t); await f.engine.prepare(source, scope, dryRun(source, scope).sourceVersion);
  f.port.create = async (s, m) => ({ remoteId: 'foreign', scope: { ...s, companyId: 'elsewhere' }, operationId: m.operationId, sourceVersion: m.sourceVersion });
  await assert.rejects(f.engine.resume(), /provenance/);
  const g = fixture(t); await g.engine.prepare(source, scope, dryRun(source, scope).sourceVersion);
  g.port.create = async (s, m) => ({ remoteId: 'same', scope: s, operationId: m.operationId, sourceVersion: m.sourceVersion });
  await assert.rejects(g.engine.resume(), /Duplicate remote/);
});
test('rollback refuses active remote work and excludes imported IDs from local execution', async t => {
  const f = fixture(t); await f.engine.prepare(source, scope, dryRun(source, scope).sourceVersion);
  await assert.rejects(f.engine.cutover(), /incomplete/); await f.engine.resume();
  await f.engine.cutover(); f.quiet(false);
  await assert.rejects(f.engine.rollback(), /Active or uncertain/); assert.equal(f.events.includes('restore'), false);
  f.quiet(true); await new Migration(f.dir, f.port).rollback(); await f.engine.rollback();
  assert.deepEqual(f.excluded(), ['a', 'b']); assert.equal(f.events.filter(e => e === 'restore').length, 1); assert.equal(f.remote.size, 2);
  assert.ok(f.events.indexOf('disable') < f.events.indexOf('connect'));
  await assert.rejects(f.engine.resume(), /closed/);
});
test('exclusive checkpoint lock blocks simultaneous resume and crash requires operator reconciliation', async t => {
  const f = fixture(t); await f.engine.prepare(source, scope, dryRun(source, scope).sourceVersion);
  writeFileSync(join(f.dir, 'lock'), ''); await assert.rejects(f.engine.resume(), /EEXIST/); assert.equal(f.creates(), 0);
});
test('backup never overwrites and rejects symlinks and nested destination', t => {
  const f = fixture(t), src = join(f.dir, 'src'), dst = join(f.dir, 'backup'); mkdirSync(src); writeFileSync(join(src, 'queue.json'), 'original');
  backupOffice(src, dst); writeFileSync(join(src, 'queue.json'), 'changed');
  assert.throws(() => backupOffice(src, dst), /EEXIST/); assert.equal(readFileSync(join(dst, 'queue.json'), 'utf8'), 'original');
  assert.throws(() => backupOffice(src, join(src, 'nested')), /overlap/);
  symlinkSync(join(src, 'queue.json'), join(src, 'link')); assert.throws(() => backupOffice(src, join(f.dir, 'bad')), /regular/);
});
