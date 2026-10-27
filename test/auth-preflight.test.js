import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccounts } from '../server/accounts.js';
import { createAuthPreflightHandler } from '../server/auth-preflight.js';

const PASSWORD = 'correct horse battery';
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bv-auth-preflight-'));

function request(body, {
  method = 'POST',
  origin = 'https://boombeard.co.za',
  host = 'boombeard.co.za',
  contentType = 'application/json',
} = {}) {
  const req = Readable.from([JSON.stringify(body)]);
  req.method = method;
  req.url = '/auth/preflight';
  req.headers = { origin, host, 'content-type': contentType };
  req.socket = { remoteAddress: '203.0.113.8' };
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

async function post(handler, body, options) {
  const res = response();
  await handler(request(body, options), res);
  return { ...res, value: res.body ? JSON.parse(res.body) : null };
}

test('preflight asks before a new account, registers once, and trusts its token', async () => {
  const accounts = createAccounts({ dataDir: dir() });
  const registrations = [];
  const handler = createAuthPreflightHandler({
    accounts,
    enabled: true,
    usingTls: true,
    geography: { recordRegistration: ip => registrations.push(ip) },
  });

  const signupPrompt = await post(handler, { name: 'new-pirate' });
  assert.equal(signupPrompt.statusCode, 200);
  assert.equal(signupPrompt.value.ok, false);
  assert.equal(signupPrompt.value.auth, 'signup');
  assert.equal(accounts.has('new-pirate'), false);

  const registered = await post(handler, { name: 'new-pirate', password: PASSWORD });
  assert.equal(registered.statusCode, 200);
  assert.equal(registered.value.ok, true);
  assert.equal(typeof registered.value.token, 'string');
  assert.equal(accounts.checkDevice('new-pirate', registered.value.token), true);
  assert.deepEqual(registrations, ['203.0.113.8']);

  const trusted = await post(handler, { name: 'new-pirate', trust: registered.value.token });
  assert.deepEqual(trusted.value, { ok: true });
});

test('preflight blocks wrong passwords and lockouts before issuing a region-ready result', async () => {
  const accounts = createAccounts({ dataDir: dir() });
  await accounts.register('existing-pirate', PASSWORD);
  const handler = createAuthPreflightHandler({
    accounts,
    enabled: true,
    usingTls: true,
  });

  const prompt = await post(handler, { name: 'existing-pirate' });
  assert.equal(prompt.value.auth, 'need');

  const wrong = await post(handler, { name: 'existing-pirate', password: 'wrong password' });
  assert.deepEqual(wrong.value, {
    ok: false,
    auth: 'bad',
    why: 'wrong password',
  });

  const correct = await post(handler, { name: 'existing-pirate', password: PASSWORD });
  assert.equal(correct.value.ok, true);
  assert.equal(typeof correct.value.token, 'string');
  assert.equal(accounts.checkDevice('existing-pirate', correct.value.token), true);

  for (let attempt = 0; attempt < 5; attempt++) {
    await accounts.verify('existing-pirate', 'wrong password');
  }
  const locked = await post(handler, { name: 'existing-pirate', password: PASSWORD });
  assert.equal(locked.value.ok, false);
  assert.equal(locked.value.auth, 'wait');
  assert.equal(locked.value.why, 'too many attempts');
  assert.ok(locked.value.waitMs > 0);
});

test('preflight enforces same-origin POST and JSON requests', async () => {
  const handler = createAuthPreflightHandler({
    accounts: createAccounts({ dataDir: dir() }),
    enabled: true,
    usingTls: true,
  });
  assert.equal((await post(handler, {}, { origin: 'https://attacker.example' })).statusCode, 403);
  assert.equal((await post(handler, {}, { method: 'GET' })).statusCode, 405);
  assert.equal((await post(handler, {}, { contentType: 'text/plain' })).statusCode, 415);
  assert.equal(await handler(request({}, { method: 'GET' }), response()), true);
});

test('disabled password auth returns success without consulting an account store', async () => {
  const handler = createAuthPreflightHandler({
    enabled: false,
    usingTls: true,
  });
  const result = await post(handler, { name: 'anyone' });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.value, { ok: true, required: false });
});
