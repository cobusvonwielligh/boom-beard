import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createSharedDataHttpHandler } from '../server/shared-data-http.js';

const TOKEN = 'a'.repeat(64);

function request({ method = 'POST', url = '/internal/shared-data', authorization, body }) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = method;
  req.url = url;
  req.headers = {
    ...(authorization ? { authorization } : {}),
    'content-type': 'application/json',
  };
  return req;
}

function response() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    end(body = '') { this.body = body; },
  };
}

test('authorizes and dispatches only allowlisted ZA operations without CORS', async () => {
  let calls = 0;
  const handler = createSharedDataHttpHandler({
    regionId: 'za',
    token: TOKEN,
    accounts: { has: name => { calls++; return name === 'Alice'; } },
    leaderboard: {},
  });
  const res = response();
  await handler(request({
    authorization: `Bearer ${TOKEN}`,
    body: { op: 'account.has', name: 'Alice' },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, result: true });
  assert.equal(calls, 1);
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
});

test('rejects wrong credentials, wrong methods, unknown operations, oversized bodies, and US hosting', async () => {
  let calls = 0;
  const args = {
    regionId: 'za',
    token: TOKEN,
    accounts: { has: () => { calls++; return true; } },
    leaderboard: {},
  };
  const handler = createSharedDataHttpHandler(args);
  const wrongSecret = response();
  await handler(request({ authorization: 'Bearer wrong', body: { op: 'account.has', name: 'a' } }),
    wrongSecret);
  assert.equal(wrongSecret.statusCode, 401);

  const wrongMethod = response();
  await handler(request({ method: 'GET', body: {} }), wrongMethod);
  assert.equal(wrongMethod.statusCode, 405);

  const unknown = response();
  await handler(request({ authorization: `Bearer ${TOKEN}`, body: { op: 'account.dump' } }),
    unknown);
  assert.equal(unknown.statusCode, 400);

  const tooLarge = response();
  await handler(request({
    authorization: `Bearer ${TOKEN}`,
    body: { op: 'account.has', name: 'a', payload: 'x'.repeat(8 * 1024 * 1024 + 1) },
  }), tooLarge);
  assert.equal(tooLarge.statusCode, 413);
  assert.equal(calls, 0);

  const us = response();
  await createSharedDataHttpHandler({ ...args, regionId: 'us' })(
    request({ authorization: 'Bearer test-secret', body: { op: 'account.has', name: 'a' } }),
    us,
  );
  assert.equal(us.statusCode, 404);
  assert.equal(calls, 0);
});

test('rejects malformed career writes before invoking the ZA store', async () => {
  let applied = 0;
  const handler = createSharedDataHttpHandler({
    regionId: 'za',
    token: TOKEN,
    accounts: {},
    leaderboard: { applySharedOperation: () => { applied++; } },
  });
  const res = response();
  await handler(request({
    authorization: `Bearer ${TOKEN}`,
    body: {
      op: 'career.apply',
      operationId: 'bad-op',
      regionId: 'us',
      kind: 'record',
      playerKey: 'bot_1',
      delta: { score: 100 },
    },
  }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(applied, 0);

  const nonFinite = response();
  await handler(request({
    authorization: `Bearer ${TOKEN}`,
    body: {
      op: 'career.apply',
      operationId: 'bad-delta',
      regionId: 'us',
      kind: 'record',
      playerKey: 'n:alice',
      delta: { score: 1e100 },
    },
  }), nonFinite);
  assert.equal(nonFinite.statusCode, 400);
  assert.equal(applied, 0);
});

test('refuses a short server-to-server secret', () => {
  assert.throws(() => createSharedDataHttpHandler({
    regionId: 'za',
    token: 'short',
    accounts: {},
    leaderboard: {},
  }), /at least 32 characters/i);
});
