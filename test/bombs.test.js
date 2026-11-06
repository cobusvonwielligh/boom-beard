// Blast shape, chains, destruction and death. `spread` is pure, which is what lets the client
// draw the identical explosion on the identical tick - docs/NETCODE.md §1a.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, createPlayer, setTile, tileAt, hpAt, tileCentre, hashState } from '../shared/sim/state.js';
import { spread } from '../shared/sim/fire.js';
import { place, detonate, bombTile } from '../shared/sim/bombs.js';
import { tick } from '../shared/sim/round.js';
import { drop, maybeDrop } from '../shared/sim/perks.js';
import {
  BLOCK, BLOCK_HP, IN_BOMB, IN_RIGHT, FUSE_TICKS, FUSE_TICKS_FAST, STATUS, PERK, MAX_RADIUS, SCORE,
  PERK_WEIGHTS, NON_GOLD_DROP_KEEP_CHANCE, FIRE_LETHAL_TICKS, FIRE_TICKS, DIR_R, DIR_U, DIR_L, DIR_D,
  MAX_BOMBS_CARRIED, POWDER_RADIUS,
} from '../shared/constants.js';

function room(w = 15, h = 15) {
  const st = createState({ id: 't', name: 't', w, h, seed: 7, density: 0, reinforced: 0, shrubs: 0 });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    setTile(st.map, x, y, (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? BLOCK.IRON : BLOCK.FLOOR);
  }
  return st;
}

function spawn(st, seat, tx, ty) {
  const p = createPlayer(seat, `p${seat}`);
  p.alive = true;
  p.x = tileCentre(tx); p.y = tileCentre(ty);
  st.players[seat] = p;
  return p;
}

const run = (st, n, inputs = []) => { for (let i = 0; i < n; i++) tick(st, inputs); };

/** One tap of the bomb key: placement is edge-triggered, so a press has to be released. */
const tap = (st, p) => { place(st, p, IN_BOMB); place(st, p, 0); };

/** The same through the round loop, for tests that drive it with input masks. */
const tapTick = (st, seat = 0) => {
  const held = []; held[seat] = IN_BOMB;
  tick(st, held);
  tick(st, []);
};

/** Tests about blocks and drops should not also be tests about blowing yourself up. */
function immortal(p) { p.status = STATUS.INVULN; p.statusUntil[STATUS.INVULN] = 1e9; return p; }
const at = (cells, tx, ty) => cells.some(c => c.tx === tx && c.ty === ty);

test('fire spread', async t => {
  await t.test('reaches exactly radius tiles in four directions', () => {
    const st = room();
    const { cells } = spread(st.map, { tx: 7, ty: 7, radius: 3 });
    assert.equal(cells.length, 1 + 4 * 3);
    assert.ok(at(cells, 10, 7) && at(cells, 4, 7) && at(cells, 7, 10) && at(cells, 7, 4));
    assert.ok(!at(cells, 11, 7), 'does not overreach');
  });

  await t.test('stops before iron, without burning it', () => {
    const st = room();
    setTile(st.map, 9, 7, BLOCK.IRON);
    const { cells, hits } = spread(st.map, { tx: 7, ty: 7, radius: 4 });
    assert.ok(at(cells, 8, 7));
    assert.ok(!at(cells, 9, 7), 'iron is not set on fire');
    assert.ok(!at(cells, 10, 7), 'and nothing past it');
    assert.equal(hits.length, 0);
  });

  await t.test('burns a soft wall and stops there', () => {
    const st = room();
    setTile(st.map, 9, 7, BLOCK.SOFT, 1);
    const { cells, hits } = spread(st.map, { tx: 7, ty: 7, radius: 4 });
    assert.ok(at(cells, 9, 7), 'the wall tile itself burns');
    assert.ok(!at(cells, 10, 7), 'the arm stops');
    assert.deepEqual(hits, [{ tx: 9, ty: 7 }]);
  });

  await t.test('passes through a column without losing reach', () => {
    const st = room();
    setTile(st.map, 8, 7, BLOCK.COLUMN);
    const { cells } = spread(st.map, { tx: 7, ty: 7, radius: 3 });
    assert.ok(at(cells, 8, 7) && at(cells, 10, 7), 'fire ignores columns');
  });

  await t.test('shrubs let fire through but weaken it', () => {
    const st = room();
    setTile(st.map, 8, 7, BLOCK.SHRUB_WALK);
    const { cells } = spread(st.map, { tx: 7, ty: 7, radius: 3 });
    assert.ok(at(cells, 9, 7), 'got past the shrub');
    assert.ok(!at(cells, 10, 7), 'but one tile short of full reach');
  });

  await t.test('is pure - same inputs, same answer', () => {
    const st = room();
    setTile(st.map, 9, 7, BLOCK.SOFT, 1);
    const a = JSON.stringify(spread(st.map, { tx: 7, ty: 7, radius: 4 }));
    const b = JSON.stringify(spread(st.map, { tx: 7, ty: 7, radius: 4 }));
    assert.equal(a, b);
  });

  await t.test('fire spread is 15% faster after the interval tuning', () => {
    const st = room(25, 15);
    const { cells } = spread(st.map, { tx: 10, ty: 7, radius: 10 });
    const delayAt = x => cells.find(c => c.tx === x && c.ty === 7)?.delayTicks;

    const arrivals = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20].map(delayAt);
    assert.deepEqual(arrivals, [2, 5, 8, 13, 19, 24, 30, 38, 52, 70]);
    assert.deepEqual(arrivals.slice(1).map((tick, i) => tick - arrivals[i]),
      [3, 3, 5, 6, 5, 6, 8, 14, 18]);
  });
});

