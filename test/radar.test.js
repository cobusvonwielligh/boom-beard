import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FUSE_TICKS, UNITS_PER_TILE } from '../shared/constants.js';
import { radarBombPulseHz, selectRadarBombs } from '../public/client/radar.js';

const me = { rx: UNITS_PER_TILE / 2, ry: UNITS_PER_TILE / 2 };
const bomb = (id, tx, ty, at = FUSE_TICKS) => ({ id, tx, ty, at });

test('includes bombs at six tiles and excludes bombs beyond six tiles', () => {
  const selected = selectRadarBombs([
    bomb(1, 5, 0),
    bomb(2, 6, 0),
    bomb(3, 7, 0),
  ], me);

  assert.deepEqual(selected.map(({ bomb: b }) => b.id), [1, 2]);
  assert.equal(selected[1].distance, 6 * UNITS_PER_TILE);
});

test('shows no more than the three nearest bombs', () => {
  const selected = selectRadarBombs([
    bomb(1, 4, 0),
    bomb(2, 0, 2),
    bomb(3, 1, 0),
    bomb(4, 0, 0),
  ], me);

  assert.deepEqual(selected.map(({ bomb: b }) => b.id), [4, 3, 2]);
  assert.equal(selected.length, 3);
});

test('pulse frequency increases as fuse ticks run down', () => {
  const slow = radarBombPulseHz(bomb(1, 1, 0, FUSE_TICKS), 0);
  const urgent = radarBombPulseHz(bomb(1, 1, 0, Math.floor(FUSE_TICKS / 2)), 0);
  const imminent = radarBombPulseHz(bomb(1, 1, 0, 1), 0);

  assert.ok(slow < urgent);
  assert.ok(urgent < imminent);
});

test('a removed bomb is absent from the next frame selection', () => {
  assert.deepEqual(selectRadarBombs([bomb(1, 1, 0)], me).map(({ bomb: b }) => b.id), [1]);
  assert.deepEqual(selectRadarBombs([], me), []);
});
