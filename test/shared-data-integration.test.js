import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8102;
const TOKEN = 'i'.repeat(64);
let server;

const startServer = () => new Promise((resolve, reject) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-shared-http-'));
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      REGION_ID: 'za',
      SHARED_DATA_TOKEN: TOKEN,
      DATA_DIR: dataDir,
      MIN_BOTS: '0',
      DEPLOY_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const bail = setTimeout(() => reject(new Error('shared-data server did not start')), 10_000);
  const onData = chunk => {
    if (!String(chunk).includes('listening')) return;
    clearTimeout(bail);
    server.stdout.off('data', onData);
    server.stdout.resume();
    resolve();
  };
  server.stdout.on('data', onData);
  server.once('exit', code => {
    clearTimeout(bail);
    fs.rmSync(dataDir, { recursive: true, force: true });
    reject(new Error(`shared-data server exited early (${code})`));
  });
});

async function call(op, params = {}) {
  return fetch(`http://127.0.0.1:${PORT}/internal/shared-data`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ op, ...params }),
  });
}

test('ZA shares account operations and applies each US career/shop operation once', async t => {
  await startServer();
  t.after(async () => {
    server.kill('SIGTERM');
    await once(server, 'exit');
  });

  const registered = await call('account.register', {
    name: 'shared-user',
    password: 'a sufficiently long password',
  });
  assert.equal(registered.status, 200);
  assert.equal(registered.headers.get('access-control-allow-origin'), null);
  const registration = await registered.json();
  assert.equal(registration.ok, true);
  assert.equal(typeof registration.result.token, 'string');
  assert.doesNotMatch(JSON.stringify(registration), /hash|salt|password/i);

  const verified = await call('account.verify', {
    name: 'shared-user',
    password: 'a sufficiently long password',
  });
  assert.equal((await verified.json()).result.ok, true);

  const careerOp = {
    operationId: 'us-career-1',
    regionId: 'us',
    kind: 'record',
    playerKey: 'n:shared-user',
    name: 'shared-user',
    delta: { score: 55, kills: 2, coins: 3 },
  };
  const first = await call('career.apply', careerOp);
  const replay = await call('career.apply', careerOp);
  const firstResult = (await first.json()).result;
  const replayResult = (await replay.json()).result;
  assert.equal(firstResult.snapshot.players['n:shared-user'].score, 55);
  assert.equal(replayResult.snapshot.players['n:shared-user'].score, 55);
  assert.equal(replayResult.snapshot.players['n:shared-user'].coins, 3);

  const purchase = {
    operationId: 'us-shop-1',
    regionId: 'us',
    playerKey: 'n:shared-user',
    item: 'shield',
  };
  const purchased = (await (await call('shop.buy', purchase)).json()).result;
  const purchaseReplay = (await (await call('shop.buy', purchase)).json()).result;
  assert.equal(purchased.result.ok, true);
  assert.equal(purchased.result.wallet, 1);
  assert.deepEqual(purchaseReplay.result, purchased.result);
  assert.equal(purchaseReplay.snapshot.players['n:shared-user'].pendingShop.shield, 1);
});
