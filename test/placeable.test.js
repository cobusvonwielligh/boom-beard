// placeable() is the one answer to "would this press put a bomb down", and place() must agree
// with it in every case - the client's instant "place" click is driven by it. The click once had
// its own copy of the rules and played for bombs that were never placed. See placeable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK, IN_BOMB, DIR_R, STATUS } from '../shared/constants.js';
import { createState, createPlayer, setTile, tileCentre } from '../shared/sim/state.js';
import { place, placeable } from '../shared/sim/bombs.js';

function open(tweak = () => {}) {
  const st = createState({ id: 't', name: 't', w: 9, h: 9, seed: 1, density: 0, reinforced: 0, shrubs: 0 });
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    setTile(st.map, x, y, (x === 0 || y === 0 || x === 8 || y === 8) ? BLOCK.IRON : BLOCK.FLOOR);
  }
  const p = createPlayer(0, 'p');
  p.alive = true; p.bombs = 1; p.dir = DIR_R;
  p.x = tileCentre(4); p.y = tileCentre(4);
  st.players[0] = p;
  tweak(st, p);
  return { st, p };
}

const cases = {
  'free to place': () => {},
  'dead': (st, p) => { p.alive = false; },
  'pacifist': (st, p) => { p.status |= STATUS.PACIFISM; p.statusUntil[STATUS.PACIFISM] = 999; },
  'dazed': (st, p) => { p.status |= STATUS.CONFUSED; p.statusUntil[STATUS.CONFUSED] = 999; },
  'mid-slide': (st, p) => { p.slideV = 40; },
  'out of bombs': (st, p) => { st.bombs.push({ id: 9, tx: 2, ty: 2, owner: 0, o: 0, radius: 1, r: 1, at: 99 }); },
  'in water both ways': (st) => { st.puddles.push({ tx: 4, ty: 4, until: 999 }, { tx: 5, ty: 4, until: 999 }); },
};

for (const [name, tweak] of Object.entries(cases)) {
  test(`place() and placeable() agree: ${name}`, () => {
    const { st, p } = open(tweak);
    const said = placeable(st, p);
    const before = st.bombs.length;
    place(st, p, 0); place(st, p, IN_BOMB);
    const placed = st.bombs.length > before ? st.bombs.at(-1) : null;
    assert.equal(!!placed, !!said, `placeable said ${said ? 'yes' : 'no'}, place ${placed ? 'placed' : 'did not'}`);
    if (placed) assert.deepEqual([placed.tx, placed.ty], [said.tx, said.ty], 'they chose different tiles');
  });
}
