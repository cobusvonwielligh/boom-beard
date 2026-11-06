// One death in ten leaves a live bomb on the tile where it happened.
//
// Owned by the player who died, so a kill it gets is credited to them - a parting shot from the
// grave. It costs them no bomb slot, because a dead player has none.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRE_TICKS, BLOCK, FUSE_TICKS, DEATH_BOMB_ONE_IN, MAX_RADIUS, START_RADIUS, PERK,
} from '../shared/constants.js';
import { createState, createPlayer, tileCentre, setTile, tileAt } from '../shared/sim/state.js';
import { tick } from '../shared/sim/round.js';
import { drop } from '../shared/sim/perks.js';

/** An open room with an iron border, so a blast only hits what a test put there. */
function room(w = 15, h = 15, seed = 7) {
  // The seed is a real parameter: `state.next` is built in createState, so a test that wants a
  // different roll sequence has to say so here rather than reassigning `s.seed` afterwards.
  const s = createState({ id: 't', name: 't', w, h, seed, density: 0, reinforced: 0, shrubs: 0 }, seed);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    setTile(s.map, x, y, (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? BLOCK.IRON : BLOCK.FLOOR);
  }
  s.map.spawns = [];
  return s;
}

function victim(s, seat, tx, ty, { radius = START_RADIUS } = {}) {
  const p = createPlayer(seat, `p${seat}`);
  p.alive = true;
  p.x = tileCentre(tx); p.y = tileCentre(ty);
  p.radius = radius;
  p.hp = 1;                             // one hit is fatal, so a death needs one blast
  s.players[seat] = p;
  return p;
}

/** Kill whoever is on (tx, ty) with fire owned by `owner`, and run the tick that resolves it. */
function killOn(s, tx, ty, owner) {
  s.fires.push({
    tx, ty, kind: 'core', rot: 0, until: s.tick + FIRE_TICKS, owner, src: s.tick * 1000 + owner,
  });
  tick(s, []);
}

/** Force the death-bomb roll: `hit` makes every roll land on 0, otherwise never. */
function forceRoll(s, hit) {
  const real = s.next;
  s.next = () => (hit ? 0 : 0.999999);
  return () => { s.next = real; };
}

const bombsAt = (s, tx, ty) => s.bombs.filter(b => b.tx === tx && b.ty === ty);

