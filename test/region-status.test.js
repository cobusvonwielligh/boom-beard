import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRegionStatusHandler } from '../server/region-status.js';

async function startHandler(handler) {
  const server = createServer((req, res) => {
    try {
      const handled = handler(req, res);
      if (!handled && !res.writableEnded) res.writeHead(404).end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
  };
}

test('region status returns only safe region-local player counts', async t => {
  const handler = createRegionStatusHandler({
    regionId: 'za',
    getStats: () => ({
      players: 9, bots: 4, maxPlayers: 16,
      names: ['private name'], score: 100, signups: 200, geography: ['ZA'],
    }),
  });
  const { server, base } = await startHandler(handler);
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const response = await fetch(`${base}/region-status`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    region: 'za', humanPlayers: 5, bots: 4, maxPlayers: 16,
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('region status allows CORS only for an exact configured region origin', async t => {
  const handler = createRegionStatusHandler({
    regionId: 'us',
    getStats: () => ({ players: 2, bots: 1, maxPlayers: 16 }),
  });
  const { server, base } = await startHandler(handler);
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const allowed = await fetch(`${base}/region-status`, {
    headers: { Origin: 'https://boombeard.co.za' },
  });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://boombeard.co.za');
  assert.equal(allowed.headers.get('vary'), 'Origin');
  assert.equal(allowed.headers.get('cache-control'), 'no-store');

  const gameOrigin = await fetch(`${base}/region-status`, {
    headers: { Origin: 'https://52.21.210.27' },
  });
  assert.equal(gameOrigin.headers.get('access-control-allow-origin'), null);

  const unlisted = await fetch(`${base}/region-status`, {
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(unlisted.headers.get('access-control-allow-origin'), null);
  assert.equal(unlisted.headers.get('vary'), 'Origin');
  assert.equal(unlisted.headers.get('cache-control'), 'no-store');
});

test('region status rejects non-GET methods without caching', async t => {
  const handler = createRegionStatusHandler({
    regionId: 'za',
    getStats: () => ({ players: 0, bots: 0, maxPlayers: 16 }),
  });
  const { server, base } = await startHandler(handler);
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const response = await fetch(`${base}/region-status`, { method: 'POST' });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'GET');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('region status does not handle other paths', () => {
  const handler = createRegionStatusHandler({
    regionId: 'za',
    getStats: () => ({ players: 0, bots: 0, maxPlayers: 16 }),
  });
  const response = { writeHead() {}, end() {} };
  assert.equal(handler({ url: '/healthz', method: 'GET', headers: {} }, response), false);
});

test('region status returns a server error for invalid player statistics', async t => {
  const handler = createRegionStatusHandler({
    regionId: 'za',
    getStats: () => ({ players: 'many', bots: 1, maxPlayers: 16 }),
  });
  const { server, base } = await startHandler(handler);
  t.after(async () => {
    server.close();
    await once(server, 'close');
  });

  const response = await fetch(`${base}/region-status`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: 'region status unavailable' });
});