test('bombs in the round loop', async t => {
  await t.test('placing respects the bomb cap and one-per-tile', () => {
    const st = room();
    const p = spawn(st, 0, 3, 3);
    // Pinned to ONE here rather than to START_BOMBS: this is a test about the cap being obeyed
    // and a tile taking one bomb, so it sets the cap it wants instead of inheriting the loadout.
    p.bombs = 1;
    tap(st, p);
    tap(st, p);
    assert.equal(st.bombs.length, 1, 'cap of one, and only one per tile');
    p.bombs = 2;
    p.x = tileCentre(5);
    tap(st, p);
    assert.equal(st.bombs.length, 2);
  });

  await t.test('pacifism stops you bombing', () => {
    const st = room();
    const p = spawn(st, 0, 3, 3);
    p.status = STATUS.PACIFISM;
    p.statusUntil[STATUS.PACIFISM] = 999;
    tap(st, p);
    assert.equal(st.bombs.length, 0);
  });

  await t.test('streak power and the selected fuse are captured when a bomb is placed', () => {
    const st = room();
    const p = spawn(st, 0, 3, 3);
    p.streakCount = 2;
    p.streakLastKillTick = st.tick;
    p.status = STATUS.FAST_DET;

    tap(st, p);

    assert.equal(st.bombs[0].streakPowered, true);
    assert.equal(st.bombs[0].fuseTicks, FUSE_TICKS_FAST);
    assert.equal(st.bombs[0].at, st.tick + FUSE_TICKS_FAST);
  });

  await t.test('expired streaks do not empower newly placed bombs', () => {
    const st = room();
    const p = spawn(st, 0, 3, 3);
    p.streakCount = 2;
    p.streakLastKillTick = st.tick - 1000;

    tap(st, p);

    assert.equal(st.bombs[0].streakPowered, false);
  });

  await t.test('streak power carries through stepwise powder-keg chains and their fire', () => {
    const st = room();
    setTile(st.map, 4, 3, BLOCK.POWDER, BLOCK_HP[BLOCK.POWDER]);
    st.bombs.push({
      id: 1, tx: 3, ty: 3, owner: 0, radius: 1, at: st.tick, streakPowered: true,
    });
    for (let i = 0; i < 5; i++, st.tick++) detonate(st);

    assert.ok(st.fires.some(f => f.tx === 4 && f.ty === 3));
    assert.ok(st.fires.every(f => f.streakPowered));
  });

  await t.test('a destructible block is damaged only when the stepped fire reaches it', () => {
    const st = room();
    setTile(st.map, 5, 3, BLOCK.SOFT, 1);
    st.bombs.push({ id: 1, tx: 3, ty: 3, owner: 0, radius: 3, at: st.tick });

    detonate(st);
    assert.equal(tileAt(st.map, 5, 3), BLOCK.SOFT, 'the distant wall broke instantly');

    st.tick += 2;
    detonate(st);
    assert.equal(tileAt(st.map, 5, 3), BLOCK.SOFT, 'the wall broke before the flame arrived');

    st.tick++;
    detonate(st);
    assert.equal(tileAt(st.map, 5, 3), BLOCK.SOFT, 'the wall broke before the flame arrived');

    st.tick++;
    detonate(st);
    assert.equal(tileAt(st.map, 5, 3), BLOCK.FLOOR, 'the wall survived the accelerated flame');
  });

  await t.test('fuse duration and streak power participate in deterministic hashes', () => {
    const normal = room();
    const empowered = room();
    const bombState = {
      id: 1, tx: 3, ty: 3, owner: 0, radius: 1, at: FUSE_TICKS,
      fuseTicks: FUSE_TICKS, streakPowered: false,
    };
    normal.bombs.push({ ...bombState });
    empowered.bombs.push({ ...bombState, fuseTicks: FUSE_TICKS_FAST, streakPowered: true });

    assert.notEqual(hashState(normal), hashState(empowered));
  });

  await t.test('explodes on its fuse tick, not before', () => {
    const st = room();
    spawn(st, 0, 3, 3);
    run(st, 1, [IN_BOMB]);
    assert.equal(st.bombs.length, 1);
    run(st, FUSE_TICKS - 1);
    assert.equal(st.bombs.length, 1, 'still ticking');
    run(st, 1);
    assert.equal(st.bombs.length, 0, 'gone');
    assert.ok(st.fires.length > 0, 'and left fire behind');
  });

  await t.test('a reinforced block takes six separate blasts', () => {
    const st = room();
    const p = immortal(spawn(st, 0, 3, 3));
    p.bombs = 1;
    p.dir = DIR_R;                           // facing the block, so the bomb lands against it
    setTile(st.map, 4, 3, BLOCK.REINFORCED, BLOCK_HP[BLOCK.REINFORCED]);
    for (let n = 0; n < 5; n++) { tapTick(st); run(st, FUSE_TICKS + 2); }
    assert.equal(tileAt(st.map, 4, 3), BLOCK.REINFORCED, 'still standing after five');
    assert.equal(hpAt(st.map, 4, 3), 1);
    tapTick(st); run(st, FUSE_TICKS + 2);
    assert.equal(tileAt(st.map, 4, 3), BLOCK.FLOOR, 'six does it');
  });

  await t.test('a line of bombs chains in stepped order', () => {
    const st = room(21, 9);
    const p = spawn(st, 0, 2, 4);
    p.bombs = 10; p.radius = 2;
    for (let i = 0; i < 8; i++) {
      p.x = tileCentre(2 + i * 2);
      tap(st, p);
      st.bombs.at(-1).at = st.tick + FUSE_TICKS + i * 10;   // wildly different fuses
    }
    assert.equal(st.bombs.length, 8);
    run(st, FUSE_TICKS + 8 * 5 + 1);
    assert.equal(st.bombs.length, 0, 'the fire wave did not reach every bomb');
  });

  await t.test('fire kills, and credits the right player', () => {
    const st = room();
    const killer = spawn(st, 0, 3, 3);
    const victim = spawn(st, 1, 4, 3);
    victim.status = 0; victim.statusUntil = {};
    victim.hp = 1;                           // already scorched: this hit is the last one (MAX_HP)
    killer.dir = DIR_R;                      // bombs go where you are looking
    tap(st, killer);
    run(st, FUSE_TICKS + 3);
    assert.equal(victim.alive, false);
    assert.equal(killer.kills, 1);
    assert.equal(victim.deaths, 1);
  });

  await t.test('invulnerability and shields both save you', () => {
    const st = room();
    const p = spawn(st, 0, 3, 3);
    p.status = STATUS.INVULN; p.statusUntil[STATUS.INVULN] = 9999;
    tap(st, p);
    run(st, FUSE_TICKS + 2);
    assert.equal(p.alive, true, 'invulnerable');

    const st2 = room();
    const q = spawn(st2, 0, 3, 3);
    q.shields = 1;
    place(st2, q, IN_BOMB);
    run(st2, FUSE_TICKS + 3);
    assert.equal(q.alive, true, 'shield absorbed it');
    assert.equal(q.shields, 0, 'and was spent');
  });

  await t.test('you cannot walk into a bomb you placed in front of you', () => {
    // Bombs land on the tile you are facing, so walking forward is walking into one.
    const st = room();
    const p = spawn(st, 0, 3, 3);
    p.dir = DIR_R;
    tap(st, p);
    assert.equal(st.bombs[0].tx, 4, 'the bomb did not land in front');
    run(st, 40, [IN_RIGHT]);
    assert.ok(p.x < tileCentre(4), 'walked into its own bomb');
    assert.ok(p.x > tileCentre(3), 'did not even approach it');
  });

  await t.test('facing a wall, the bomb lands underfoot instead', () => {
    // Otherwise the commonest action in the game - break the wall you are looking at - would
    // be impossible, because the tile you are aiming at is the wall itself.
    const st = room();
    const p = spawn(st, 0, 3, 3);
    p.dir = DIR_R;
    setTile(st.map, 4, 3, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
    tap(st, p);
    assert.equal(st.bombs.length, 1);
    assert.deepEqual([st.bombs[0].tx, st.bombs[0].ty], [3, 3], 'no fallback to the tile underfoot');
    run(st, FUSE_TICKS + 3);
    assert.equal(tileAt(st.map, 4, 3), BLOCK.FLOOR, 'the wall survived a bomb placed beside it');
  });

  await t.test('walking over a perk picks it up and applies it', () => {
    const st = room();
    const p = immortal(spawn(st, 0, 3, 3));
    drop(st, 5, 3, PERK.FIRE);
    const radius = p.radius;

    run(st, 40, [IN_RIGHT]);
    assert.equal(st.perks.length, 0, 'taken');
    assert.equal(p.radius, radius + 1, 'and it did something');
    assert.ok(p.score > 0, 'and scored');
  });

  await t.test('a capped perk stays available rather than paying out', () => {
    const st = room();
    const p = immortal(spawn(st, 0, 3, 3));
    p.radius = MAX_RADIUS;
    drop(st, 5, 3, PERK.FIRE);
    run(st, 40, [IN_RIGHT]);
    assert.equal(p.radius, MAX_RADIUS, 'capped');
    assert.equal(p.score, 0, 'a capped perk awarded score');
    assert.equal(st.perks.length, 1, 'a capped perk disappeared');
  });

  await t.test('drop weights are honoured over many rolls', () => {
    const st = room();
    const counts = {};
    for (let i = 0; i < 4000; i++) {
      st.perks.length = 0;
      maybeDrop(st, 1 + (i % 12), 1, BLOCK.REINFORCED);   // always drops
      const k = st.perks[0];
      if (k) counts[k.type] = (counts[k.type] || 0) + 1;
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.ok(total > 4000 * NON_GOLD_DROP_KEEP_CHANCE * 0.95,
      'reinforced blocks drop, except for the intended non-gold thinning');
    // Read the expected share straight from the weight table rather than hard-coding it, so
    // turning a perk on or off is a one-line change here too. Wide band: this is a sanity check
    // that the weighting works at all, not a chi-squared test.
    const live = Object.entries(PERK_WEIGHTS).filter(([, w]) => w > 0);
    const sum = live.reduce((n, [, w]) => n + w, 0);
    for (const [type, w] of live) {
      const share = (counts[type] || 0) / total;
      const want = w / sum;
      assert.ok(Math.abs(share - want) < 0.08,
        `perk ${type}: ${share.toFixed(3)} against an expected ${want.toFixed(3)}`);
    }
    // Everything at weight zero must never appear - the reserved types, and the three that are
    // implemented but switched off.
    for (const [type, w] of Object.entries(PERK_WEIGHTS)) {
      if (w === 0) assert.equal(counts[type], undefined, `perk ${type} is off but still dropped`);
    }
  });

  await t.test('broken blocks sometimes drop perks', () => {
    const st = room();
    const p = immortal(spawn(st, 0, 3, 3));
    p.bombs = 20;
    for (let x = 5; x < 13; x++) setTile(st.map, x, 3, BLOCK.SOFT, 1);
    for (let n = 0; n < 8; n++) {
      p.x = tileCentre(4 + n);
      if (tileAt(st.map, 4 + n, 3) !== BLOCK.FLOOR) continue;
      tap(st, p);
      run(st, FUSE_TICKS + 2);
    }
    assert.ok(p.radius > 1 || p.bombs > 1 || p.speed > 0 || st.perks.length > 0,
      'eight walls produced at least one perk, dropped or already collected');
  });

  await t.test('the whole round loop stays deterministic', () => {
    const script = [IN_RIGHT, IN_RIGHT | IN_BOMB, 0, 8, IN_BOMB, 4, 0, 2];
    const go = () => {
      const st = room(17, 17);
      const a = spawn(st, 0, 3, 3), b = spawn(st, 1, 9, 9);
      a.bombs = 3; b.bombs = 3;
      for (let x = 5; x < 12; x++) setTile(st.map, x, 5, BLOCK.SOFT, 1);
      for (let i = 0; i < 400; i++) tick(st, [script[i % script.length], script[(i + 3) % script.length]]);
      return hashState(st);
    };
    assert.equal(go(), go());
  });
});

test('a blast arm stops at another bomb', async t => {
  const room = () => {
    const st = createState({ id: 't', name: 't', w: 15, h: 15, seed: 1, density: 0, reinforced: 0, shrubs: 0 });
    for (let y = 0; y < 15; y++) for (let x = 0; x < 15; x++) {
      setTile(st.map, x, y, (x === 0 || y === 0 || x === 14 || y === 14) ? BLOCK.IRON : BLOCK.FLOOR);
    }
    return st;
  };

  await t.test('the arm lights the bomb tile and goes no further', () => {
    const st = room();
    const a = { id: 1, tx: 5, ty: 7, owner: 0, radius: 5, at: 0 };
    const b = { id: 2, tx: 7, ty: 7, owner: 1, radius: 1, at: 99 };
    st.bombs.push(a, b);

    const { cells } = spread(st.map, a, st.bombs);
    const on = (x, y) => cells.some(c => c.tx === x && c.ty === y);
    assert.ok(on(6, 7), 'stopped before reaching the bomb');
    assert.ok(on(7, 7), 'the bomb tile must still burn, or it would never chain');
    assert.ok(!on(8, 7), 'the arm carried on past the bomb');
    // The other three arms are untouched: this is a per-arm rule, not a per-blast one.
    assert.ok(on(5, 2) && on(5, 12) && on(1, 7));
  });

  await t.test('a bomb never stops its own blast', () => {
    const st = room();
    const a = { id: 1, tx: 5, ty: 7, owner: 0, radius: 3, at: 0 };
    st.bombs.push(a);
    const { cells } = spread(st.map, a, st.bombs);
    assert.ok(cells.some(c => c.tx === 8 && c.ty === 7), 'the blast stopped on itself');
  });

  await t.test('a line of three carries the fire wave onward one step at a time', () => {
    const st = room();
    for (const [i, x] of [5, 7, 9].entries()) {
      st.bombs.push({ id: i + 1, tx: x, ty: 7, o: 0, owner: 0, r: 3, radius: 3, at: i === 0 ? 0 : 500 });
    }
    detonate(st);
    assert.equal(st.events.filter(e => e.e === 'boom').length, 1, 'chain skipped the wave delay');
    for (let i = 0; i < 11; i++, st.tick++) detonate(st);
    const booms = st.events.filter(e => e.e === 'boom');
    assert.equal(booms.length, 3, `only ${booms.length} of the three went off`);
    assert.equal(st.bombs.length, 0, 'a bomb survived the chain');
  });

  await t.test('without a bomb list, arms pass through - the old behaviour', () => {
    const st = room();
    const a = { id: 1, tx: 5, ty: 7, owner: 0, radius: 5, at: 0 };
    st.bombs.push(a, { id: 2, tx: 7, ty: 7, owner: 1, radius: 1, at: 99 });
    const { cells } = spread(st.map, a);
    assert.ok(cells.some(c => c.tx === 9 && c.ty === 7), 'the optional argument is not optional');
  });
});

test('fire stops killing before it stops being drawn', () => {
  // Dying to the last frame of an explosion you watched finish feels like the game cheating.
  // The tail is embers: drawn, not lethal.
  const st = createState({ id: 't', name: 't', w: 9, h: 9, seed: 1, density: 0, reinforced: 0, shrubs: 0 });
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    setTile(st.map, x, y, (x === 0 || y === 0 || x === 8 || y === 8) ? BLOCK.IRON : BLOCK.FLOOR);
  }
  const p = createPlayer(0, 'p');
  p.alive = true;
  p.hp = 1;                       // one hit from dead, so "lethal" means exactly that (MAX_HP)
  p.x = tileCentre(4); p.y = tileCentre(4);
  st.players[0] = p;

  const grace = FIRE_TICKS - FIRE_LETHAL_TICKS;
  assert.ok(grace >= 1, 'there is no grace window at all');

  // A fire tile with only the embers left: still on screen, no longer lethal.
  st.fires.push({ tx: 4, ty: 4, kind: 'core', rot: 0, until: st.tick + grace, owner: 1 });
  tick(st, []);
  assert.equal(p.alive, true, 'killed by the tail of a blast');

  // And one with a tick of real fire left still kills, or this is just a nerf.
  st.fires.length = 0;
  st.fires.push({ tx: 4, ty: 4, kind: 'core', rot: 0, until: st.tick + grace + 1, owner: 1 });
  tick(st, []);
  assert.equal(p.alive, false, 'live fire stopped killing');
});

test('fire scheduled for a later wave step does not damage a player early', () => {
  const st = createState({ id: 't', name: 't', w: 9, h: 9, seed: 1, density: 0, reinforced: 0, shrubs: 0 });
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) {
    setTile(st.map, x, y, (x === 0 || y === 0 || x === 8 || y === 8) ? BLOCK.IRON : BLOCK.FLOOR);
  }
  const p = createPlayer(0, 'p');
  p.alive = true;
  p.hp = 1;
  p.x = tileCentre(4); p.y = tileCentre(4);
  st.players[0] = p;
  st.fires.push({
    tx: 4, ty: 4, kind: 'arm', rot: 0,
    startsAt: st.tick + 2, until: st.tick + 2 + FIRE_TICKS, owner: 1,
  });

  tick(st, []);
  assert.equal(p.alive, true, 'the wave damaged the player before reaching this tile');
  tick(st, []);
  assert.equal(p.alive, true, 'the wave arrived one tick early');
  tick(st, []);
  assert.equal(p.alive, false, 'the fire did not damage the player when it arrived');
});