test('death bomb', async t => {
  await t.test('the chance is one in ten', () => {
    assert.equal(DEATH_BOMB_ONE_IN, 10);
  });

  await t.test('a death sometimes leaves a live bomb on the tile, and usually does not', () => {
    let withBomb = 0;
    const runs = 400;
    for (let n = 0; n < runs; n++) {
      const s = room(15, 15, n + 1);
      const p = victim(s, 0, 7, 7);
      victim(s, 1, 2, 2);                 // the killer, well clear of the blast
      killOn(s, 7, 7, 1);
      assert.equal(p.alive, false, 'the victim survived');
      if (bombsAt(s, 7, 7).length) withBomb++;
    }
    const rate = withBomb / runs;
    const want = 1 / DEATH_BOMB_ONE_IN;
    assert.ok(rate > want / 3 && rate < want * 3,
      `${withBomb} of ${runs} deaths left a bomb (${(rate * 100).toFixed(1)}%), wanted about ${(want * 100).toFixed(0)}%`);
  });

  await t.test('it belongs to the player who died and carries their radius', () => {
    const s = room();
    const p = victim(s, 0, 7, 7, { radius: 4 });
    victim(s, 1, 2, 2);
    const restore = forceRoll(s, true);
    killOn(s, 7, 7, 1);
    restore();

    const [bomb] = bombsAt(s, 7, 7);
    assert.ok(bomb, 'a forced roll left no bomb');
    assert.equal(bomb.owner, p.i, 'the death bomb does not belong to the player who died');
    assert.equal(bomb.o, p.i, 'the wire owner disagrees with the sim owner');
    assert.equal(bomb.r, 4, 'the death bomb did not carry the dead player’s radius');
    assert.equal(bomb.at, s.tick - 1 + FUSE_TICKS, 'the death bomb does not use the normal fuse');
  });

  await t.test('a kill it gets is credited to the dead player', () => {
    const s = room();
    const dead = victim(s, 0, 7, 7);
    const killer = victim(s, 1, 2, 2);
    // Standing right beside the corpse when the parting gift goes off.
    const sucker = victim(s, 2, 8, 7);

    const restore = forceRoll(s, true);
    killOn(s, 7, 7, 1);
    restore();
    assert.ok(bombsAt(s, 7, 7).length, 'no death bomb to test with');

    const kills = dead.kills;
    for (let n = 0; n < FUSE_TICKS + 5; n++) tick(s, []);
    assert.equal(sucker.alive, false, 'the death bomb never killed the player standing on it');
    assert.equal(dead.kills, kills + 1, 'the kill was not credited to the player who died');
    // The original killer keeps the one kill they earned, and does not also collect this one.
    assert.equal(killer.kills, 1, 'the death bomb’s kill went to the wrong player');
  });

  await t.test('it is never placed on a tile that already holds a bomb', () => {
    const s = room();
    victim(s, 0, 7, 7);
    victim(s, 1, 2, 2);
    s.bombs.push({
      id: 999, tx: 7, ty: 7, o: 1, owner: 1, r: 1, radius: 1,
      at: s.tick + FUSE_TICKS * 4, fuseTicks: FUSE_TICKS,
    });
    const restore = forceRoll(s, true);
    assert.doesNotThrow(() => killOn(s, 7, 7, 1));
    restore();
    assert.equal(bombsAt(s, 7, 7).length, 1, 'two bombs ended up stacked on one tile');
  });

  await t.test('it is never placed in water', () => {
    const s = room();
    victim(s, 0, 7, 7);
    victim(s, 1, 2, 2);
    s.puddles.push({ tx: 7, ty: 7, at: s.tick, until: s.tick + 500 });
    const restore = forceRoll(s, true);
    assert.doesNotThrow(() => killOn(s, 7, 7, 1));
    restore();
    assert.equal(bombsAt(s, 7, 7).length, 0, 'a fuse was lit in standing water');
  });

  /* The perk the corpse scatters and the bomb it leaves are on the same tile, and a bomb makes its
   * tile solid - the exact way a perk becomes unreachable that bombTile was fixed for. The bomb
   * goes down first and the scatter must then skip that tile. */
  await t.test('the bomb and the scattered perks never share a tile', () => {
    const s = room();
    const p = victim(s, 0, 7, 7);
    p.bombs = 6; p.radius = 4; p.speed = 2;      // plenty to scatter
    victim(s, 1, 2, 2);
    const restore = forceRoll(s, true);
    killOn(s, 7, 7, 1);
    restore();

    for (const b of s.bombs) {
      assert.ok(!s.perks.some(k => k.tx === b.tx && k.ty === b.ty),
        `a scattered perk is buried under a bomb at ${b.tx},${b.ty}`);
    }
  });

  await t.test('the roll comes from the seeded rng, not Math.random', () => {
    const shots = seed => {
      const s = room(15, 15, seed);
      const out = [];
      for (let n = 0; n < 60; n++) {
        victim(s, 0, 7, 7);
        victim(s, 1, 2, 2);
        s.fires.length = 0;
        killOn(s, 7, 7, 1);
        out.push(bombsAt(s, 7, 7).length > 0 ? 1 : 0);
        s.bombs.length = 0;
        s.perks.length = 0;
      }
      return out.join('');
    };
    assert.equal(shots(1234), shots(1234), 'the same seed produced two different sequences');
    assert.notEqual(shots(1234), shots(999), 'every seed produces the identical sequence');
  });
});
