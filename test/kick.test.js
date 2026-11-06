/* Sliding into a bomb kicks it skating across the floor. Game of Bombs rules.
 *
 * The bomb is not removed and it does not stop being dangerous. It keeps its fuse, travels in
 * the direction the slide was going, and stops at the first thing it meets - a wall, the sea,
 * another bomb, standing water, or a person. Whoever it stops against can kick it straight back,
 * which is the whole point: a kicked bomb is a thrown weapon with an answer to it.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK, IN_RIGHT, IN_LEFT, IN_SLIDE, IN_BOMB, FUSE_TICKS, UNITS_PER_TILE, STAMINA_MAX,
  DIR_R, DIR_L, DIR_NONE, KICK_TILE_TICKS, MAX_BOMBS_CARRIED,
} from '../shared/constants.js';
import { createState, createPlayer, setTile, tileCentre, tileAt } from '../shared/sim/state.js';
import { placeable } from '../shared/sim/bombs.js';
import { tick } from '../shared/sim/round.js';

/** A long clear room, so a slide and a kicked bomb both have somewhere to go. */
function room(w = 25, h = 9) {
  const s = createState({ id: 't', name: 't', w, h, seed: 7, density: 0, reinforced: 0, shrubs: 0 });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    setTile(s.map, x, y, (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? BLOCK.IRON : BLOCK.FLOOR);
  }
  s.map.spawns = [];
  return s;
}

function spawn(s, seat, tx, ty) {
  const p = createPlayer(seat, `p${seat}`);
  p.alive = true;
  p.x = tileCentre(tx); p.y = tileCentre(ty);
  p.stamina = STAMINA_MAX;
  p.dir = DIR_R;
  s.players[seat] = p;
  return p;
}

/** A bomb on a tile with a full fuse. `fuse` is extended so tests outlive it by default. */
function bombAt(s, tx, ty, owner, { radius = 1, fuse = 100000 } = {}) {
  const b = {
    id: s.nextBombId++, tx, ty, o: owner, owner,
    r: radius, radius, at: s.tick + fuse, fuseTicks: fuse, streakPowered: false,
    kickDir: DIR_NONE, kickAt: 0,
  };
  s.bombs.push(b);
  return b;
}

const mask = (seat, bits) => { const m = []; m[seat] = bits; return m; };

/** Launch a slide right, then run `n` ticks of nothing. */
function kickRight(s, p, n = 60) {
  tick(s, mask(p.i, IN_RIGHT | IN_SLIDE));
  assert.ok(p.slideV > 0, 'the slide never launched');
  for (let i = 0; i < n; i++) tick(s, []);
}

