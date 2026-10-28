import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(ROOT, file), 'utf8');

test('switching to spectate reuses the active region without reopening region selection', async () => {
  const main = await read('public/client/main.js');
  const playStart = main.indexOf('async function play(');
  const playEnd = main.indexOf('/* The password box:', playStart);
  const play = main.slice(playStart, playEnd);
  const spectateStart = main.indexOf("$('spectate').onclick");
  const spectateEnd = main.indexOf("$('deadLeave').onclick", spectateStart);
  const spectate = main.slice(spectateStart, spectateEnd);

  assert.match(play, /async function play\(observe = false,\s*reuseRegion = null\)/,
    'play accepts the current region when switching modes');
  assert.match(play, /regionId = reuseRegion \?\? await regionPicker\.chooseRegion\(\)/,
    'only fresh joins need to open the region picker');
  assert.match(spectate, /const regionId = regionPicker\.selectedRegion\(\);[\s\S]*?net\.close\(\);[\s\S]*?play\(true,\s*regionId\)/,
    'the death-screen switch preserves the connected region before closing its socket');
});

test('spectators see the round countdown without a respawn shop during intermission', async () => {
  const main = await read('public/client/main.js');
  const welcomeStart = main.indexOf('onWelcome: m => {');
  const welcomeEnd = main.indexOf('onSnap: snap =>', welcomeStart);
  const welcome = main.slice(welcomeStart, welcomeEnd);
  const roundEndStart = main.indexOf('onRoundEnd: m => {');
  const roundEndEnd = main.indexOf('onShop: handleShopMessage', roundEndStart);
  const roundEnd = main.slice(roundEndStart, roundEndEnd);
  const hudStart = main.indexOf('function drawHud()');
  const hudEnd = main.indexOf('// ─── HUD ─', hudStart + 1);
  const hud = main.slice(hudStart, hudEnd);

  assert.match(welcome, /setShopVisible\(!m\.observing\);[\s\S]*?if \(!m\.observing\) requestShop\(\);/,
    'an observer joining between rounds is not shown player-only shop controls');
  assert.match(roundEnd, /setShopVisible\(!observing\);[\s\S]*?if \(!observing\) requestShop\(\);/,
    'an observer already watching does not get the shop when a round ends');
  assert.match(hud, /\$\('dead'\)\.style\.display = roundOverUntil \? 'grid' : 'none';/,
    'the scoreboard remains visible while an observer waits for the next round');
  assert.match(hud, /document\.body\.classList\.remove\('dead'\)/,
    'the observer HUD clears the previous player death styling');
});