test('bombs land on the tile you are facing', async t => {
  const open = () => {
    const st = createState({ id: 't', name: 't', w: 11, h: 11, seed: 1, density: 0, reinforced: 0, shrubs: 0 });
    for (let y = 0; y < 11; y++) for (let x = 0; x < 11; x++) {
      setTile(st.map, x, y, (x === 0 || y === 0 || x === 10 || y === 10) ? BLOCK.IRON : BLOCK.FLOOR);
    }
    return st;
  };
  const at = (st, tx, ty, dir) => {
    const p = createPlayer(0, 'p');
    p.alive = true; p.dir = dir;
    p.x = tileCentre(tx); p.y = tileCentre(ty);
    st.players[0] = p;
    return p;
  };

  await t.test('each of the four directions', () => {
    for (const [dir, dx, dy] of [[DIR_R, 1, 0], [DIR_U, 0, -1], [DIR_L, -1, 0], [DIR_D, 0, 1]]) {
      const st = open();
      const p = at(st, 5, 5, dir);
      tap(st, p);
      assert.deepEqual([st.bombs[0].tx, st.bombs[0].ty], [5 + dx, 5 + dy], `facing ${dir}`);
    }
  });

  await t.test('the facing tile is read from the tile you are IN, not from where in it you are', () => {
    // Otherwise the target would slide across a tile boundary as you walked, and the sight
    // would disagree with the bomb on the frames that matter most.
    const st = open();
    const p = at(st, 5, 5, DIR_R);
    p.x = tileCentre(5) + 100;               // most of the way across the tile
    assert.deepEqual(bombTile(st, p), { tx: 6, ty: 5 });
    p.x = tileCentre(5) - 100;               // most of the way back
    assert.deepEqual(bombTile(st, p), { tx: 6, ty: 5 });
  });

  await t.test('the sea and the map edge fall back too, not just walls', () => {
    const st = open();
    const p = at(st, 1, 5, DIR_L);           // facing the iron border
    tap(st, p);
    assert.deepEqual([st.bombs[0].tx, st.bombs[0].ty], [1, 5]);
  });

  await t.test('a bomb already in front falls back to underfoot', () => {
    const st = open();
    const p = at(st, 5, 5, DIR_R);
    p.bombs = 2;
    tap(st, p);
    tap(st, p);
    assert.equal(st.bombs.length, 2, 'the second bomb was refused');
    assert.deepEqual([st.bombs[1].tx, st.bombs[1].ty], [5, 5]);
  });

  await t.test('and with both tiles taken, nothing is placed', () => {
    const st = open();
    const p = at(st, 5, 5, DIR_R);
    p.bombs = 5;
    tap(st, p);
    tap(st, p);
    tap(st, p);
    assert.equal(st.bombs.length, 2, 'placed a third bomb on an occupied tile');
  });
});