test('kicking a bomb, Game of Bombs style', async t => {
  await t.test('a slide sends the bomb skating, and it stays on the board', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const b = bombAt(s, 6, 4, 1);

    tick(s, mask(p.i, IN_RIGHT | IN_SLIDE));
    for (let n = 0; n < 20; n++) tick(s, []);

    assert.ok(s.bombs.includes(b), 'the bomb left the board - it should skate, not vanish');
    assert.ok(b.tx > 6, `the bomb did not move; it is still on column ${b.tx}`);
    assert.ok(s.events.some(e => e.e === 'kick' && e.id === b.id), 'no kick event');
  });

  await t.test('it keeps its fuse and still explodes', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const b = bombAt(s, 6, 4, 1, { radius: 2, fuse: 40 });
    const id = b.id;

    kickRight(s, p, 60);
    assert.ok(s.events.some(e => e.e === 'boom' && e.id === id),
      'a kicked bomb never went off - it must keep its fuse');
  });

  await t.test('it stops against a wall', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    setTile(s.map, 12, 4, BLOCK.SOFT, 1);
    const b = bombAt(s, 6, 4, 1);

    kickRight(s, p, 120);
    assert.equal(b.tx, 11, `the bomb came to rest on column ${b.tx}, not against the wall at 12`);
    assert.equal(b.kickDir, DIR_NONE, 'the bomb is still marked as skating');
  });

  await t.test('it stops against another bomb', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const moving = bombAt(s, 6, 4, 1);
    bombAt(s, 12, 4, 1);

    kickRight(s, p, 120);
    assert.equal(moving.tx, 11, `stopped on column ${moving.tx}, not behind the bomb at 12`);
    assert.equal(s.bombs.length, 2, 'a bomb was lost in the collision');
  });

  await t.test('it stops against a person, who can kick it straight back', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const victim = spawn(s, 1, 14, 4);
    const b = bombAt(s, 6, 4, 1);

    kickRight(s, p, 120);
    assert.equal(b.tx, 13, `stopped on column ${b.tx}, not against the person on 14`);

    // And back the other way. The victim slides left, into the bomb resting beside them.
    victim.stamina = STAMINA_MAX;
    victim.slideCool = 0;
    tick(s, mask(victim.i, IN_LEFT | IN_SLIDE));
    assert.ok(victim.slideV > 0, 'the return slide never launched');
    for (let n = 0; n < 30; n++) tick(s, []);
    assert.ok(b.tx < 13, `the bomb was not kicked back; it is on column ${b.tx}`);
  });

  await t.test('it stops at the water rather than going in', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    s.puddles.push({ tx: 12, ty: 4, at: 0, until: 100000 });
    const b = bombAt(s, 6, 4, 1);

    kickRight(s, p, 120);
    assert.equal(b.tx, 11, `the bomb ended on column ${b.tx}; the water is on 12`);
  });

  await t.test('it stops at the map edge rather than leaving', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const b = bombAt(s, 6, 4, 1);
    kickRight(s, p, 300);
    assert.ok(s.bombs.includes(b), 'the bomb left the map');
    assert.equal(b.tx, s.map.w - 2, `ended on column ${b.tx}, not against the border`);
  });

  await t.test('a skating bomb is still solid to somebody walking', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const b = bombAt(s, 6, 4, 1);
    kickRight(s, p, 120);

    const walker = spawn(s, 2, b.tx - 3, 4);
    for (let n = 0; n < 60; n++) tick(s, mask(walker.i, IN_RIGHT));
    assert.ok((walker.x >> 8) < b.tx, 'walked straight through a bomb');
  });

  await t.test('the owner does not get the slot back for kicking it away', () => {
    // No bookkeeping needed any more: the bomb is still on the board, so it still counts.
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const owner = spawn(s, 1, 20, 4);
    owner.bombs = 1;
    bombAt(s, 6, 4, owner.i);

    kickRight(s, p, 60);
    assert.equal(placeable(s, owner), null, 'the kick handed the bomber a free slot');
  });

  await t.test('walking into a bomb does not kick it - only a slide does', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const b = bombAt(s, 6, 4, 1);
    for (let n = 0; n < 80; n++) tick(s, mask(p.i, IN_RIGHT));
    assert.equal(b.tx, 6, 'walking into a bomb kicked it');
    assert.equal(p.x >> 8, 5, 'the walker did not stop against the bomb');
  });

  await t.test('your own bomb is kickable too', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const b = bombAt(s, 6, 4, p.i);
    kickRight(s, p, 40);
    assert.ok(b.tx > 6, 'could not kick my own bomb');
  });

  await t.test('it travels about a tile every KICK_TILE_TICKS', () => {
    const s = room(31, 9);
    const p = spawn(s, 0, 3, 4);
    const b = bombAt(s, 6, 4, 1);

    /* Measured from the KICK, not from the launch. The slide starts three tiles short of the
     * bomb, so most of the first ten ticks are the slider getting there - counting those made it
     * look as though the bomb was travelling at a third of its actual pace. */
    tick(s, mask(p.i, IN_RIGHT | IN_SLIDE));
    let kicked = false;
    for (let n = 0; n < 40 && !kicked; n++) {
      tick(s, []);
      kicked = s.events.some(e => e.e === 'kick' && e.id === b.id);
    }
    assert.ok(kicked, 'the bomb was never kicked');

    const from = b.tx;
    const ticks = KICK_TILE_TICKS * 5;
    for (let n = 0; n < ticks; n++) tick(s, []);
    const tiles = b.tx - from;
    assert.ok(tiles >= 4 && tiles <= 6,
      `covered ${tiles} tiles in ${ticks} ticks; ${KICK_TILE_TICKS} ticks a tile means about 5`);
  });

  await t.test('a kicked bomb that is caught by fire still chains normally', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const moving = bombAt(s, 6, 4, 1);
    kickRight(s, p, 30);
    const where = moving.tx;

    // A blast reaching wherever it got to.
    const lit = bombAt(s, where + 2, 4, 1, { radius: 4, fuse: 1 });
    for (let n = 0; n < FUSE_TICKS; n++) tick(s, []);
    assert.ok(s.events.some(e => e.e === 'boom' && e.id === moving.id),
      'a skating bomb was not chained by a blast that reached it');
    assert.ok(lit);
  });
});
