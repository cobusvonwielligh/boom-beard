import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closestReachable, selectedRegionId } from '../shared/region-selection.js';
import { regionIdForOrigin } from '../shared/regions.js';

test('chooses the reachable region with the lowest measured RTT', () => {
  assert.equal(closestReachable([
    { id: 'za', online: true, rttMs: 182 },
    { id: 'us', online: true, rttMs: 41 },
  ]), 'us');
});

test('ignores offline and invalid RTT samples', () => {
  assert.equal(closestReachable([
    { id: 'za', online: false, rttMs: 2 },
    { id: 'us', online: true, rttMs: Number.NaN },
  ]), null);
});

test('breaks equal RTT ties by stable region id', () => {
  assert.equal(closestReachable([
    { id: 'us', online: true, rttMs: 50 },
    { id: 'za', online: true, rttMs: 50 },
  ]), 'us');
});

test('keeps a manual choice and refuses an offline manual region', () => {
  const results = [
    { id: 'za', online: true, rttMs: 182 },
    { id: 'us', online: false, rttMs: null },
  ];
  assert.equal(selectedRegionId(results, 'za'), 'za');
  assert.equal(selectedRegionId(results, 'us'), null);
});

test('identifies the regional host and defaults local origins to ZA', () => {
  assert.equal(regionIdForOrigin('https://boombeard.co.za'), 'za');
  assert.equal(regionIdForOrigin('https://us.boombeard.co.za'), 'us');
  assert.equal(regionIdForOrigin('http://localhost:8080'), 'za');
});