/* Eight in a pair of hands, and spammable.
 *
 * Spam needs no new mechanism: placement is edge-triggered (one bomb per PRESS, not per tick the
 * key is down) and has no cooldown, so the only thing that ever limited a flurry was the cap.
 * These tests pin the cap, the flurry, and the one invariant the cap must not break.
 */
test('a player can hold eight bombs', () => {
  assert.equal(MAX_BOMBS_CARRIED, 8);
});

test('eight bombs go down back to back, and the ninth is refused', () => {
  const st = room(24, 5);
  const p = immortal(spawn(st, 0, 2, 2));
  p.bombs = MAX_BOMBS_CARRIED;

  /* No ticks at all between presses, which is the strictest reading of "spammable": the only
   * thing standing between a press and a bomb is the key edge and the cap. Driving it with
   * `tick` instead would spend ten ticks per tile on travel, and eight tiles of that outlives
   * FUSE_TICKS - the first bomb would detonate mid-flurry and the test would be measuring the
   * fuse. The player is moved by hand and faces up, so each bomb lands on its own free tile.
   */
  let placed = 0;
  for (let n = 0; n < MAX_BOMBS_CARRIED + 2; n++) {
    p.x = tileCentre(2 + n);
    p.dir = DIR_U;
    const before = st.bombs.length;
    tap(st, p);
    if (st.bombs.length > before) placed++;
  }
  assert.equal(placed, MAX_BOMBS_CARRIED,
    `laid ${placed} bombs with a cap of ${MAX_BOMBS_CARRIED}`);
  assert.equal(st.bombs.length, MAX_BOMBS_CARRIED, 'a bomb went off or vanished mid-flurry');
});

/* A powder keg is identified by having a radius ABOVE the player caps, not by a flag on the wire -
 * the renderer and the sound both lean on that. Raising the bomb cap must not close the gap, which
 * is why this asserts against the radius cap it does not touch. */
test('a powder keg still out-reaches anything a player can carry', () => {
  assert.ok(POWDER_RADIUS > MAX_RADIUS,
    `a keg reaches ${POWDER_RADIUS} and a player reaches ${MAX_RADIUS}`);
});
