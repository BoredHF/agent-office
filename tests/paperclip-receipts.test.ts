import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandReceiptLedger, type CommandIdentity } from '../src/server/paperclip/receipts.js';
const identity: CommandIdentity = { connectionId: 'connection', companyId: 'company', projectId: 'project', officeId: 'office', actorId: 'human', operationId: 'operation', action: 'task.status', requestDigest: 'a'.repeat(64) };
async function fixture(t: any) {
  const root = await mkdtemp(join(tmpdir(), 'paperclip-receipts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, ledger: new CommandReceiptLedger(root) };
}
test('concurrent instances grant at most one submission; restart never resends unknown', async t => {
  const { root, ledger } = await fixture(t);
  const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => new CommandReceiptLedger(root).reserve(identity)));
  assert.equal(attempts.filter(r => r.status === 'fulfilled' && r.value.dispatch).length, 1);
  // A racing reader may encounter an incomplete reservation and fail closed.
  assert.deepEqual(await ledger.reserve(identity), { outcome: 'unknown', dispatch: false });
  assert.deepEqual(await new CommandReceiptLedger(root).reserve(identity), { outcome: 'unknown', dispatch: false });
});
test('changed intent, version digest or action conflicts without a second dispatch', async t => {
  const { ledger } = await fixture(t); await ledger.reserve(identity);
  assert.deepEqual(await ledger.reserve({ ...identity, requestDigest: 'b'.repeat(64) }), { outcome: 'conflict', dispatch: false });
  assert.deepEqual(await ledger.reserve({ ...identity, action: 'task.comment' }), { outcome: 'conflict', dispatch: false });
  await assert.rejects(ledger.resolve({ ...identity, requestDigest: 'b'.repeat(64) }, 'applied'));
});
test('full scope and authenticated actor isolate receipt lookup', async t => {
  const { ledger } = await fixture(t); await ledger.reserve(identity);
  for (const key of ['connectionId', 'companyId', 'projectId', 'officeId', 'actorId'] as const) {
    await assert.rejects(ledger.read({ ...identity, [key]: 'other' }));
  }
});
test('conclusive outcomes survive restart and cannot be overwritten', async t => {
  const { root, ledger } = await fixture(t);
  for (const outcome of ['applied', 'rejected', 'conflict'] as const) {
    const id = { ...identity, operationId: outcome }; await ledger.reserve(id);
    assert.deepEqual(await ledger.resolve(id, outcome), { outcome });
    assert.deepEqual(await ledger.resolve(id, 'applied'), { outcome });
    assert.deepEqual(await new CommandReceiptLedger(root).reserve(id), { outcome, dispatch: false });
  }
});
test('partial/corrupt reservation fails closed and fixed errors omit raw data', async t => {
  const { root, ledger } = await fixture(t); await ledger.reserve(identity);
  const slot = (await readdir(root))[0];
  await writeFile(join(root, slot, 'intent.json'), 'private-secret');
  await assert.rejects(ledger.reserve(identity), { message: 'Command receipt unavailable' });
  await assert.rejects(ledger.resolve(identity, 'applied'), { message: 'Command receipt unavailable' });
});
test('allowlisted persisted fields exclude extra secrets and payloads; path input is rejected', async t => {
  const { root, ledger } = await fixture(t);
  await ledger.reserve({ ...identity, secret: 'private-secret', payload: 'sensitive task text' } as CommandIdentity);
  const slot = (await readdir(root))[0];
  const body = await readFile(join(root, slot, 'intent.json'), 'utf8');
  assert.ok(!body.includes('secret')); assert.ok(!body.includes('sensitive'));
  assert.deepEqual(Object.keys(JSON.parse(body)).sort(), ['intent', 'version']);
  await assert.rejects(ledger.reserve({ ...identity, operationId: '../../private-secret' }), { message: 'Command receipt unavailable' });
});
