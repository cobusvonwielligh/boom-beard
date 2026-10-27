import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSharedAccounts, createSharedDataClient } from '../server/shared-data-client.js';

const TOKEN = 'a'.repeat(64);

test('sends authenticated HTTPS requests to the ZA IP with domain TLS verification', async () => {
  let requestOptions;
  let requestBody;
  const client = createSharedDataClient({
    host: '15.240.88.189',
    servername: 'boombeard.co.za',
    token: TOKEN,
    requestImpl: async (options, body) => {
      requestOptions = options;
      requestBody = JSON.parse(body);
      return { statusCode: 200, body: JSON.stringify({ ok: true, result: true }) };
    },
  });

  assert.equal(await client.request('account.has', { name: 'Alice' }), true);
  assert.equal(requestOptions.host, '15.240.88.189');
  assert.equal(requestOptions.servername, 'boombeard.co.za');
  assert.equal(requestOptions.rejectUnauthorized, true);
  assert.equal(requestOptions.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(requestBody, { op: 'account.has', name: 'Alice' });
});

test('rejects unauthorized, unavailable, malformed, and timeout responses explicitly', async () => {
  for (const response of [
    { statusCode: 401, body: '{"ok":false}' },
    { statusCode: 503, body: '{"ok":false}' },
    { statusCode: 200, body: '<html>not json</html>' },
    { statusCode: 200, body: '{"ok":true}' },
  ]) {
    const client = createSharedDataClient({
      host: '15.240.88.189',
      servername: 'boombeard.co.za',
      token: TOKEN,
      requestImpl: async () => response,
    });
    await assert.rejects(client.request('account.has', { name: 'Alice' }));
  }

  const timedOut = createSharedDataClient({
    host: '15.240.88.189',
    servername: 'boombeard.co.za',
    token: TOKEN,
    timeoutMs: 1,
    requestImpl: (_options, _body, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });

  test('refuses a short shared-data secret', () => {
    assert.throws(() => createSharedDataClient({
      host: '15.240.88.189',
      servername: 'boombeard.co.za',
      token: 'short',
    }), /at least 32 characters/i);
  });

  test('requires a fixed-IP target instead of a DNS-resolved origin', () => {
    assert.throws(() => createSharedDataClient({
      host: 'boombeard.co.za',
      servername: 'boombeard.co.za',
      token: TOKEN,
    }), /IP address/i);
  });
  await assert.rejects(timedOut.request('account.has', { name: 'Alice' }), /timed out/i);
});

test('shared account adapter waits for ZA and refreshes the career after successful auth', async () => {
  const calls = [];
  let refreshes = 0;
  const client = {
    async request(op, params) {
      calls.push([op, params]);
      if (op === 'account.has') return true;
      if (op === 'account.checkDevice') return true;
      if (op === 'account.lockedFor') return 0;
      if (op === 'account.register' || op === 'account.verify') {
        return { ok: true, token: 'opaque-token' };
      }
      throw new Error(`unexpected operation: ${op}`);
    },
  };
  const accounts = createSharedAccounts({
    client,
    onAuthenticated: async () => { refreshes++; },
  });

  assert.equal(await accounts.has('Alice'), true);
  assert.equal(await accounts.checkDevice('Alice', 'device-token'), true);
  assert.equal(await accounts.lockedFor('Alice'), 0);
  assert.deepEqual(await accounts.register('Alice', 'a sufficiently long password'),
    { ok: true, token: 'opaque-token' });
  assert.deepEqual(await accounts.verify('Alice', 'a sufficiently long password'),
    { ok: true, token: 'opaque-token' });
  assert.equal(refreshes, 3);
  assert.equal(calls.length, 5);
});
