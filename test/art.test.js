import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { rainbowFireTones } from '../public/client/fire.js';
import { rockCornerRadii } from '../public/client/rock-corners.js';

test('rock corners are cut only when both adjoining sides are exposed', () => {
  assert.deepEqual(rockCornerRadii(false, true, true, false, 10), [10, 0, 0, 0]);
  assert.deepEqual(rockCornerRadii(true, true, true, true, 10), [0, 0, 0, 0]);
  assert.deepEqual(rockCornerRadii(false, false, false, false, 10), [10, 10, 10, 10]);
});

test('streak fire tones animate through the spectrum', () => {
  const first = rainbowFireTones(0);
  const later = rainbowFireTones(0.5);

  assert.notEqual(first.hue, later.hue);
  assert.notEqual(first.edge, later.edge);
  assert.notEqual(first.mid, first.edge);
  assert.notEqual(first.cool, first.mid);
});

test('the speed icon uses two chevrons and a plus in HUD, shop, and pickup art', () => {
  const art = fs.readFileSync(new URL('../public/assets/art.js', import.meta.url), 'utf8');
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const readmeIcon = fs.readFileSync(new URL('../docs/readme/icons/boot.svg', import.meta.url), 'utf8');
  const collectible = art.slice(
    art.indexOf('  3: c =>', art.indexOf('export const PERK_ART')),
    art.indexOf('  // Shield:'),
  );
  const symbol = html.slice(
    html.indexOf('<symbol id="i-boot"'),
    html.indexOf('</symbol>', html.indexOf('<symbol id="i-boot"')),
  );

  assert.match(collectible, /for \(const x of \[3, 12\]\)/);
  assert.match(collectible, /moveTo\(x, 8\); c\.lineTo\(x \+ 6, 16\); c\.lineTo\(x, 24\)/);
  assert.match(collectible, /moveTo\(26, 12\); c\.lineTo\(26, 20\)/);
  assert.match(symbol, /M1 4l3 4-3 4M5 4l3 4-3 4/);
  assert.match(symbol, /M12 6v4M10 8h4/);
  assert.match(readmeIcon, /M1 4l3 4-3 4M5 4l3 4-3 4/);
  assert.match(readmeIcon, /M12 6v4M10 8h4/);
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
  assert.ok(stoneRadius >= 10, 'interior block chamfers are still too small');
  assert.ok(stoneRadius > coastRadius, 'enlarging interior blocks must not enlarge the coast');

  const drawTile = source.slice(source.indexOf('export function drawTile'), source.indexOf('function drawTileBody'));
  assert.match(drawTile, /roundRect\(0, 0, TILE_PX, TILE_PX, STONE_RADIUS\)/,
    'interior block artwork is not clipped to the enlarged chamfer');
});

test('rock tile clipping uses exposed-corner radii at the coast too', () => {
  const source = fs.readFileSync(new URL('../public/client/render.js', import.meta.url), 'utf8');
  const cornerGeometry = source.slice(
    source.indexOf('function blockCornerRadii'),
    source.indexOf('function appendBlockShape'),
  );
  const ironRock = source.slice(
    source.indexOf('const sea = seaEdges(tx, ty);'),
    source.indexOf('drawRock(cc, tx, ty, sea);'),
  );

  assert.match(ironRock, /blockCornerRadii\(/,
    'rock clipping does not distinguish exposed from shared corners');
  assert.match(ironRock, /roundRect\(0, 0, TILE_PX, TILE_PX, radii\)/,
    'the exposed-corner radii are not applied to coast-facing tiles');
  assert.doesNotMatch(ironRock, /if \(sea\) cc\.rect/,
    'coast-facing tiles still preserve sharp tile corners');
  assert.match(cornerGeometry, /\? COAST_RADIUS : ROCK_RADIUS/,
    'coast and inland corners do not keep their established radii');
});

test('projected shadows and occlusion follow trimmed block silhouettes', () => {
  const source = fs.readFileSync(new URL('../public/client/render.js', import.meta.url), 'utf8');
  const floorClip = source.slice(
    source.indexOf('function floorClipPath()'),
    source.indexOf('/** Clip the caller'),
  );
  const ao = source.slice(
    source.indexOf('function aoPass('),
    source.indexOf('/** Which sides of this tile face open water'),
  );
  const projected = source.slice(
    source.indexOf('/* Project block shadows onto the finished floor'),
    source.indexOf('// The rounded coast, after every tile'),
  );
  const art = fs.readFileSync(new URL('../public/assets/art.js', import.meta.url), 'utf8');

  assert.match(floorClip, /appendBlockShape/,
    'floor shadow masking still cuts square holes around blocks');
  assert.doesNotMatch(floorClip, /p\.rect\(tx \* TILE_PX, ty \* TILE_PX, TILE_PX, TILE_PX\)/,
    'the shadow mask still removes a full tile instead of the visible block shape');
  assert.match(projected, /appendBlockShape/,
    'projected shadows still start from a square tile silhouette');
  assert.match(projected, /clip\(floorClipPath\(\), 'evenodd'\)/,
    'projected shadows still paint over rounded block faces');
  assert.match(ao, /blockCornerRadii/,
    'ambient occlusion still treats chamfered corners as full square tiles');
    const aoReach = Number(source.match(/const AO_REACH = Math\.round\(TILE_PX \* ([\d.]+)\)/)?.[1]);
    const aoAlpha = Number(source.match(/const AO_ALPHA = ([\d.]+);/)?.[1]);
    assert.ok(aoReach <= 0.12, 'ambient occlusion bands are too wide');
    assert.ok(aoAlpha <= 0.14, 'ambient occlusion is too intense');
  assert.match(art, /function castShadow\(c, type\)[\s\S]*?type === BLOCK\.ICE[\s\S]*?c\.clip\(\)/,
    'ice shadows are not clipped to the rounded ice body');
});

test('iron rocks cast shadows in the shared sun direction', () => {
  const source = fs.readFileSync(new URL('../public/client/render.js', import.meta.url), 'utf8');
  const art = fs.readFileSync(new URL('../public/assets/art.js', import.meta.url), 'utf8');
  const shadowTypes = art.slice(
    art.indexOf('export const CASTS_SHADOW'),
    art.indexOf(']);', art.indexOf('export const CASTS_SHADOW')),
  );
  const projected = source.slice(
    source.indexOf('/* Project block shadows onto the finished floor'),
    source.indexOf('// The rounded coast, after every tile'),
  );

  assert.match(shadowTypes, /BLOCK\.IRON/,
    'fixed rock tiles do not cast a projected shadow');
  assert.match(projected, /map, sdx, sdy/,
    'projected blocks do not share the scene’s sun direction');
});

test('projected shadows from blocks and walls are 25 percent darker', () => {
  const source = fs.readFileSync(new URL('../public/client/render.js', import.meta.url), 'utf8');
  const alpha = Number(source.match(/const BLOCK_SHADOW_ALPHA = ([\d.]+);/)?.[1]);
  assert.equal(alpha, 0.225, 'block and wall shadow intensity was not increased by 25 percent');
});
