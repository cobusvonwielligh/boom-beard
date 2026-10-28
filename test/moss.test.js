import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const render = readFileSync(new URL('../public/client/render.js', import.meta.url), 'utf8');

test('moss alpha layers are reduced by 20 percent', () => {
  assert.match(render, /const MOSS_MAX = 0\.16/);
  assert.match(render, /const MOSS_LINE_ALPHA_MAX = 0\.272/);
  assert.match(render, /const MOSS_LINE_ALPHA_SCALE = 0\.44/);
  assert.match(
    render,
    /Math\.min\(\s*MOSS_LINE_ALPHA_MAX,\s*m \* MOSS_LINE_ALPHA_SCALE \* intensity,\s*\)/,
  );
});
