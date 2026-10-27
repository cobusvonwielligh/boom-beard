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

test('world map outlines omit lines that cross the antimeridian', () => {
  for (const feature of worldMapFeatures()) {
    assert.match(feature.outlinePath, /^M[-\d.]+,[-\d.]+/);

    let previous;
    for (const match of feature.outlinePath.matchAll(/([ML])(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)) {
      const point = [Number(match[2]), Number(match[3])];
      if (match[1] === 'M') {
        previous = point;
        continue;
      }

      assert.ok(Math.abs(point[0] - previous[0]) < 500,
        `${feature.country} outline crosses the map: ${previous} to ${point}`);
      previous = point;
    }
  }
});
