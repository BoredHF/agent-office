import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/server/config.js';
import { startServer } from '../src/server/server.js';
import type { ServerMsg } from '../src/shared/protocol.js';

test('connected server startup/restart, arrival, legacy commands and disconnect never construct local runtime', { timeout: 20000 }, async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'connected-office-'));
  const bin = path.join(root, 'bin'); mkdirSync(bin);
  for (const name of ['claude', 'gh', 'opencode']) writeFileSync(path.join(bin, name), `#!/bin/sh\necho invoked >> '${root}/provider-invocations'\nexit 1\n`, { mode: 0o700 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); });
  const cfg = loadConfig(['--home', path.join(root, 'home'), '--password', 'fixture-password', '--host', '127.0.0.1', '--agent', '/bin/cat']);
  cfg.port = 0; cfg.city = undefined; cfg.webhook = undefined;
  const dir = path.join(root, 'office'), data = path.join(dir, '.agent-office'); mkdirSync(data, { recursive: true });
  const binding = { mode: 'paperclip', connectionId: 'conn', companyId: 'company', projectId: 'project' };
  writeFileSync(path.join(cfg.dataDir, 'floors.json'), JSON.stringify({ version: 1, offices: [{ id: 'connected', name: 'Connected', dir, palette: 0, addedBy: 'test', addedAt: 1, orchestration: binding }] }));
  // Deliberately malformed local state: any accidental constructor would read/repair/recover it.
  const saved = { 'workers.json': '[{"id":"old-worker","status":"working"}]', 'queue.json': '{"version":1,"tasks":[{"id":"queued","status":"queued"}]}', 'meetings.json': '{"current":{"status":"running"}}', 'pty-host.json': '{"pid":-1}' };
  for (const [name, content] of Object.entries(saved)) writeFileSync(path.join(data, name), content);
  for (let restart = 0; restart < 3; restart++) {
    let now = Date.parse('2026-09-28T00:00:00Z'), calls = 0, revoked = false;
    let gate: Promise<void> | undefined, started: (() => void) | undefined;
    const app = await startServer(cfg, restart === 0 ? {} : { connectedProvider: {
      resolveConnection: scope => {
        assert.equal(scope.officeId, 'connected');
        return { connectionId: 'conn', companyId: 'company', origin: 'https://paperclip.example', approvedOrigins: ['https://paperclip.example'], companyPrefix: 'AGE', credential: async () => 'server-secret' };
      },
      readOptions: { now: () => now, random: () => 0, transport: (async (input, init) => {
        calls++;
        started?.(); await gate;
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer server-secret');
        if (revoked) return new Response('', { status: 401 });
        const url = new URL(String(input));
        return Response.json(url.pathname.endsWith('/projects') ? [{ id: 'project', companyId: 'company', name: 'Project', status: 'in_progress' }]
          : url.pathname.endsWith('/issues') ? [{ id: 'remote-task', companyId: 'company', projectId: 'project', title: 'Remote task', status: 'todo', priority: 'medium', statusVersion: 1, updatedAt: '2026-09-28T00:00:00Z', secret: 'upstream-secret' }] : []);
      }) as typeof fetch },
    } });
    try {
      const floor = app.floors()[0]; assert.ok(floor); assert.equal(floor.local, undefined);
      assert.throws(() => floor.workers, /Local execution is unavailable/);
      assert.throws(() => floor.queue, /Local execution is unavailable/);
      assert.throws(() => floor.meetings, /Local execution is unavailable/);
      const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const login = await fetch(`${origin}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ password: 'fixture-password' }) });
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const messages: ServerMsg[] = [];
      const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws?name=Tester', { headers: { cookie, origin } });
      ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
      const next = async (type: string) => {
        const until = Date.now() + 3000;
        while (Date.now() < until) {
          const at = messages.findIndex((m) => m.t === type);
          if (at >= 0) return messages.splice(at, 1)[0];
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error(`Missing ${type}`);
      };
      try {
        const welcome = await next('welcome'); assert.equal(welcome.t, 'welcome');
        if (welcome.t === 'welcome') { assert.equal(welcome.orchestration?.state, 'disconnected'); assert.deepEqual(welcome.workers, []); assert.deepEqual(welcome.queue.tasks, []); }
        ws.send(JSON.stringify({ t: 'orchestration.refresh', officeId: 'foreign', visible: true }));
        const crossOffice = await next('toast');
        assert.ok(crossOffice.t === 'toast' && /Office context changed/.test(crossOffice.text));
        assert.equal(calls, 0);
        const refresh = async () => {
          ws.send(JSON.stringify({ t: 'orchestration.refresh', officeId: 'connected', visible: true }));
          const result = await next('orchestration'); assert.equal(result.t, 'orchestration');
          if (result.t !== 'orchestration') throw new Error('Missing snapshot');
          assert.ok(!JSON.stringify(result).includes('secret'));
          return result.snapshot;
        };
        const snapshot = await refresh();
        assert.equal(snapshot.state, restart ? 'connected' : 'disconnected');
        assert.equal(snapshot.scope.officeId, 'connected');
        assert.deepEqual(snapshot.tasks.map(t => t.source.id), restart ? ['remote-task'] : []);
        const initialCalls = calls; await refresh(); assert.equal(calls, initialCalls);
        if (restart) {
          let release!: () => void;
          gate = new Promise<void>(resolve => { release = resolve; });
          const reading = new Promise<void>(resolve => { started = resolve; });
          now += 6000;
          ws.send(JSON.stringify({ t: 'orchestration.refresh', officeId: 'connected', visible: true }));
          await reading;
          ws.send(JSON.stringify({ t: 'floor.go', floor: '@roof' })); await next('floor.enter');
          release();
          // Await the coalesced read, then a websocket round trip as a delivery barrier.
          await floor.provider.refresh!(true);
          ws.send(JSON.stringify({ t: 'chat', officeId: '@roof', text: 'delivery barrier' })); await next('chat');
          assert.equal(messages.some(m => m.t === 'orchestration'), false);
          ws.send(JSON.stringify({ t: 'orchestration.refresh', officeId: 'connected', visible: true }));
          const denied = await next('toast'); assert.ok(denied.t === 'toast' && /Office context changed/.test(denied.text));
          ws.send(JSON.stringify({ t: 'floor.go', floor: 'connected' })); await next('floor.enter');
          gate = undefined; started = undefined;
          revoked = true; now += 6000;
          const cleared = await refresh(); assert.equal(cleared.state, 'disconnected'); assert.deepEqual(cleared.tasks, []);
          const revokedCalls = calls; now += 60000; await refresh(); assert.equal(calls, revokedCalls);
          assert.equal(floor.local, undefined);
        }
        for (const type of ['worker.spawn', 'worker.resume', 'station.prompt', 'term.input', 'queue.add', 'queue.retry', 'meeting.start', 'role.assign', 'task.update', 'control']) {
          ws.send(JSON.stringify({ t: type, officeId: 'connected', deskId: 'desk-1', prompt: 'must not run' }));
          const denied = await next('toast'); assert.ok(denied.t === 'toast' && /Local execution is unavailable/.test(denied.text));
        }
        const models = await fetch(`${origin}/api/agents/opencode/models?floor=connected`, { headers: { cookie } }); assert.equal(models.status, 403);
        const file = await fetch(`${origin}/api/changes/file?floor=connected&worker=old-worker&path=x&side=new`, { headers: { cookie } }); assert.equal(file.status, 403);
        const hook = await fetch(`http://127.0.0.1:${app.hookPort}/office/queue?worker=old-worker`, { method: 'POST', headers: { authorization: 'Bearer stale-token' }, body: '{}' }); assert.equal(hook.status, 401);
        floor.provider.disconnect(); floor.arrived();
        const disconnectedCalls = calls; now += 60000; await refresh(); assert.equal(calls, disconnectedCalls);
        ws.send(JSON.stringify({ t: 'chat', officeId: 'connected', text: 'visual collaboration remains available' })); await next('chat');
        assert.equal(floor.local, undefined);
      } finally { ws.terminate(); }
    } finally { app.shutdown(); }
    for (const [name, content] of Object.entries(saved)) assert.equal(readFileSync(path.join(data, name), 'utf8'), content);
    assert.equal(existsSync(path.join(data, 'pty-host.log')), false);
    assert.equal(existsSync(path.join(root, 'provider-invocations')), false);
  }
});
