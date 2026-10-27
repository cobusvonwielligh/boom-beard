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
  has(html, /id="topbarRight"[\s\S]*class="right"[\s\S]*id="vMap"[\s\S]*id="leave"/,
    'the map indicator sits with the leave control in the right status group');
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

test('the game toolbar drops external links and expands the board beside a narrower side panel', async () => {
  const [html, css] = await Promise.all([
    read('public/index.html'), read('public/style.css'),
  ]);
  const start = html.indexOf('<div id="topbar"');
  const end = html.indexOf('<img id="avatar"', start);
  const topbar = html.slice(start, end);

  assert.doesNotMatch(topbar, /class="iconBtn(?: bug)?"/,
    'GitHub and report-bug controls are removed from the in-game toolbar');
  assert.doesNotMatch(topbar, /href="https:\/\/github\.com/,
    'the in-game toolbar has no external GitHub links');
  const sideWidth = Number(css.match(/:root\s*{[^}]*--side:\s*(\d+)px;/s)?.[1]);
  assert.equal(sideWidth, Math.round(289 * 1.1),
    'the side panel is exactly ten percent wider than its previous 289px width');
  has(css, /canvas#game\s*{[^}]*width:\s*calc\(100vw - var\(--side\)/s,
    'the game canvas fills the width released by the side panel');
  has(css, /#leave:hover\s*{[^}]*background:\s*var\(--bad\);/s,
    'the leave control turns red on hover');
});

test('short-height controls stay on one line and share row-divider baselines', async () => {
  const [html, css] = await Promise.all([
    read('public/index.html'), read('public/style.css'),
  ]);
  const controlsStart = html.indexOf('<div class="keys">');
  const controls = html.slice(controlsStart, html.indexOf('</dl>', controlsStart));

  assert.equal([...controls.matchAll(/<dt\b/g)].length, 9,
    'each keyboard binding remains its own control row');
  assert.equal([...controls.matchAll(/<dd\b/g)].length, 9,
    'each control row has exactly one action');
  has(css, /\.keys dl\s*\{[^}]*align-items:\s*stretch;/s,
    'control cells stretch to the same grid-row height so their rules align');
  has(css, /\.keys dd\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*flex-end;/s,
    'action text stays vertically centered while its cell stretches');
  has(css, /@media \(min-width: 768px\) and \(min-height: 720px\) and \(max-height: 850px\)[\s\S]*?#menuWrap \.keys dt,\s*#menuWrap \.keys dd\s*\{[^}]*white-space:\s*nowrap;/s,
    'the compact short-height controls do not wrap key or action text');
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
  has(css, /\.pip\.heart\.half svg\s*\{[^}]*grayscale\(0\.68\)/s,
    'the half heart keeps more of its gold color');
  has(css, /\.pip\.heart\.half svg\s*\{[^}]*animation:\s*heartHurt\s+3\.6s/s,
    'the half heart shakes occasionally to show damage');
  has(css, /@keyframes heartHurt[\s\S]*translateX\(-1px\)/,
    'the hurt animation moves the heart left and right');
  has(css, /@keyframes heartHurt[\s\S]*translateX\(1px\)/,
    'the hurt animation moves the heart right');
  has(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.pip\.heart\.half svg/,
    'the periodic heart shake respects reduced-motion preferences');
  has(css, /\.pip\.heart\.empty svg\s*\{[^}]*grayscale\(1\)/s,
    'the empty heart is grayscale');
});

test('count-in numbers and clock ring have stronger drop shadows', async () => {
  const css = await read('public/style.css');

  has(css, /#countIn \.n\s*\{[^}]*drop-shadow\(0 5px 0 #000\)[^}]*drop-shadow\(0 12px 24px #000f\)/s,
    'the count-in number has stronger dark depth shadows');
  has(css, /#countIn\.hot \.n\s*\{[^}]*drop-shadow\(0 5px 0 #000\)[^}]*drop-shadow\(0 12px 24px #000f\)/s,
    'the emphasized count-in number keeps the stronger shadow');
  has(css, /#countIn \.ring\s*\{[^}]*drop-shadow\(0 4px 0 #000\)[^}]*drop-shadow\(0 12px 22px #000e\)/s,
    'the clock ring has a stronger cast shadow');
});

test('lifetime player popup is 25 percent smaller without a name hover effect on the tab board', async () => {
  const [css, main] = await Promise.all([
    read('public/style.css'), read('public/client/main.js'),
  ]);

  has(css, /#playerHover\.show\s*\{[^}]*scale\(0\.75\)/s,
    'the visible lifetime popup is scaled to 75 percent');
  has(css, /#scores \.playerHoverTarget:hover\s*\{[^}]*text-decoration-color:\s*transparent;[^}]*filter:\s*none;/s,
    'TAB scoreboard names do not gain underline or glow on mouse hover');
  has(main, /markPlayerHover\(nameCell,\s*\{ seat: p\.i \}\)/,
    'TAB scoreboard names remain eligible to open their lifetime popup');
});

test('podium round-over dialogs are wider and glow for every top-three finish', async () => {
  const [css, main] = await Promise.all([
    read('public/style.css'), read('public/client/main.js'),
  ]);
  has(css, /\.card\.round\s*\{[^}]*width:\s*min\(500px,\s*calc\(100vw - 24px\)\);/s,
    'every round-over card gets a modest width increase without overflowing mobile');
  has(main, /const podium = place >= 0 && place < 3;/,
    'only first-, second-, and third-place finishes get the podium treatment');
  has(main, /won \? 'you won the round!!' : 'round over'/,
    'the winner title has the requested emphatic punctuation');
  has(main, /deadCard\.classList\.toggle\('podium',\s*podium\)/,
    'the card exposes the podium state to its visual treatment');
  has(css, /\.card\.round\.podium\s*\{[^}]*animation:\s*podiumRgbPulse/s,
    'podium cards pulse through the RGB glow');
  has(css, /@keyframes\s+podiumRgbPulse/);
});
