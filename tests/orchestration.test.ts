import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOrchestrationProvider } from '../src/server/orchestration.js';
import { officeBinding, sameProviderScope, isLocalExecutionMessage, type ProviderScope } from '../src/shared/orchestration.js';

const binding = { mode: 'paperclip', connectionId: 'connection', companyId: 'company', projectId: 'project' } as const;
test('connected selection never invokes local construction, disconnect or restart recovery', async () => {
  let calls = 0;
  const local = () => { calls++; throw new Error('Local execution attempted'); };
  for (let i = 0; i < 2; i++) {
    const p = createOrchestrationProvider('office', binding, local);
    assert.equal(p.snapshot().state, 'disconnected');
    assert.ok(Object.values(p.snapshot().capabilities).every((x) => !x));
    p.disconnect();
    assert.equal(p.snapshot().scope.mode, 'paperclip');
    const result = await p.command({ operationId: 'stable-op', scope: p.scope, action: 'agent.wake', payload: {} });
    assert.equal(result.outcome, 'rejected');
    p.shutdown(true);
  }
  assert.equal(calls, 0);
});
test('malformed bindings fail closed; legacy absence alone defaults to local', () => {
  assert.deepEqual(officeBinding(undefined), { mode: 'local' });
  for (const value of [null, {}, { mode: 'unknown' }, { ...binding, projectId: '' }, { ...binding, token: 'must-not-be-a-DTO' }]) {
    assert.throws(() => createOrchestrationProvider('office', value as never, () => { throw new Error('WRONG'); }), /Invalid orchestration binding/);
  }
});
test('scope equality checks every isolation dimension and legacy controls remain local', () => {
  const scope: ProviderScope = { ...binding, officeId: 'office' };
  assert.equal(sameProviderScope(scope, { ...scope }), true);
  for (const key of ['officeId', 'connectionId', 'companyId', 'projectId']) assert.equal(sameProviderScope(scope, { ...scope, [key]: 'foreign' }), false);
  for (const t of ['control', 'worker.spawn', 'worker.resume', 'queue.retry', 'task.update', 'meeting.start', 'station.prompt', 'term.input', 'role.assign']) assert.equal(isLocalExecutionMessage(t), true);
  for (const t of ['chat', 'move', 'wb.update', 'floor.go']) assert.equal(isLocalExecutionMessage(t), false);
});
