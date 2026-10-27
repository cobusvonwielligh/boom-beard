import { test } from 'node:test';
import assert from 'node:assert/strict';
import { squaredDistanceToLand } from '../public/client/shore-distance.js';

function referenceDistances(width, height, land) {
  const result = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let nearest = Infinity;
      for (let ly = 0; ly < height; ly++) {
        for (let lx = 0; lx < width; lx++) {
          if (!land[ly * width + lx]) continue;
          nearest = Math.min(nearest, (x - lx) ** 2 + (y - ly) ** 2);
        }
      }
      result.push(nearest);
    }
  }
  return result;
}

test('squared distance transform matches the nearest land cell exactly', () => {
  const width = 7, height = 6;
  const land = Uint8Array.from([
    0, 0, 1, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0,
    1, 0, 0, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 1, 0, 0,
    0, 0, 0, 0, 0, 0, 0,
  ]);

  assert.deepEqual(
    [...squaredDistanceToLand(width, height, land)],
    referenceDistances(width, height, land),
  );
});

test('squared distance transform returns infinity when there is no land', () => {
  assert.deepEqual(
    [...squaredDistanceToLand(3, 2, new Uint8Array(6))],
    Array(6).fill(Infinity),
  );
});
