import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FUSE_TICKS, UNITS_PER_TILE, playerColor } from '../shared/constants.js';
import {
  radarBombColor, radarBombFuseFraction, radarBombPulseAlpha, radarBombPulseHz,
  radarBombSizePx, selectRadarBombs,
} from '../public/client/radar.js';

const me = { rx: UNITS_PER_TILE / 2, ry: UNITS_PER_TILE / 2 };
const bomb = (id, tx, ty, at = FUSE_TICKS, fuseTicks = FUSE_TICKS, owner = 0) =>
  ({ id, tx, ty, at, fuseTicks, owner });

test('includes bombs at ten tiles and excludes bombs beyond ten tiles', () => {
  const selected = selectRadarBombs([
    bomb(1, 9, 0),
    bomb(2, 10, 0),
    bomb(3, 11, 0),
  ], me);

  assert.deepEqual(selected.map(({ bomb: b }) => b.id), [1, 2]);
  assert.equal(selected[1].distance, 10 * UNITS_PER_TILE);
});

test('uses a circular range rather than including bombs beyond ten tiles diagonally', () => {
  const selected = selectRadarBombs([
    bomb(1, 7, 7),
    bomb(2, 8, 8),
  ], me);

  assert.deepEqual(selected.map(({ bomb: b }) => b.id), [1]);
});

test('shows only the five nearest bombs', () => {
  const selected = selectRadarBombs([
    bomb(1, 4, 0), bomb(2, 0, 2), bomb(3, 1, 0),
    bomb(4, 0, 0), bomb(5, 2, 0), bomb(6, 3, 0),
  ], me);

  assert.deepEqual(selected.map(({ bomb: b }) => b.id), [4, 3, 2, 5, 6]);
  assert.equal(selected.length, 5);
});

test('pulse frequency increases as fuse ticks run down', () => {
  const slow = radarBombPulseHz(bomb(1, 1, 0, FUSE_TICKS), 0);
  const urgent = radarBombPulseHz(bomb(1, 1, 0, Math.floor(FUSE_TICKS / 2)), 0);
  const imminent = radarBombPulseHz(bomb(1, 1, 0, 0), 0);

  assert.equal(slow, 1.8);
  assert.ok(slow < urgent);
  assert.ok(urgent < imminent);
  assert.equal(imminent, 9.8);
});

test('fuse fraction supports normal, fast, and legacy bombs', () => {
  const b = bomb(1, 1, 0, 72, 72);
  assert.equal(radarBombFuseFraction(b, 0), 1);
  assert.equal(radarBombFuseFraction(b, 36), 0.5);
  assert.equal(radarBombFuseFraction(b, 72), 0);
  assert.equal(radarBombFuseFraction(b, 80), 0);
  assert.equal(radarBombFuseFraction({ at: FUSE_TICKS }, 0), 1);
});

test('marker grows smoothly from 9 to 17 pixels through the fuse', () => {
  assert.equal(radarBombSizePx(1), 9);
  assert.equal(radarBombSizePx(0), 17);
  assert.ok(radarBombSizePx(0.5) > 9 && radarBombSizePx(0.5) < 17);
});

test('marker starts in its owner color, turns red at 80 percent, then white at 90 percent', () => {
  const owner = 3;
  assert.equal(radarBombColor(1, owner), playerColor(owner));
  assert.notEqual(radarBombColor(0.6, owner), playerColor(owner));
  assert.equal(radarBombColor(0.2, owner), 'rgb(255 51 77)');
  assert.equal(radarBombColor(0.1, owner), 'rgb(255 255 255)');
  assert.equal(radarBombColor(0, owner), 'rgb(255 255 255)');
});

test('marker pulse never disappears between flashes', () => {
  const alphas = Array.from({ length: 101 }, (_, i) => radarBombPulseAlpha(i * 2 * Math.PI / 100));
  assert.ok(Math.min(...alphas) >= 0.45);
  assert.ok(Math.max(...alphas) <= 1);
});

test('a removed bomb is absent from the next frame selection', () => {
  assert.deepEqual(selectRadarBombs([bomb(1, 1, 0)], me).map(({ bomb: b }) => b.id), [1]);
  assert.deepEqual(selectRadarBombs([], me), []);
});
