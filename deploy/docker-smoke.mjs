import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import * as pty from '@lydell/node-pty';

assert.notEqual(process.getuid(), 0, 'the application must run without root');
const base = 'http://127.0.0.1:4600';
const proofFile = join(homedir(), '.agent-office-docker-smoke.json');
const again = process.argv[2] === 'after-recreate';
const forwarded = {
  'x-forwarded-proto': 'https',
  'x-forwarded-host': 'office.test',
};
assert.equal((await fetch(base + '/api/health')).status, 200);
assert.equal((await fetch(base + '/login.html')).status, 200);
assert.equal((await fetch(base + '/api/whoami')).status, 401);

let proof;
if (again) {
  proof = JSON.parse(await readFile(proofFile, 'utf8'));
} else {
  for (const cli of ['git', 'gh', 'claude', 'codex', 'opencode']) {
    console.log(execFileSync(cli, ['--version'], { encoding: 'utf8', timeout: 30000 }).trim());
  }
  await new Promise((resolve, reject) => {
    let output = '';
    const terminal = pty.spawn('/bin/sh', ['-c', 'printf docker-pty-ok'], {
      name: 'xterm-256color', cols: 80, rows: 24, cwd: homedir(), env: process.env,
    });
    const timer = setTimeout(() => {
      terminal.kill();
      reject(new Error('PTY timed out'));
    }, 10000);
    terminal.onData((data) => { output += data; });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timer);
      try {
        assert.equal(exitCode, 0);
        assert.match(output, /docker-pty-ok/);
        resolve();
      } catch (error) { reject(error); }
    });
  });
  const response = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { ...forwarded, 'content-type': 'application/json' },
    body: JSON.stringify({ password: process.env.AGENT_OFFICE_PASSWORD }),
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /;\s*Secure/i, 'HTTPS proxy headers must produce a Secure cookie');
  proof = { cookie: cookie.split(';')[0], marker: 'docker-smoke-' + randomUUID() };
}

assert.equal((await fetch(base + '/api/whoami', {
  headers: { ...forwarded, cookie: proof.cookie },
})).status, 200, 'the session must remain valid across recreation');

const socket = new WebSocket(base.replace('http:', 'ws:') + '/ws?name=ContainerTest', {
  headers: { ...forwarded, origin: 'https://office.test', cookie: proof.cookie },
});
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket smoke test timed out')), 15000);
    const finish = (error) => {
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    socket.on('error', finish);
    socket.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.t === 'welcome') {
          if (again) {
            assert.ok(message.chat.some((line) => line.text === proof.marker),
              'chat history must survive recreation');
            finish();
          } else {
            // Echo the server-selected office (null in the lobby), just like the browser.
            socket.send(JSON.stringify({ t: 'chat', officeId: message.floor, text: proof.marker }));
          }
        }
        if (!again && message.t === 'chat' && message.text === proof.marker) finish();
      } catch (error) { finish(error); }
    });
  });
  if (!again) await writeFile(proofFile, JSON.stringify(proof), { mode: 0o600 });
} finally {
  socket.close();
}
console.log(again
  ? 'Container recreation preserved the login session, home directory and chat history.'
  : 'Non-root runtime, provider CLIs, PTY, HTTPS cookies and authenticated WebSocket passed.');
