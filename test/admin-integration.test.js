import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createAccounts } from '../server/accounts.js';
import { createGeography } from '../server/geography.js';
import { createLeaderboard } from '../server/leaderboard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD_PASSWORD = 'admin-integration-test-password';

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  server.close();
  await once(server, 'close');
  return port;
}

async function startServer(port, dataDir) {
  const child = spawn(globalThis.process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...globalThis.process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      ADMIN_DASHBOARD_PASSWORD: DASHBOARD_PASSWORD,
      REQUIRE_PASSWORD: '1',
      MIN_BOTS: '0',
      LAG: '0',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`server startup timed out: ${output}`)), 10_000);
      const onData = chunk => {
        output += String(chunk);
        if (!output.includes('listening')) return;
        clearTimeout(timeout);
        child.stdout.off('data', onData);
        child.stdout.resume();
        resolve();
      };
      child.stdout.on('data', onData);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => {
        clearTimeout(timeout);
        reject(new Error(`server exited during startup (${code}): ${output}`));
      });
    });
  } catch (error) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
    throw error;
  }
  return child;
}

test('configured admin dashboard authenticates and returns only safe player data', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-admin-integration-'));
  const accounts = createAccounts({ dataDir });
  const registered = await accounts.register('cobusvw', 'integration-primary-password');
  assert.equal(registered.ok, true);
  accounts.flushSync();

  const leaderboard = createLeaderboard({ dataDir });
  leaderboard.record('career-cobusvw', {
    name: 'cobusvw', score: 1234, kills: 12, deaths: 4, coins: 7,
  });
  await leaderboard.stop();
  const geography = createGeography({
    dataDir,
    lookupCountry: ip => ip === '198.51.100.10' ? 'US' : 'ZA',
  });
  geography.recordHit('198.51.100.10');
  geography.recordRegistration('203.0.113.5');
  geography.flushSync();
  geography.stop();

  const port = await unusedPort();
  let server;
  try {
    server = await startServer(port, dataDir);
  } catch (error) {
    fs.rmSync(dataDir, { recursive: true, force: true });
    throw error;
  }
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    server.kill('SIGTERM');
    await once(server, 'exit');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const page = await fetch(`${base}/admin`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /COMMAND/);

  const denied = await fetch(`${base}/admin/api/players`);
  assert.equal(denied.status, 401);

  const login = await fetch(`${base}/admin/api/login`, {
    method: 'POST',
    headers: {
      Origin: base,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: 'cobusvw',
      deviceToken: registered.token,
      password: DASHBOARD_PASSWORD,
    }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const players = await fetch(`${base}/admin/api/players`, { headers: { Cookie: cookie } });
  assert.equal(players.status, 200);
  const report = await players.json();
  assert.equal(report.total, 1);
  assert.equal(report.items[0].name, 'cobusvw');
  assert.equal(report.items[0].score, 1234);
  assert.equal(report.items[0].xp, 1234);
  assert.equal(report.items[0].kills, 12);
  assert.equal(report.items[0].deaths, 4);
  assert.equal(report.items[0].coins, 7);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /integration-primary-password|admin-integration-test|salt|hash/i);

  const metrics = await fetch(`${base}/admin/api/metrics`, { headers: { Cookie: cookie } });
  assert.equal(metrics.status, 200);
  assert.ok((await metrics.json()).length >= 1);

  const locations = await fetch(`${base}/admin/api/geography?period=30`, {
    headers: { Cookie: cookie },
  });
  assert.equal(locations.status, 200);
  const locationReport = await locations.json();
  assert.equal(locationReport.totalHits, 1);
  assert.equal(locationReport.totalRegistrations, 1);
  assert.deepEqual(locationReport.countries.map(country => country.country).sort(), ['US', 'ZA']);

  const map = await fetch(`${base}/admin/api/worldmap`, { headers: { Cookie: cookie } });
  assert.equal(map.status, 200);
  assert.ok((await map.json()).some(country => country.country === 'US'));
});
