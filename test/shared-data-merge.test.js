import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SHOP_ITEMS } from '../shared/shop.js';
import { mergeAccountRecords, mergeCareerRecords } from '../server/shared-data-merge.js';

test('merges duplicate account credentials and trusted devices without losing metadata', () => {
  const merged = mergeAccountRecords({
    cobusvw: {
      name: 'CobusVW',
      salt: '1'.repeat(32),
      hash: 'a'.repeat(128),
      kdf: { N: 32768, r: 8, p: 1, len: 64 },
      devices: [{ h: 'a'.repeat(64), at: 1, seen: 3, exp: 30 }],
      created: 1,
      lastSeen: 3,
      signupCountExcluded: true,
    },
  }, {
    cobusvw: {
      name: 'cobusvw',
      salt: '2'.repeat(32),
      hash: 'b'.repeat(128),
      kdf: { N: 16384, r: 8, p: 1, len: 64 },
      devices: [{ h: 'b'.repeat(64), at: 2, seen: 8, exp: 40 }],
      created: 2,
      lastSeen: 8,
    },
    ghost: { name: 'ghost', devices: [], created: null, lastSeen: null },
    noseen: {
      name: 'noseen', salt: '3'.repeat(32), hash: 'c'.repeat(128),
      kdf: {}, lastSeen: null,
    },
    badkdf: {
      name: 'badkdf', salt: '4'.repeat(32), hash: 'd'.repeat(128),
      kdf: { N: 1 << 30, r: 8, p: 1, len: 64 },
    },
  });

  const record = merged.cobusvw;
  assert.deepEqual(record.credentials.map(credential => credential.salt).sort(),
    ['1'.repeat(32), '2'.repeat(32)]);
  assert.deepEqual(record.devices.map(device => device.h).sort(),
    ['a'.repeat(64), 'b'.repeat(64)]);
  assert.equal(record.created, 1);
  assert.equal(record.lastSeen, 8);
  assert.equal(record.signupCountExcluded, true);
  assert.doesNotMatch(JSON.stringify(merged), /password/i);
  assert.equal(Object.hasOwn(merged, 'ghost'), false);
  assert.equal(merged.noseen.lastSeen, null);
  assert.equal(Object.hasOwn(merged, 'badkdf'), false);
});

test('adds regional human careers and caps shop queues while isolating bot careers', () => {
  const merged = mergeCareerRecords({
    'n:alice': {
      name: 'Alice', score: 100, kills: 3, deaths: 1, gold: 1,
      coins: 20, spentCoins: 4, pendingShop: { bombs: SHOP_ITEMS.bombs.cap - 2 },
    },
    bot_1: { name: 'ZA bot', score: 10, kills: 1 },
  }, {
    'n:alice': {
      name: 'alice', score: 40, kills: 2, deaths: 2, gold: 1,
      coins: 7, spentCoins: 1, pendingShop: { bombs: 4 },
    },
    bot_1: { name: 'US bot', score: 15, kills: 2 },
  });

  assert.equal(merged['n:alice'].score, 140);
  assert.equal(merged['n:alice'].kills, 5);
  assert.equal(merged['n:alice'].deaths, 3);
  assert.equal(merged['n:alice'].gold, 2);
  assert.equal(merged['n:alice'].coins, 27);
  assert.equal(merged['n:alice'].spentCoins, 5);
  assert.equal(merged['n:alice'].pendingShop.bombs, SHOP_ITEMS.bombs.cap);
  assert.equal(merged['bot_1'].name, 'ZA bot');
  assert.equal(merged['us:bot_1'].name, 'US bot');
});
