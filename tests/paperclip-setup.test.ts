import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { startServer } from '../src/server/server.js';
import { loadConfig } from '../src/server/config.js';
import type { ServerMsg } from '../src/shared/protocol.js';

test('real-server connected setup: auth, scope, durable deduplication, reconnect and secret boundaries', { timeout: 20000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'paperclip-setup-'));
  const bin = path.join(root, 'bin'); mkdirSync(bin);
  for (const name of ['claude', 'gh', 'opencode']) writeFileSync(path.join(bin, name), `#!/bin/sh\necho invoked >> '${root}/invoked'\nexit 1\n`, { mode: 0o700 });
  const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath}`;
  t.after(() => { process.env.PATH = oldPath; rmSync(root, { recursive: true, force: true }); });
  const cfg = loadConfig(['--home', path.join(root, 'home'), '--password', 'fixture-password', '--host', '127.0.0.1', '--agent', '/bin/cat']);
  cfg.port = 0; cfg.city = undefined; cfg.webhook = undefined;
  mkdirSync(path.join(root, 'seed'));
  const scope = { connectionId: 'conn', companyId: 'company', projectId: 'project' };
  writeFileSync(path.join(cfg.dataDir, 'floors.json'), JSON.stringify({ version: 1, offices: [{ id: 'seed', name: 'Seed', dir: path.join(root, 'seed'), palette: 0, addedBy: 'test', addedAt: 1, orchestration: { mode: 'paperclip', ...scope } }] }));
  let revoked = false, enabled = true, configured = true, foreign = false, calls = 0, resolves = 0, now = Date.now();
  let gate: Promise<void> | undefined, started: (() => void) | undefined;
  let created: string | undefined;
  for (let restart = 0; restart < 2; restart++) {
    const app = await startServer(cfg, { connectedProvider: {
      setupScopes: () => enabled ? [scope] : [],
      resolveConnection: () => {
        resolves++;
        return configured ? { connectionId: 'conn', companyId: 'company', origin: 'https://paperclip.example', approvedOrigins: ['https://paperclip.example'], companyPrefix: 'AGE', credential: async () => 'credential-secret' } : undefined;
      },
      readOptions: { now: () => now, random: () => 0, transport: (async (input, init) => {
        calls++; started?.(); await gate; assert.equal(init?.method, 'GET');
        assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer credential-secret');
        if (revoked) return new Response('upstream-secret', { status: 401 });
        return Response.json(new URL(String(input)).pathname.endsWith('/projects') ? [{ id: 'project', companyId: foreign ? 'foreign' : 'company', name: 'Project', status: 'in_progress', token: 'upstream-secret' }] : []);
      }) as typeof fetch },
    } });
    try {
      const origin = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const login = await fetch(origin + '/api/login', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password: 'fixture-password' }) });
      const cookie = login.headers.get('set-cookie')!.split(';')[0];
      const get = () => fetch(origin + '/api/paperclip/catalog', { headers: { cookie } });
      const request = { requestId: 'create-once', name: 'Connected', ...scope };
      const post = (body: unknown, headers = { cookie, origin }) => fetch(origin + '/api/paperclip/offices', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const safe = async (r: Response) => { const text = await r.text(); assert.doesNotMatch(text, /secret|paperclip\.example|Authorization/); return JSON.parse(text); };
      assert.equal((await fetch(origin + '/api/paperclip/catalog')).status, 401);
      assert.equal((await post(request, { cookie: '', origin })).status, 401);
      assert.equal((await post(request, { cookie, origin: 'https://foreign.example' })).status, 403);
      const before = calls;
      for (const change of [{ companyId: 'foreign' }, { projectId: 'foreign' }, { connectionId: 'foreign' }, { credential: 'browser-secret' }, { origin: 'https://foreign.example' }]) {
        const r = await post({ ...request, ...change }); assert.ok(r.status >= 400); await safe(r);
      }
      assert.equal(calls, before);
      enabled = false; assert.deepEqual(await safe(await get()), { projects: [] }); enabled = true;
      foreign = true; assert.deepEqual(await safe(await get()), { projects: [] }); assert.equal((await post(request)).status, 409); foreign = false;
      assert.deepEqual(await safe(await get()), { projects: [{ ...scope, name: 'Project' }] });
      revoked = true; assert.deepEqual(await safe(await get()), { projects: [] }); await safe(await post(request)); revoked = false;
      const both = await Promise.all([post(request), post(request)]);
      assert.deepEqual(both.map(r => r.status), [200, 200]);
      const first = await safe(both[0]), second = await safe(both[1]);
      assert.equal(first.officeId, second.officeId);
      if (created) assert.equal(first.officeId, created); created = first.officeId;
      assert.equal(app.floors().length, 2);
      assert.equal((await post({ ...request, name: 'Changed' })).status, 409);
      for (const floor of app.floors()) assert.equal(floor.local, undefined);
      const messages: ServerMsg[] = [];
      const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws?name=Tester', { headers: { cookie, origin } });
      ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
      const next = async (type: string) => {
        const end = Date.now() + 3000;
        while (Date.now() < end) {
          const at = messages.findIndex(m => m.t === type);
          if (at >= 0) return messages.splice(at, 1)[0];
          await new Promise(r => setTimeout(r, 5));
        }
        throw new Error(`Missing ${type}`);
      };
      try {
        await next('welcome');
        ws.send(JSON.stringify({ t: 'floor.go', floor: created })); await next('floor.enter');
        const snapshot = async (type: string) => {
          ws.send(JSON.stringify({ t: type, officeId: created, visible: true }));
          const msg = await next('orchestration'); assert.equal(msg.t, 'orchestration');
          assert.doesNotMatch(JSON.stringify(msg), /secret/);
          if (msg.t !== 'orchestration') throw new Error('Missing snapshot'); return msg.snapshot;
        };
        assert.equal((await snapshot('orchestration.refresh')).state, 'connected');
        revoked = true; now += 6000;
        assert.equal((await snapshot('orchestration.refresh')).state, 'disconnected');
        const halted = calls; revoked = false; now += 6000;
        await snapshot('orchestration.refresh'); assert.equal(calls, halted);
        const oldResolves = resolves;
        assert.equal((await snapshot('orchestration.reconnect')).state, 'connected'); assert.ok(resolves > oldResolves);
        ws.send(JSON.stringify({ t: 'orchestration.reconnect', officeId: 'seed' })); await next('toast');
        configured = false;
        ws.send(JSON.stringify({ t: 'orchestration.reconnect', officeId: created })); await next('toast');
        assert.equal(app.floors().find(f => f.id === created)!.provider.snapshot().state, 'disconnected');
        configured = true;
        assert.equal((await snapshot('orchestration.reconnect')).state, 'connected');
        let release!: () => void;
        gate = new Promise<void>(resolve => { release = resolve; });
        const reading = new Promise<void>(resolve => { started = resolve; });
        ws.send(JSON.stringify({ t: 'orchestration.reconnect', officeId: created }));
        await reading;
        ws.send(JSON.stringify({ t: 'floor.go', floor: '@roof' })); await next('floor.enter');
        release(); gate = undefined; started = undefined;
        // A catalog read plus round trip allows the gated reconnect to finish before checking delivery.
        await get();
        ws.send(JSON.stringify({ t: 'chat', officeId: '@roof', text: 'barrier' })); await next('chat');
        assert.equal(messages.some(m => m.t === 'orchestration'), false);
        assert.equal(app.floors().find(f => f.id === created)!.provider.snapshot().state, 'disconnected');
      } finally { ws.terminate(); }
      assert.equal(existsSync(path.join(root, 'invoked')), false);
    } finally { app.shutdown(); }
  }
});
