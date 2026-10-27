import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playerIdKey, trustKey } from '../shared/region-keys.js';

test('ZA keeps existing identity keys', () => {
  assert.equal(playerIdKey('za'), 'bv.playerId');
  assert.equal(trustKey('za', 'CobusVW'), 'bv.trust.cobusvw');
});

test('US identity keys do not overwrite ZA credentials', () => {
  assert.equal(playerIdKey('us'), 'bv.playerId.us');
  assert.equal(trustKey('us', 'CobusVW'), 'bv.trust.us.cobusvw');
  assert.notEqual(playerIdKey('us'), playerIdKey('za'));
  assert.notEqual(trustKey('us', 'CobusVW'), trustKey('za', 'CobusVW'));
});
