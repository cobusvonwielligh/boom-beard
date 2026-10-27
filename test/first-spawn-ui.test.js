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
  assert.match(source, /const left = firstSpawn \? 0 : Math\.max\(0, RESPAWN_DELAY_TICKS/);
});
