// No module may declare the same function twice in one scope.
//
// A second `function x()` in the same scope is not an error in JavaScript: the later declaration
// silently replaces the earlier one everywhere, including calls written before it. That shipped
// once - a half-health `drawSmoke(c, cx, top, seat)` replaced the blast smoke's
// `drawSmoke(ox, oy, dtMs)`, and every frame threw, freezing the HUD and the timer. A parser
// would catch it in strict-mode block scope, but not at function scope, so this test does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const roots = ['public/client', 'public/assets', 'shared', 'server'];
const files = roots.flatMap(function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []);
});

test('no function is declared twice at the same indentation in one file', () => {
  const clashes = [];
  for (const f of files) {
    const seen = new Map();
    for (const [n, line] of readFileSync(f, 'utf8').split(/\r?\n/).entries()) {
      // Indentation stands in for scope: this codebase declares one level per two spaces, and two
      // same-named functions at the same depth in one file are in the same scope in practice.
      const m = /^(\s*)(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(line);
      if (!m) continue;
      const key = `${m[1].length}:${m[2]}`;
      if (seen.has(key)) clashes.push(`${f}:${n + 1} redeclares ${m[2]} (first at line ${seen.get(key)})`);
      else seen.set(key, n + 1);
    }
  }
  assert.deepEqual(clashes, []);
});
