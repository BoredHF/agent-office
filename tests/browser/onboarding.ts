// Run after npm run build:client: node --import tsx tests/browser/onboarding.ts
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../src/server/config.js';
import { startServer } from '../../src/server/server.js';

const root = mkdtempSync(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), 'onboarding-'));
const bin = path.join(root, 'bin');
mkdirSync(bin);
for (const name of ['claude', 'gh']) writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
process.env.PATH = `${bin}:${process.env.PATH}`;
const cfg = loadConfig(['--home', path.join(root, 'home'), '--password', 'fixture-password', '--host', '127.0.0.1', '--agent', '/bin/cat']);
cfg.port = 0; cfg.city = undefined; cfg.webhook = undefined;
const app = await startServer(cfg);
let browser;
try {
  browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => { window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 500) as unknown as number; });
  const address = app.server.address();
  assert.ok(address && typeof address !== 'string');
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Come on in' }).click();
  await page.getByLabel('Your name', { exact: true }).fill('Onboarding fixture');
  await page.getByRole('button', { name: 'Enter the office' }).click();
  const elevator = page.getByRole('dialog', { name: 'Elevator', exact: true });
  await elevator.getByRole('button', { name: 'Create office', exact: true }).waitFor();
  assert.equal(app.floors().length, 0);
  // Repository setup remains optional and usable even without GitHub access.
  await elevator.getByRole('button', { name: '➕ Add a project', exact: true }).click();
  await page.getByLabel('Repository', { exact: true }).fill('example/project');
  assert.equal(await elevator.getByRole('button', { name: '🛗 Add example/project', exact: true }).isEnabled(), true);
  await page.keyboard.press('Escape');
  assert.equal(await elevator.count(), 0);
  const offices = async () => {
    await page.evaluate(() => { (document.activeElement as HTMLElement)?.blur(); document.exitPointerLock(); });
    await page.keyboard.press('Tab');
    await page.getByRole('menuitem', { name: /Offices/ }).click();
  };
  const create = async (name: string) => {
    await page.getByRole('button', { name: 'Create office', exact: true }).click();
    await page.getByLabel('Prompt', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Send ✨', exact: true }).click();
    await page.waitForFunction((name) => document.getElementById('project')?.textContent?.includes(name), name);
  };
  await offices(); await create('Alpha');
  assert.equal(app.floors().length, 1);
  const alpha = app.floors()[0];
  alpha.queue.setLimit(0); alpha.queue.add('Alpha only', 'Fixture');
  await offices(); await create('Beta');
  assert.equal(app.floors().length, 2);
  const beta = app.floors().find((f) => f.name === 'Beta')!;
  assert.notEqual(alpha.dir, beta.dir);
  assert.equal(beta.queue.state().tasks.length, 0);
  assert.equal(beta.workers.list().length, 0);
  await offices();
  await page.getByRole('dialog', { name: 'Offices', exact: true }).locator('.workflow-fields').filter({ hasText: 'Alpha' }).getByRole('button', { name: 'Switch', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('project')?.textContent?.includes('Alpha'));
  assert.equal(alpha.queue.state().tasks[0].title, 'Alpha only');
  await page.reload();
  await page.waitForFunction(() => document.getElementById('project')?.textContent?.includes('Alpha'));
  console.log('PASS: empty-home login, optional repository flow, Escape, two local offices, isolation, switch and reload');
} finally {
  await browser?.close();
  await app.shutdown();
  rmSync(root, { recursive: true, force: true });
}
