import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSharedDataOutbox } from '../server/shared-data-outbox.js';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bv-shared-outbox-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const operation = {
  operationId: 'us-op-1',
  regionId: 'us',
  kind: 'record',
  playerKey: 'n:alice',
  delta: { score: 5, kills: 1 },
};

test('persists queued career changes with restrictive permissions and replays once', async t => {
  const dir = await tempDir(t);
  const outbox = createSharedDataOutbox({ dataDir: dir });
  outbox.enqueue(operation);
  outbox.enqueue(operation);
  assert.equal(outbox.pendingCount, 1);

  const file = path.join(dir, 'shared-outbox.json');
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const replayed = [];
  await outbox.flush(async value => {
    replayed.push(value.operationId);
    return { operationId: value.operationId };
  });
  assert.deepEqual(replayed, ['us-op-1']);
  assert.equal(outbox.pendingCount, 0);

  const reopened = createSharedDataOutbox({ dataDir: dir });
  assert.equal(reopened.pendingCount, 0);
});

test('keeps unacknowledged writes after a failed send and process restart', async t => {
  const dir = await tempDir(t);
  const outbox = createSharedDataOutbox({ dataDir: dir });
  outbox.enqueue(operation);
  await assert.rejects(outbox.flush(async () => { throw new Error('ZA unavailable'); }), /ZA unavailable/);

  const reopened = createSharedDataOutbox({ dataDir: dir });
  assert.equal(reopened.pendingCount, 1);
  assert.deepEqual(reopened.pending()[0], operation);
});
