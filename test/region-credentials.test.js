import { test } from 'node:test';
import assert from 'node:assert/strict';
import { legacyTrustKey, playerIdKey, readTrustToken, trustKey } from '../shared/region-keys.js';

test('ZA keeps existing identity keys', () => {
  assert.equal(playerIdKey('za'), 'bv.playerId');
  assert.equal(trustKey('za', 'CobusVW'), 'bv.trust.cobusvw');
});

test('US player identity stays regional while trusted-browser keys are shared', () => {
  assert.equal(playerIdKey('us'), 'bv.playerId.us');
  assert.equal(trustKey('us', 'CobusVW'), 'bv.trust.cobusvw');
  assert.equal(trustKey('us', 'CobusVW'), trustKey('za', 'CobusVW'));
  assert.equal(legacyTrustKey('us', 'CobusVW'), 'bv.trust.us.cobusvw');
  assert.notEqual(playerIdKey('us'), playerIdKey('za'));
});

test('reads an existing US trusted-browser token and migrates it to the shared key', () => {
  const values = new Map([['bv.trust.us.cobusvw', 'legacy-device-token']]);
  const store = {
    get: key => values.get(key) ?? null,
    set: (key, value) => values.set(key, value),
  };

  assert.equal(readTrustToken(store, 'us', 'CobusVW'), 'legacy-device-token');
  assert.equal(values.get('bv.trust.cobusvw'), 'legacy-device-token');
});
