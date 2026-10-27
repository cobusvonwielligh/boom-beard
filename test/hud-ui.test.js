import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(ROOT, file), 'utf8');
const has = (source, pattern, message) => assert.ok(pattern.test(source), message);

test('top bar centers larger loadout stats and keeps only the requested status items', async () => {
  const [html, css, main] = await Promise.all([
    read('public/index.html'), read('public/style.css'), read('public/client/main.js'),
  ]);
  const clockIndex = html.indexOf('id="clock"');
  const pingIndex = html.indexOf('<span class="k">ping</span>');
  assert.ok(clockIndex >= 0 && pingIndex > clockIndex, 'clock and ping are in the top bar');
  has(html, /id="topbarMeta"[\s\S]*id="clock"/,
    'clock and ping share the left status group');
  has(html.slice(clockIndex, pingIndex), /<span class="sep"><\/span>/,
    'a vertical separator divides the clock label from ping');
  has(html, /id="topbarRight"[\s\S]*id="vMap"[\s\S]*class="right"/,
    'map and utility controls share the right status group');
  assert.doesNotMatch(html, /<span class="k">alive<\/span>|id="vOnline"/,
    'the alive stat is removed');
  assert.doesNotMatch(main, /vOnline/, 'the removed alive stat is no longer updated');
  assert.doesNotMatch(css, /#vOnline\b/, 'the removed alive stat has no reserved width');

  has(css, /#topbar\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/s,
    'the top bar reserves symmetric side columns around the centered loadout');
  has(css, /#topbarMeta\s*\{[^}]*grid-column:\s*1;/s,
    'clock and ping stay in the left column');
  has(css, /#topbarRight\s*\{[^}]*grid-column:\s*3;[^}]*justify-self:\s*end/s,
    'map and utility controls stay in the right column');
  has(css, /#gear\s*\{[^}]*gap:\s*16px;[^}]*grid-column:\s*2;[^}]*justify-self:\s*center/s,
    'the perk group has larger gaps and is centered on the top bar');
  has(css, /@media \(max-width: 990px\), \(min-width: 1081px\) and \(max-width: 1340px\)[\s\S]*?#topbar\s*\{[^}]*grid-template-rows:\s*repeat\(2,\s*1fr\)/,
    'the centered perk group moves to its own row before it can collide with status text');
  has(css, /@media \(max-width: 600px\)\s*\{[\s\S]*?#topbar\s*\{[^}]*grid-template-rows:\s*repeat\(3,\s*1fr\)/,
    'the top bar stacks cleanly on narrow screens');
  has(css, /\.pip svg\s*\{[^}]*width:\s*22px;[^}]*height:\s*22px/s,
    'power-up icons are enlarged to the shop icon size');
  has(css, /\.pip \.n\s*\{[^}]*font-size:\s*16px/s,
    'the current stat number is enlarged');
  has(css, /\.pip \.cap\s*\{[^}]*font-size:\s*13px/s,
    'the stat cap remains unchanged');
});

test('heart states are larger and become desaturated as health falls', async () => {
  const [html, css] = await Promise.all([
    read('public/index.html'), read('public/style.css'),
  ]);
  const heart = html.slice(html.indexOf('<symbol id="i-heart"'),
    html.indexOf('</symbol>', html.indexOf('<symbol id="i-heart"')));
  has(heart, /stroke="#000"/,
    'the heart outline has a thin black stroke');
  has(html, /class="pip heart full" id="pHeart"/,
    'the healthy heart starts in its full-gold state');
  has(css, /\.pip\.heart \.hL,\s*\.pip\.heart \.hR\s*\{[^}]*fill:\s*url\(#heartGold\)/s,
    'the full heart retains its gold gradient');
  has(css, /\.pip\.heart svg\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px/s,
    'the heart is enlarged');
  has(css, /\.pip\.heart \.glint\s*\{[^}]*width:\s*24px;[^}]*height:\s*24px/s,
    'the full-heart shine matches the enlarged heart');
  has(css, /\.pip\.heart\.half svg\s*\{[^}]*grayscale\(0\.88\)/s,
    'the half heart is almost grayscale');
  has(css, /\.pip\.heart\.empty svg\s*\{[^}]*grayscale\(1\)/s,
    'the empty heart is grayscale');
});
