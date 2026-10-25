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

test('inside-facing coastline corners use a larger smooth curved fill and outline', () => {
  const source = fs.readFileSync(new URL('../public/assets/art.js', import.meta.url), 'utf8');
  const fill = source.slice(
    source.indexOf('export function drawCoastFillets'),
    source.indexOf('/**\n * Draw something'),
  );
  const insideRadius = source.includes('export const INSIDE_COAST_RADIUS = STONE_RADIUS;')
    ? Number(source.match(/export const STONE_RADIUS = (\d+);/)?.[1])
    : 0;
  const coastRadius = Number(source.match(/export const COAST_RADIUS = (\d+);/)?.[1]);

  assert.ok(insideRadius > coastRadius, 'inside-facing corners should be more chamfered');
  assert.match(fill, /\.arc\(/, 'inside-facing rock is not filled with a smooth curve');
  assert.match(fill, /INSIDE_COAST_RADIUS/, 'inside-facing corners lack their own radius');
  assert.match(fill, /COAST_EDGE/, 'the smooth fill has no matching outline');
  assert.doesNotMatch(fill, /cornerCells|fillRect\(\(i/, 'inside-facing corners still use quarter-cell steps');
});

test('interior blocks have a larger smooth cut than the coast', () => {
  const source = fs.readFileSync(new URL('../public/assets/art.js', import.meta.url), 'utf8');
  const stoneRadius = Number(source.match(/export const STONE_RADIUS = (\d+);/)?.[1]);
  const coastRadius = Number(source.match(/export const COAST_RADIUS = (\d+);/)?.[1]);
  assert.ok(stoneRadius >= 14, 'interior block corners are too close to square at gameplay zoom');
  assert.ok(stoneRadius > coastRadius, 'enlarging interior blocks must not enlarge the coast');

  const drawTile = source.slice(source.indexOf('export function drawTile'), source.indexOf('function drawTileBody'));
  assert.match(drawTile, /roundRect\(0, 0, TILE_PX, TILE_PX, STONE_RADIUS\)/,
    'interior block artwork is not clipped to the enlarged chamfer');
});

test('all iron rock blocks use the rounded silhouette, including coast-facing blocks', () => {
  const source = fs.readFileSync(new URL('../public/client/render.js', import.meta.url), 'utf8');
  const ironRock = source.slice(
    source.indexOf('const sea = seaEdges(tx, ty);'),
    source.indexOf('cc.clip();\n            drawRock(cc, tx, ty, sea);'),
  );

  assert.match(ironRock, /roundRect\(0, 0, TILE_PX, TILE_PX, r\)/,
    'iron blocks are not smoothly clipped at all four corners');
  assert.doesNotMatch(ironRock, /if \(sea\) cc\.rect/,
    'coast-facing iron blocks still use a square clip');
});
