import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLeaderboard } from '../server/leaderboard.js';
import { createSharedDataOutbox } from '../server/shared-data-outbox.js';
import { createSharedLeaderboard } from '../server/shared-leaderboard.js';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bv-shared-leaderboard-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('exposes the ZA career plus pending US deltas exactly once', async t => {
  const dataDir = await tempDir(t);
  const local = createLeaderboard({ dataDir });
  const outbox = createSharedDataOutbox({ dataDir });
  const global = {
    'n:alice': {
      name: 'Alice', score: 100, kills: 4, deaths: 1, coins: 10, spentCoins: 2,
      gold: 0, silver: 0, bronze: 0, pendingShop: {}, hash: 'private-hash',
    },
  };
  const client = {
    async request(op, params = {}) {
      if (op === 'career.snapshot') return { players: global };
      if (op === 'career.apply') {
        const entry = global[params.playerKey] ?? {
          name: params.name, score: 0, kills: 0, deaths: 0, coins: 0, spentCoins: 0,
          gold: 0, silver: 0, bronze: 0, pendingShop: {},
        };
        for (const [field, amount] of Object.entries(params.delta ?? {})) {
          entry[field] = (entry[field] ?? 0) + amount;
        }
        global[params.playerKey] = entry;
        return {
          operationId: params.operationId,
          result: { ok: true },
          snapshot: { players: global },
        };
      }
      throw new Error(`unexpected operation: ${op}`);
    },
  };
  const leaderboard = createSharedLeaderboard({
    localLeaderboard: local,
    client,
    outbox,
    dataDir,
    regionId: 'us',
    refreshEveryMs: 60_000,
  });
  await leaderboard.refresh();
  assert.doesNotMatch(await fs.readFile(leaderboard.cacheFile, 'utf8'), /private-hash/);
  assert.equal((await fs.stat(leaderboard.cacheFile)).mode & 0o777, 0o600);

  leaderboard.record('n:alice', { name: 'Alice', score: 5, kills: 1 });
  leaderboard.record('n:alice', { name: 'Alice', score: 0.5 });
  assert.equal(local.get('n:alice').score, 5);
  assert.equal(leaderboard.get('n:alice').score, 105);
  assert.equal(outbox.pendingCount, 1);
  await leaderboard.flush();
  assert.equal(leaderboard.get('n:alice').score, 105);
  assert.equal(outbox.pendingCount, 0);

  leaderboard.record('bot_0', { name: 'US bot', score: 7 });
  assert.equal(leaderboard.get('bot_0').score, 7);
  assert.equal(Object.hasOwn(leaderboard.sharedSnapshot().players, 'bot_0'), false);
  await leaderboard.stop();
});
