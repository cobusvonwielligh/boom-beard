import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminAuth } from '../server/admin-auth.js';

const makeAuth = options => createAdminAuth({
  accounts: { checkDevice: (name, token) => name.toLowerCase() === 'cobusvw' && token === 'trusted' },
  adminName: 'cobusvw',
  password: 'configured-server-password',
  ...options,
});

test('admin access requires the configured account, trusted device, and second password without a flag', () => {
  const auth = makeAuth();
  const good = auth.login({
    name: 'CobusVW', deviceToken: 'trusted',
    password: 'configured-server-password', ip: '127.0.0.1',
  });
  assert.equal(good.ok, true);
  assert.equal(auth.check(good.token), true);

  let index = 0;
  for (const credentials of [
    { name: 'someone-else' },
    { deviceToken: 'untrusted' },
    { password: 'wrong-second-password' },
    { deviceToken: null },
  ]) {
    const result = auth.login({
      name: 'cobusvw', deviceToken: 'trusted',
      password: 'configured-server-password', ip: `invalid-${index++}`,
      ...credentials,
    });
    assert.equal(result.ok, false);
  }
});

test('admin access is disabled when its password or account store is missing', () => {
  for (const options of [{ password: '' }, { accounts: null }]) {
    const auth = makeAuth(options);
    assert.equal(auth.enabled, false);
    assert.equal(auth.login({
      name: 'cobusvw', deviceToken: 'trusted',
      password: 'anything', ip: '127.0.0.1',
    }).ok, false);
  }
});

test('admin sessions expire and can be revoked', () => {
  let now = 1000;
  const auth = makeAuth({ now: () => now, sessionTtlMs: 500 });
  const { token } = auth.login({
    name: 'cobusvw', deviceToken: 'trusted',
    password: 'configured-server-password', ip: '127.0.0.1',
  });

  assert.equal(auth.check(token), true);
  now += 500;
  assert.equal(auth.check(token), false);

  const next = auth.login({
    name: 'cobusvw', deviceToken: 'trusted',
    password: 'configured-server-password', ip: '127.0.0.1',
  });
  assert.equal(auth.logout(next.token), true);
  assert.equal(auth.check(next.token), false);
});

test('repeated bad admin passwords are rate-limited by peer address', () => {
  let now = 1000;
  const auth = makeAuth({
    now: () => now, failureLimit: 2, failureWindowMs: 1000, lockMs: 500,
  });
  const bad = {
    name: 'cobusvw', deviceToken: 'trusted',
    password: 'wrong', ip: '127.0.0.1',
  };

  assert.equal(auth.login(bad).ok, false);
  assert.equal(auth.login(bad).ok, false);
  assert.ok(auth.login({ ...bad, password: 'configured-server-password' }).retryAfterMs > 0);

  now += 500;
  assert.equal(auth.login({
    ...bad, password: 'configured-server-password',
  }).ok, true);
});
