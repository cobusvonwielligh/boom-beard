import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rainbowFireTones } from '../public/client/fire.js';

test('streak fire tones animate through the spectrum', () => {
  const first = rainbowFireTones(0);
  const later = rainbowFireTones(0.5);

  assert.notEqual(first.hue, later.hue);
  assert.notEqual(first.edge, later.edge);
  assert.notEqual(first.mid, first.edge);
  assert.notEqual(first.cool, first.mid);
});

test('outside-facing coastline corners use a smooth curved cut and outline', () => {
  const source = fs.readFileSync(new URL('../public/assets/art.js', import.meta.url), 'utf8');
  const carve = source.slice(
    source.indexOf('export function carveRockCorners'),
    source.indexOf('export function drawCoastFillets'),
  );

  assert.match(carve, /destination-out/, 'the exposed corner is not smoothly cut from the rock');
  assert.match(carve, /\.arc\(/, 'the cut has no curved corner');
  assert.match(carve, /COAST_RADIUS/, 'the smooth cut has no defined radius');
  assert.match(carve, /COAST_EDGE/, 'the curved cut has no matching outline');
  assert.doesNotMatch(carve, /clearRect/, 'the old blocky quarter-cell cut remains');
});

test('interior blocks have a larger smooth cut than the coast', () => {
  const source = fs.readFileSync(new URL('../public/assets/art.js', import.meta.url), 'utf8');
  const stoneRadius = Number(source.match(/export const STONE_RADIUS = (\d+);/)?.[1]);
  const coastRadius = Number(source.match(/export const COAST_RADIUS = (\d+);/)?.[1]);
  assert.ok(stoneRadius >= 10, 'interior block chamfers are still too small');
  assert.ok(stoneRadius > coastRadius, 'enlarging interior blocks must not enlarge the coast');

  const drawTile = source.slice(source.indexOf('export function drawTile'), source.indexOf('function drawTileBody'));
  assert.match(drawTile, /roundRect\(0, 0, TILE_PX, TILE_PX, STONE_RADIUS\)/,
    'interior block artwork is not clipped to the enlarged chamfer');
});
