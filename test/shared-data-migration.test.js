import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMigrationPayload } from '../infra/merge-region-data.js';

test('backs up both regional source files before building the import payload', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bv-migration-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const accounts = { version: 1, accounts: { alice: { salt: 's', hash: 'h' } } };
  const leaderboard = {
    version: 1,
    players: {
      'n:alice': { name: 'Alice', score: 9 },
      p_legacy: { name: 'Alice', score: 4 },
    },
  };
  const accountsText = JSON.stringify(accounts);
  const leaderboardText = JSON.stringify(leaderboard);
  await fs.writeFile(path.join(dataDir, 'accounts.json'), accountsText, { mode: 0o600 });
  await fs.writeFile(path.join(dataDir, 'leaderboard.json'), leaderboardText, { mode: 0o600 });

  const payload = await createMigrationPayload({ dataDir, now: 1234 });
  assert.equal(payload.migrationId, 'us-initial-import-v1');
  assert.deepEqual(payload.accounts, accounts.accounts);
  assert.equal(payload.players['n:alice'].score, 13);
  assert.equal(Object.hasOwn(payload.players, 'p_legacy'), false);
  assert.equal(await fs.readFile(payload.backups[0], 'utf8'), accountsText);
  assert.equal(await fs.readFile(payload.backups[1], 'utf8'), leaderboardText);
  assert.equal((await fs.stat(payload.backups[0])).mode & 0o777, 0o600);
  assert.equal((await fs.stat(payload.backups[1])).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(path.join(dataDir, 'accounts.json'), 'utf8'), accountsText);
  assert.equal(await fs.readFile(path.join(dataDir, 'leaderboard.json'), 'utf8'), leaderboardText);
});
