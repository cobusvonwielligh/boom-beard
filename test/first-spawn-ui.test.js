import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = () => readFile(path.join(ROOT, 'public/client/main.js'), 'utf8');

test('the first-spawn shop opens immediately without a death-banner wait', async () => {
  const source = await main();
  assert.match(source, /const firstSpawn = world\.me\(\)\?\.deaths === 0;/);
  assert.match(source, /const held = dead && !firstSpawn && diedAtTick >= 0/);
});

test('first spawn bypasses the death cooldown, while actual deaths keep it', async () => {
  const source = await main();
  assert.match(source, /const firstSpawn = me\.deaths === 0;/);
  assert.match(source, /const left = requested \? me\.respawnTicks\s*:\s*firstSpawn \? 0 : Math\.max\(0, RESPAWN_DELAY_TICKS/);
});

test('every accepted respawn displays its server countdown on the button', async () => {
  const source = await main();
  assert.match(source, /me\.respawnTicks !== null/);
  assert.match(source, /Math\.ceil\(me\.respawnTicks \/ \(RESPAWN_COUNTDOWN_TICKS \/ 3\)\)/);
});
