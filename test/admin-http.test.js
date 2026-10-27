import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createAdminHttpHandler } from '../server/admin-http.js';

async function startHandler(handler) {
  const server = createServer((req, res) => {
    void handler(req, res).then(handled => {
      if (!handled && !res.writableEnded) res.writeHead(404).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  return {
    server,
    base: `http://127.0.0.1:${address.port}`,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

test('admin HTTP routes require same-origin login and an HttpOnly session cookie', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-admin-http-'));
  const pageFile = path.join(dir, 'admin.html');
  fs.writeFileSync(pageFile, '<main>private dashboard shell</main>');
  let sessionActive = false;
  const auth = {
    enabled: true,
    login: data => {
      if (data.password !== 'second-factor') return { ok: false };
      sessionActive = true;
      return { ok: true, token: 'a'.repeat(43) };
    },
    check: token => sessionActive && token === 'a'.repeat(43),
    logout: token => {
      if (!sessionActive || token !== 'a'.repeat(43)) return false;
      sessionActive = false;
      return true;
    },
  };
  let remoteMetricsAvailable = true;
  const data = {
    metrics: () => [{ at: 1, cpuPct: 10, memoryPct: 2, diskPct: 40 }],
    instanceMetrics: region => {
      if (region === 'us' && !remoteMetricsAvailable) throw new Error('upstream offline');
      return region === 'us'
        ? [{ at: 2, cpuPct: 82, memoryPct: 61, diskPct: 14 }]
        : [{ at: 1, cpuPct: 10, memoryPct: 2, diskPct: 40 }];
    },
    registrations: () => ({ days: [], currentTotal: 0 }),
    geography: options => ({ period: options.period, countries: [{ country: 'US', hits: 3, registrations: 1 }] }),
    worldMap: () => [{ country: 'US', name: 'United States', path: 'M0,0L1,1Z' }],
    players: options => {
      if (options.from === 'not-a-date') throw new RangeError('invalid date');
      return { items: [], total: 0, page: 1, pageSize: 25, pages: 0 };
    },
  };
  const handler = createAdminHttpHandler({ auth, data, pageFile, usingTls: false });
  const { server, base, origin } = await startHandler(handler);
  t.after(async () => {
    server.close();
    await once(server, 'close');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const page = await fetch(`${base}/admin`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /private dashboard shell/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('x-robots-tag'), 'noindex, nofollow');

  const denied = await fetch(`${base}/admin/api/metrics`);
  assert.equal(denied.status, 401);
  assert.equal((await fetch(`${base}/admin/api/geography`)).status, 401);
  const sessionState = await fetch(`${base}/admin/api/session`);
  assert.equal(sessionState.status, 200);
  assert.deepEqual(await sessionState.json(), { ok: false });

  const crossOrigin = await fetch(`${base}/admin/api/login`, {
    method: 'POST',
    headers: { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'second-factor' }),
  });
  assert.equal(crossOrigin.status, 403);

  const login = await fetch(`${base}/admin/api/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'cobusvw',
      deviceToken: 'trusted-device',
      adminKey: 'server-flag',
      password: 'second-factor',
    }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.match(cookie, /Path=\/admin/i);

  const metrics = await fetch(`${base}/admin/api/metrics`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(metrics.status, 200);
  assert.deepEqual(await metrics.json(), [{ at: 1, cpuPct: 10, memoryPct: 2, diskPct: 40 }]);

  const usMetrics = await fetch(`${base}/admin/api/metrics?region=us`, {
    headers: { Cookie: cookie.split(';')[0] },
  });
  assert.equal(usMetrics.status, 200);
  assert.deepEqual(await usMetrics.json(), [
    { at: 2, cpuPct: 82, memoryPct: 61, diskPct: 14 },
  ]);
  const invalidRegion = await fetch(`${base}/admin/api/metrics?region=ca`, {
    headers: { Cookie: cookie.split(';')[0] },
  });
  assert.equal(invalidRegion.status, 400);
  remoteMetricsAvailable = false;
  const unavailable = await fetch(`${base}/admin/api/metrics?region=us`, {
    headers: { Cookie: cookie.split(';')[0] },
  });
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'US instance metrics unavailable' });

  const map = await fetch(`${base}/admin/api/worldmap`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(map.status, 200);
  assert.deepEqual(await map.json(), [{ country: 'US', name: 'United States', path: 'M0,0L1,1Z' }]);

  const geography = await fetch(`${base}/admin/api/geography?period=7`, {
    headers: { Cookie: cookie.split(';')[0] },
  });
  assert.equal(geography.status, 200);
  assert.deepEqual(await geography.json(), {
    period: '7', countries: [{ country: 'US', hits: 3, registrations: 1 }],
  });

  const invalidFilter = await fetch(`${base}/admin/api/players?from=not-a-date`, {
    headers: { Cookie: cookie.split(';')[0] },
  });
  assert.equal(invalidFilter.status, 400);

  const logout = await fetch(`${base}/admin/api/logout`, {
    method: 'POST',
    headers: { Origin: origin, Cookie: cookie.split(';')[0] },
  });
  assert.equal(logout.status, 204);
  assert.equal((await fetch(`${base}/admin/api/metrics`, {
    headers: { Cookie: cookie.split(';')[0] },
  })).status, 401);
});

test('admin routes are not served when server configuration disables access', async t => {
  const handler = createAdminHttpHandler({
    auth: { enabled: false },
    data: {},
    pageFile: '/missing/admin.html',
    usingTls: false,
  });
  const { server, base } = await startHandler(handler);
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  assert.equal((await fetch(`${base}/admin`)).status, 404);
  assert.equal((await fetch(`${base}/admin/api/metrics`)).status, 404);
});

test('admin access is not exposed over plain HTTP to remote clients', async () => {
  const handler = createAdminHttpHandler({
    auth: { enabled: true },
    data: {},
    pageFile: '/missing/admin.html',
    usingTls: false,
  });
  let status = 0;
  const response = {
    writeHead(code) { status = code; },
    end() {},
  };
  const handled = await handler({
    url: '/admin',
    method: 'GET',
    headers: { host: 'boombeard.co.za' },
    socket: { remoteAddress: '203.0.113.10' },
  }, response);

  assert.equal(handled, true);
  assert.equal(status, 404);
});
