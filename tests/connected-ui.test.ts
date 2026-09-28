import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalUrl, taskGroups, connectionSummary } from '../src/client/ui/connected-model.js';
import { store } from '../src/client/state.js';
import { NO_PROVIDER_CAPABILITIES, type ProviderSnapshot } from '../src/shared/orchestration.js';

const snapshot: ProviderSnapshot = {
  schemaVersion: 1, scope: { mode: 'paperclip', officeId: 'office', connectionId: 'connection', companyId: 'company', projectId: 'project' },
  capabilities: { ...NO_PROVIDER_CAPABILITIES }, state: 'connected', lastSuccessfulSync: null,
  tasks: [{ source: { id: 'task' }, title: 'Review me', nativeStatus: 'in_review', displayStatus: 'done' }],
  agents: [], activity: [{ source: { id: 'run' }, taskId: 'task', at: '2026-09-28T00:00:00Z', text: 'Run completed' }],
};
test('native task status survives run completion and display labels; unknown statuses stay visible', () => {
  const groups = taskGroups([...snapshot.tasks, { ...snapshot.tasks[0], nativeStatus: 'future_status' }]);
  assert.equal(groups.find(([s]) => s === 'in_review')![1].length, 1);
  assert.equal(groups.find(([s]) => s === 'done')![1].length, 0);
  assert.equal(groups.find(([s]) => s === 'future_status')![1].length, 1);
});
test('canonical links reject executable, relative, insecure and credential-bearing URLs', () => {
  assert.equal(canonicalUrl('https://paperclip.example/AGE/issues/AGE-13'), 'https://paperclip.example/AGE/issues/AGE-13');
  for (const value of [undefined, 'javascript:alert(1)', 'data:text/html,x', '/issue/1', 'http://example.com', 'https://user:secret@example.com', 'https://example.com/?token=secret']) assert.equal(canonicalUrl(value), undefined);
});
test('snapshot updates reject every foreign scope dimension and retain native task status', () => {
  store.floor = 'office'; store.orchestration = snapshot;
  let updates = 0;
  const off = store.on('orchestration', () => updates++);
  for (const key of ['officeId', 'connectionId', 'companyId', 'projectId']) {
    store.apply({ t: 'orchestration', snapshot: { ...snapshot, scope: { ...snapshot.scope, [key]: 'foreign' } } });
    assert.equal(store.orchestration, snapshot);
  }
  assert.equal(updates, 0);
  store.apply({ t: 'orchestration', snapshot: { ...snapshot, state: 'stale' } });
  assert.equal(updates, 1);
  assert.equal(store.orchestration.tasks[0].nativeStatus, 'in_review');
  assert.equal(store.orchestration.state, 'stale');
  off(); store.orchestration = null;
  store.apply({ t: 'orchestration', snapshot });
  assert.equal(store.orchestration, null);
});
test('connection status does not invent successful sync evidence', () => {
  assert.match(connectionSummary(snapshot), /connected.*Never/);
  assert.match(connectionSummary({ ...snapshot, state: 'disconnected', lastSuccessfulSync: 'invalid' }), /disconnected.*Never/);
});

import { parseCatalog, setupRequest, createdOffice } from '../src/client/ui/connected-setup-model.js';
test('catalog preserves connection/company grouping and strips unexpected server fields', () => {
  const project = { connectionId: 'one', companyId: 'company', projectId: 'project', name: 'Project' };
  assert.deepEqual(parseCatalog({ projects: [{ ...project, credential: 'must not copy' }] }), [project]);
  assert.deepEqual(parseCatalog({ projects: [] }), []);
  assert.throws(() => parseCatalog({ projects: [{ name: 'bad' }] }));
  assert.throws(() => parseCatalog({ projects: Array(101).fill(project) }));
});
test('setup reconciliation keeps the exact payload and rejects wrong scope responses', () => {
  const project = { connectionId: 'one', companyId: 'company', projectId: 'project', name: 'Project' };
  const request = setupRequest(project, ' Office ', 'stable-id');
  assert.equal(request.name, 'Office');
  assert.equal(Object.isFrozen(request), true);
  assert.deepEqual(Object.keys(request).sort(), ['companyId', 'connectionId', 'name', 'projectId', 'requestId']);
  const result = { officeId: 'office', scope: { mode: 'paperclip', officeId: 'office', ...project } };
  assert.equal(createdOffice(result, request), 'office');
  for (const key of ['mode', 'officeId', 'connectionId', 'companyId', 'projectId']) {
    assert.throws(() => createdOffice({ ...result, scope: { ...result.scope, [key]: 'foreign' } }, request));
  }
  assert.throws(() => setupRequest(project, ' ', 'id'));
});
