import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PaperclipReadProvider, type PaperclipConnection } from '../src/server/paperclip/reads.js';
const scope = { mode: 'paperclip' as const, officeId: 'office', connectionId: 'connection', companyId: 'company', projectId: 'project' };
const connection: PaperclipConnection = { connectionId: 'connection', companyId: 'company', origin: 'https://paperclip.example', approvedOrigins: ['https://paperclip.example'], companyPrefix: 'AGE', credential: async () => 'server-secret' };
const task = (id = 'task') => ({ id, companyId: 'company', projectId: 'project', title: id, status: 'in_progress', priority: 'critical', statusVersion: 2, updatedAt: '2026-09-28T00:00:00Z', assigneeAgentId: 'agent', adapterConfig: { secret: 'private-secret' } });
const project = { id: 'project', companyId: 'company', name: 'Project', status: 'in_progress' };
const agent = { id: 'agent', companyId: 'company', name: 'Agent', status: 'running', adapterConfig: { token: 'private-secret' } };
function harness(overrides: (url: URL) => unknown = () => undefined, options: Record<string, unknown> = {}) {
  let now = Date.parse('2026-09-28T00:00:00Z'); const calls: URL[] = [];
  const transport = (async (input: string | URL | Request, init: RequestInit) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(init.redirect, 'error'); assert.equal((init.headers as any).Authorization, 'Bearer server-secret');
    const custom = overrides(url);
    if (custom instanceof Response) return custom;
    const body = custom ?? (url.pathname.endsWith('/projects') ? [project] : url.pathname.endsWith('/agents') ? [agent] : url.pathname.endsWith('/activity') ? [] : [task()]);
    return Response.json(body);
  }) as typeof fetch;
  const provider = new PaperclipReadProvider(scope, connection, { transport, now: () => now, random: () => 0, ...options });
  return { provider, calls, advance: (ms = 6000) => { now += ms; } };
}
test('projects and scoped snapshots project native state, canonical links and omit secrets', async () => {
  const { provider } = harness();
  assert.deepEqual(await provider.projects(), [{ id: 'project', name: 'Project', nativeStatus: 'in_progress', url: 'https://paperclip.example/AGE/projects/project' }]);
  const value = await provider.refresh();
  assert.equal(value.state, 'connected'); assert.equal(value.tasks[0].nativeStatus, 'in_progress');
  assert.equal(value.tasks[0].priority, 'critical'); assert.equal(value.tasks[0].source.version, '2');
  assert.equal(value.tasks[0].source.url, 'https://paperclip.example/AGE/issues/task');
  assert.deepEqual(value.agents[0].activeTaskIds, ['task']);
  assert.ok(!JSON.stringify(value).includes('secret'));
  assert.ok(Object.values(value.capabilities).every(v => !v));
  value.tasks.length = 0; assert.equal(provider.snapshot().tasks.length, 1);
});
test('empty task/agent/activity arrays are valid; missing selected project is rejected', async () => {
  const { provider } = harness(url => url.pathname.endsWith('/projects') ? [project] : []);
  assert.equal((await provider.refresh()).state, 'connected');
  const missing = harness(() => []).provider; assert.equal((await missing.refresh()).state, 'disconnected');
});
test('offset windows complete only after a short page and preserve all task IDs', async () => {
  const { provider, calls } = harness(url => url.pathname.endsWith('/issues') ? (url.searchParams.get('offset') === '0' ? [task('a'), task('b')] : [task('c')]) : undefined, { pageSize: 2 });
  const value = await provider.refresh(); assert.equal(value.state, 'connected');
  assert.deepEqual(value.tasks.map(t => t.source.id), ['a', 'b', 'c']);
  assert.deepEqual(calls.filter(u => u.pathname.endsWith('/issues')).map(u => u.searchParams.get('offset')), ['0', '2']);
  assert.ok(calls.filter(u => u.pathname.endsWith('/issues')).every(u => u.searchParams.get('projectId') === 'project'));
});
test('repeated pages, page caps, oversized pages and malformed payloads never publish a partial snapshot', async () => {
  for (const [body, options] of [
    [[task()], { pageSize: 1 }], [[task()], { pageSize: 1, maxPages: 1 }],
    [[task('a'), task('b')], { pageSize: 1 }], [{ items: [] }, {}],
    [[{ ...task(), status: 'queued' }], {}], [[{ ...task(), statusVersion: -1 }], {}],
    [[{ ...task(), updatedAt: 'yesterday' }], {}], [[{ ...task(), title: null }], {}],
  ] as const) {
    const { provider } = harness(u => u.pathname.endsWith('/issues') ? body : undefined, options);
    const value = await provider.refresh(); assert.equal(value.state, 'disconnected'); assert.equal(value.tasks.length, 0);
  }
});
test('foreign company and project IDs fail closed and halt further reads', async () => {
  for (const key of ['companyId', 'projectId']) {
    const { provider, calls, advance } = harness(u => u.pathname.endsWith('/issues') ? [{ ...task(), [key]: 'foreign' }] : undefined);
    const value = await provider.refresh(); assert.match(value.error!, /scope/); const count = calls.length;
    advance(); await provider.refresh(); assert.equal(calls.length, count);
  }
  assert.throws(() => new PaperclipReadProvider(scope, { ...connection, connectionId: 'other' }));
  assert.throws(() => new PaperclipReadProvider(scope, { ...connection, companyId: 'other' }));
});
test('only activity resolved to validated project tasks is visible', async () => {
  const activity = (entityType: string, entityId: string, id: string) => ({ id, companyId: 'company', entityType, entityId, action: 'issue.updated', createdAt: '2026-09-28T00:00:00Z', details: { secret: 'private-secret' } });
  const { provider } = harness(u => u.pathname.endsWith('/activity') ? [activity('issue', 'task', 'a'), activity('issue', 'foreign', 'b'), activity('agent', 'agent', 'c')] : undefined);
  const value = await provider.refresh(); assert.deepEqual(value.activity.map(a => a.source.id), ['a']); assert.ok(!JSON.stringify(value).includes('secret'));
});
test('permission-limited optional reads preserve tasks and do not grant write capabilities', async () => {
  const { provider } = harness(u => u.pathname.endsWith('/agents') ? new Response('private-secret', { status: 403 }) : undefined);
  const value = await provider.refresh(); assert.equal(value.state, 'permission-limited'); assert.equal(value.tasks.length, 1); assert.equal(value.agents.length, 0);
});
test('revocation clears data and halts immediately; explicit reconnect resumes reads', async () => {
  let revoked = false;
  const { provider, calls, advance } = harness(() => revoked ? new Response('secret', { status: 401 }) : undefined);
  const before = await provider.refresh(); revoked = true; advance();
  const after = await provider.refresh(); assert.equal(after.state, 'disconnected'); assert.deepEqual(after.tasks, []); assert.equal(after.lastSuccessfulSync, before.lastSuccessfulSync);
  const count = calls.length; advance(500_000); await provider.refresh(); assert.equal(calls.length, count);
  revoked = false; provider.reconnect(); assert.equal((await provider.refresh()).state, 'connected');
});
test('throttling honors Retry-After; stale data keeps last success; success resets backoff', async () => {
  let throttled = false;
  const { provider, calls, advance } = harness(() => throttled ? new Response('secret', { status: 429, headers: { 'Retry-After': '60' } }) : undefined);
  const first = await provider.refresh(); advance(); throttled = true;
  const stale = await provider.refresh(); assert.equal(stale.state, 'stale'); assert.equal(stale.lastSuccessfulSync, first.lastSuccessfulSync); assert.equal(stale.tasks.length, 1);
  const count = calls.length; advance(59_000); await provider.refresh(); assert.equal(calls.length, count);
  advance(1000); throttled = false; assert.equal((await provider.refresh()).state, 'connected');
});
test('refresh coalesces, enforces visible/inactive cadence, and reports aged snapshots', async () => {
  const { provider, calls, advance } = harness();
  const a = provider.refresh(false); assert.equal(a, provider.refresh()); await a;
  const count = calls.length; advance(29_000); await provider.refresh(); assert.equal(calls.length, count);
  advance(1000); await provider.refresh(); assert.ok(calls.length > count);
  advance(61_000); assert.equal(provider.snapshot().state, 'stale');
});
test('disconnect during an in-flight request cannot republish old data', async () => {
  let release!: (r: Response) => void;
  const provider = new PaperclipReadProvider(scope, connection, { transport: (() => new Promise<Response>(r => { release = r; })) as typeof fetch });
  const pending = provider.refresh(); await new Promise(r => setImmediate(r)); provider.disconnect();
  release(Response.json([project])); assert.equal((await pending).state, 'disconnected'); assert.deepEqual(provider.snapshot().tasks, []);
});
test('unsafe origins and malformed configuration fail before sending credentials', () => {
  for (const origin of ['http://paperclip.example', 'https://user:pass@paperclip.example', 'https://paperclip.example/path', 'https://evil.example', 'https://paperclip.example?secret=yes']) assert.throws(() => new PaperclipReadProvider(scope, { ...connection, origin }));
  assert.throws(() => new PaperclipReadProvider(scope, connection, { maxPages: NaN }));
});
test('redirects, network and JSON failures emit fixed errors only', async () => {
  for (const transport of [
    (async () => new Response('private-secret', { status: 302, headers: { Location: 'https://evil.example' } })) as typeof fetch,
    (async () => { throw new Error('private-secret'); }) as typeof fetch,
    (async () => new Response('private-secret')) as typeof fetch,
  ]) {
    const provider = new PaperclipReadProvider(scope, connection, { transport });
    const value = await provider.refresh(); assert.equal(value.state, 'disconnected'); assert.ok(!JSON.stringify(value).includes('secret'));
  }
});
test('response byte limit and deadline cover body consumption', async () => {
  const oversized = harness(() => new Response('x'.repeat(200)), { maxBytes: 100 });
  assert.equal((await oversized.provider.refresh()).state, 'disconnected');
  const provider = new PaperclipReadProvider(scope, connection, { timeoutMs: 10, transport: (async () => new Response(new ReadableStream({ start() {} }))) as typeof fetch });
  // Keep the test alive while the native unref'ed deadline fires.
  const keepAlive = setTimeout(() => {}, 1000);
  try { assert.equal((await provider.refresh()).state, 'disconnected'); } finally { clearTimeout(keepAlive); }
});
test('scope instances are isolated and commands cannot dispatch', async () => {
  const { provider } = harness(); await provider.refresh();
  const other = new PaperclipReadProvider({ ...scope, officeId: 'other', projectId: 'other-project' }, connection);
  assert.equal(other.snapshot().tasks.length, 0);
  const result = await provider.command({ operationId: 'op', scope: other.scope, action: 'task.status', payload: {} });
  assert.equal(result.outcome, 'rejected'); assert.equal(result.message, 'Office context changed');
});
test('required permission revocation clears cached records and discovery shares auth halt', async () => {
  let status = 200;
  const { provider, calls, advance } = harness(() => status !== 200 ? new Response('', { status }) : undefined);
  await provider.refresh(); status = 403; advance();
  const denied = await provider.refresh(); assert.equal(denied.state, 'permission-limited'); assert.deepEqual(denied.tasks, []);
  status = 401; advance(); await provider.refresh(); const count = calls.length;
  assert.deepEqual(await provider.projects(), []); assert.equal(calls.length, count);
});
test('jitter and exponential backoff remain capped and reads recover', async () => {
  let denied = true;
  const { provider, calls, advance } = harness(() => denied ? new Response('', { status: 503 }) : undefined, { random: () => 1 });
  for (const delay of [6000, 12000, 24000, 48000, 96000, 192000, 300000, 300000]) {
    await provider.refresh(); const count = calls.length;
    advance(delay - 1); await provider.refresh(); assert.equal(calls.length, count);
    advance(1);
  }
  denied = false; assert.equal((await provider.refresh()).state, 'connected');
});
