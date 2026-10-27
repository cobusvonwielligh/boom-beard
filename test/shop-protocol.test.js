import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { attachHub } from '../server/net.js';
import { createLeaderboard } from '../server/leaderboard.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function connectedClient(port, name, observe = false) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const messages = [];
  ws.on('message', raw => messages.push(JSON.parse(raw)));
  await once(ws, 'open');
  ws.send(JSON.stringify({ t: 'hello', name, observe }));
  const welcome = await waitFor(messages, message => message.t === 'welcome');
  return { ws, messages, welcome };
}

async function waitFor(messages, predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const message = messages.find(predicate);
    if (message) return message;
    await wait(5);
  }
  throw new Error('timed out waiting for expected WebSocket message');
}

test('shop messages stay private and malformed purchases do not break the socket', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bv-shop-protocol-'));
  const leaderboard = createLeaderboard({ dataDir });
  const server = createServer();
  const hub = attachHub(server, {
    leaderboard, maxPlayers: 16, minBots: 0, countIn: 0, arriveIn: 0, lag: 0, jitter: 0,
  });
  const clients = [];

  t.after(async () => {
    for (const client of clients) client.ws.close();
    hub.shutdown();
    await new Promise(resolve => server.close(resolve));
    await leaderboard.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const a = await connectedClient(port, 'alpha');
  const b = await connectedClient(port, 'bravo');
  const watcher = await connectedClient(port, 'watcher', true);
  clients.push(a, b, watcher);

  const bShopCount = b.messages.filter(message => message.t === 'shop').length;
  const watcherShopCount = watcher.messages.filter(message => message.t === 'shop').length;
  a.ws.send(JSON.stringify({ t: 'shop' }));
  const state = await waitFor(a.messages, message => message.t === 'shop');
  assert.equal(state.ok, true);
  assert.deepEqual(state.pending, { bombs: 0, fire: 0, speed: 0, shield: 0, stim: 0 });
  await wait(50);
  assert.equal(b.messages.filter(message => message.t === 'shop').length, bShopCount);
  assert.equal(watcher.messages.filter(message => message.t === 'shop').length, watcherShopCount);

  a.ws.send(JSON.stringify({ t: 'shopbuy', item: { toString: 1 } }));
  const rejected = await waitFor(a.messages, message => message.t === 'shop' && !message.ok);
  assert.equal(rejected.wallet, 0);
  assert.equal(a.ws.readyState, WebSocket.OPEN);

  a.ws.send(JSON.stringify({ t: 'ping', c: 42 }));
  assert.equal((await waitFor(a.messages, message => message.t === 'pong' && message.c === 42)).c, 42);
  assert.equal(b.messages.filter(message => message.t === 'shop').length, bShopCount);
});

test('browser network wrapper routes private shop messages to its callback', async () => {
  const source = await readFile(path.join(ROOT, 'public/client/net.js'), 'utf8');
  assert.match(source, /onRoundTime,\s*onRejected,\s*onShop/);
  assert.match(source, /case 'shop': onShop\?\.\(m\); break;/);
});
