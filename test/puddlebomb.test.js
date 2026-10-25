// A bomb can never be put down in a puddle: the water would put the fuse out. See bombable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK, IN_BOMB, DIR_R } from '../shared/constants.js';
import { createState, createPlayer, setTile, tileCentre } from '../shared/sim/state.js';
import { place } from '../shared/sim/bombs.js';

function open() {
  const st = createState({ id: 't', name: 't', w: 9, h: 9, seed: 1, density: 0, reinforced: 0, shrubs: 0 });
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    setTile(st.map, x, y, (x === 0 || y === 0 || x === 8 || y === 8) ? BLOCK.IRON : BLOCK.FLOOR);
  }
  const p = createPlayer(0, 'p');
  p.alive = true; p.bombs = 3; p.dir = DIR_R;
  p.x = tileCentre(4); p.y = tileCentre(4);
  st.players[0] = p;
  const wet = (tx, ty) => st.puddles.push({ tx, ty, at: 0, until: 9999 });
  const tap = () => { place(st, p, 0); place(st, p, IN_BOMB); };
  return { st, p, wet, tap };
}

test('a puddle in front: the bomb goes down underfoot instead', () => {
  const { st, wet, tap } = open();
  wet(5, 4);
  tap();
  assert.equal(st.bombs.length, 1);
  assert.deepEqual([st.bombs[0].tx, st.bombs[0].ty], [4, 4]);
});

test('standing in a puddle facing dry ground: the bomb goes in front', () => {
  const { st, wet, tap } = open();
  wet(4, 4);
  tap();
  assert.deepEqual([st.bombs[0].tx, st.bombs[0].ty], [5, 4]);
});

test('water in front and underfoot: no bomb at all', () => {
  const { st, wet, tap } = open();
  wet(4, 4); wet(5, 4);
  tap();
  assert.equal(st.bombs.length, 0, 'a bomb was put down in the water');
});
