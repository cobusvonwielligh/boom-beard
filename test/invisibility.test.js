import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CONTAGIOUS, PERK, PERK_WEIGHTS, SCORE, STATUS, STATUS_TICKS,
} from '../shared/constants.js';
import { createPlayer, createState, tileCentre } from '../shared/sim/state.js';
import { collect, drop } from '../shared/sim/perks.js';
import { CONTAGIOUS_LIST } from '../shared/sim/statuses.js';
import { MAPS } from '../shared/maps.js';
import { SHOP_ITEMS } from '../shared/shop.js';

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const art = read('public/assets/art.js');
const render = read('public/client/render.js');
const main = read('public/client/main.js');
const sfx = read('public/client/audio/sfx.js');

test('invisibility is a rare, non-purchasable perk at rum rarity', () => {
  assert.ok(Number.isInteger(PERK.INVISIBLE), 'PERK.INVISIBLE is missing');
  assert.equal(PERK_WEIGHTS[PERK.INVISIBLE], PERK_WEIGHTS[PERK.RUM]);
  assert.ok(Object.values(SHOP_ITEMS).every(item => item.perk !== PERK.INVISIBLE));
  const upgrades = main.slice(main.indexOf('const UPGRADES'), main.indexOf('const PERK_LABEL'));
  assert.doesNotMatch(upgrades, /\b18:/, 'invisibility was added as a permanent stat upgrade');
});

test('Veil and Drunk durations include their requested extensions and remain non-contagious', () => {
  assert.equal(STATUS_TICKS[STATUS.INVISIBLE], 600);
  assert.equal(STATUS_TICKS[STATUS.DRUNK], 389);
  assert.equal(STATUS_TICKS[STATUS.INVISIBLE], Math.round(480 * 1.25));
  assert.equal(STATUS_TICKS[STATUS.DRUNK], Math.round(360 * 1.08));
  assert.equal(CONTAGIOUS & STATUS.INVISIBLE, 0);
  assert.ok(!CONTAGIOUS_LIST.includes(STATUS.INVISIBLE));
});

test('collecting invisibility applies only the temporary status and normal perk score', () => {
  const state = createState(MAPS[0]);
  state.tick = 123;
  const player = createPlayer(0, 'ghost');
  player.alive = true;
  player.x = tileCentre(3);
  player.y = tileCentre(3);
  state.players[0] = player;
  drop(state, 3, 3, PERK.INVISIBLE);

  collect(state);

  assert.equal(player.status & STATUS.INVISIBLE, STATUS.INVISIBLE);
  assert.equal(player.statusUntil[STATUS.INVISIBLE], state.tick + STATUS_TICKS[STATUS.INVISIBLE]);
  assert.equal(player.score, SCORE.PERK);
  assert.equal(Object.hasOwn(player, 'invisibilityCount'), false);
});

test('invisible players remain hidden from other players but visible to themselves', () => {
  assert.match(render, /if \(\(p\.status & STATUS\.INVISIBLE\) && !isMe\) return/);
  assert.match(render, /if \(\(p\.status & STATUS\.INVISIBLE\) && p\.i !== world\.you\) continue/);
  assert.match(render, /function drawOne[\s\S]*?drawInvisibleOutline\(/);
  assert.match(render, /if \(p\.status & STATUS\.INVISIBLE\) c\.globalAlpha = 0\.22/);
  assert.match(main, /label && \(e\.i === world\.you \|\| !\(p\.status & STATUS\.INVISIBLE\)\)/);
  const outline = render.slice(
    render.indexOf('function drawInvisibleOutline'),
    render.indexOf('/* The outline with the middle cut out'),
  );
  assert.match(outline, /setLineDash\(\[3, 3\]\)/);
  assert.match(outline, /strokeStyle = '#05090f'/);
  assert.match(outline, /playerShades\(seat\)\.light/);
});

test('the invisibility pickup has matching art, a glow, a label, and its own chime', () => {
  assert.match(art, /18: \{ dark:[^}]*rim:/);
  assert.match(art, /18: c =>/);
  assert.match(art, /PERK_GLOWS = new Set\(\[16, 17, 18\]\)/);
  assert.match(main, /18: \{ text: 'INVISIBLE'/);
  assert.match(sfx, /\[PERK\.INVISIBLE\]:/);
});
