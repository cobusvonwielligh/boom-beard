import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const render = fs.readFileSync(path.join(ROOT, 'public/client/render.js'), 'utf8');
const art = fs.readFileSync(path.join(ROOT, 'public/assets/art.js'), 'utf8');

const constant = (source, name) => {
  const found = source.match(new RegExp(`const ${name} = ([\\d.]+);`));
  assert.ok(found, `${name} is defined`);
  return Number(found[1]);
};

test('cast object shadows are 25 percent darker and sharper', () => {
  assert.equal(constant(render, 'SHADOW_ALPHA'), 0.1375);
  assert.equal(constant(render, 'BLOCK_SHADOW_ALPHA'), 0.225);
  assert.equal(constant(render, 'BLOCK_SHADOW_WIDTH'), 1.08);
  assert.equal(constant(render, 'SHADOW_BLUR_PX'), 4.875);
});

test('solid-block bevel shading is 25 percent darker', () => {
  assert.match(art, /const dark = 'rgba\(0,0,0,0\.2\)'/);
  assert.match(art, /addColorStop\(1, 'rgba\(0,0,0,0\.375\)'\)/);
  assert.match(art, /addColorStop\(1, 'rgba\(0,0,0,0\.275\)'\)/);
});
