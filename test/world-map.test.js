import { test } from 'node:test';
import assert from 'node:assert/strict';
import { worldMapFeatures } from '../server/world-map.js';

test('world map features expose simplified country paths keyed by ISO alpha-2', () => {
  const features = worldMapFeatures();

  assert.ok(features.length > 150);
  assert.ok(features.some(feature => feature.country === 'US'));
  assert.ok(features.some(feature => feature.country === 'ZA'));
  for (const feature of features) {
    assert.match(feature.country, /^[A-Z]{2}$/);
    assert.match(feature.path, /^M[-\d.]+,[-\d.]+/);
  }
});
