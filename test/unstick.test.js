// A player must always be able to move. These are the ways they used to end up unable to.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, createPlayer, tileCentre, setTile } from '../shared/sim/state.js';
import { step, blocked, unstick, speedOf } from '../shared/sim/movement.js';
import { place } from '../shared/sim/bombs.js';
import { tick } from '../shared/sim/round.js';
import {
  BLOCK, BLOCK_HP, IN_RIGHT, IN_DOWN, IN_BOMB, FUSE_TICKS, DIR_R, DIR_D, UNITS_PER_TILE,
} from '../shared/constants.js';

// A hand-authored empty room. The generated maps put an indestructible pillar on every even/even
// tile, so a clear 3x3 does not exist on any of them by construction - and these tests need room
// to move in every direction without a pillar deciding the answer for them.
const ROOM = {
  id: 'room', name: 'Test Room', w: 9, h: 9, seed: 1,
  rows: [
    '#########',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#########',
  ],
};

/** A player standing in the middle of the empty room. */
const world = () => ({ s: createState(ROOM), tx: 4, ty: 4 });

const seat = (s, i, tx, ty) => {
  const p = createPlayer(i, `p${i}`);
  p.x = tileCentre(tx); p.y = tileCentre(ty); p.alive = true;
  s.players[i] = p;
  return p;
};

test('a wall growing on top of you does not entomb you', () => {
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);

  setTile(s.map, tx, ty, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
  assert.ok(blocked(s, p, p.x, p.y), 'setup failed: the player should be inside a wall');

  assert.equal(unstick(s, p), true, 'unstick should report that it intervened');

  // It drifts rather than teleporting, so freedom takes a while - but a bounded while. A
  // twelfth of walking pace clears a whole tile in about 111 ticks, or 3.7 s, and that is the
  // worst case: being fully entombed. Stepping off your own bomb is a sliver of that. 250 is
  // generous and still catches a stall.
  let ticks = 1;
  while (blocked(s, p, p.x, p.y) && ticks < 250) { unstick(s, p); ticks++; }
  assert.ok(!blocked(s, p, p.x, p.y), `still inside a wall after ${ticks} ticks`);
  assert.ok(ticks > 1, 'it teleported - the whole point is that it slides');

  // And it is a neighbour, not a jump across the map.
  assert.ok(Math.abs((p.x >> 8) - tx) <= 1 && Math.abs((p.y >> 8) - ty) <= 1);
});

test('unstick is a no-op from a legal position', () => {
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);
  const before = { x: p.x, y: p.y };
  assert.equal(unstick(s, p), false);
  assert.deepEqual({ x: p.x, y: p.y }, before, 'it moved somebody who was perfectly fine');
});

test('both machines unstick the same way', () => {
  // The client predicts movement with this exact function. If the escape were not deterministic,
  // reconciliation would fight it every tick for as long as the player was stuck.
  const a = world(), b = world();
  const pa = seat(a.s, 0, a.tx, a.ty), pb = seat(b.s, 0, b.tx, b.ty);
  setTile(a.s.map, a.tx, a.ty, BLOCK.SOFT, 1);
  setTile(b.s.map, b.tx, b.ty, BLOCK.SOFT, 1);
  for (let i = 0; i < 25; i++) { unstick(a.s, pa); unstick(b.s, pb); }
  assert.deepEqual({ x: pa.x, y: pa.y }, { x: pb.x, y: pb.y });
});

test('a bomb dropped on you is not an unavoidable kill', () => {
  // Two players on one tile. One drops a bomb and walks off; the other used to find every
  // direction blocked - the bomb was solid to them immediately, with no grace for already being
  // inside it - and burned to death with no counterplay for the whole 72-tick fuse.
  const { s, tx, ty } = world();
  const victim = seat(s, 0, tx, ty);
  seat(s, 1, tx, ty);

  const inputs = new Array(16).fill(0);
  inputs[1] = IN_BOMB;
  tick(s, inputs);
  assert.equal(s.bombs.length, 1, 'setup failed: no bomb was placed');

  inputs[1] = 0;
  inputs[0] = IN_RIGHT;
  const startX = victim.x;
  for (let i = 0; i < FUSE_TICKS - 1; i++) tick(s, inputs);

  assert.ok(victim.x > startX + 256, `victim only moved ${victim.x - startX} units - still trapped`);
  assert.equal(victim.alive, true, 'victim died to a bomb they could not escape');
});

test('step() unsticks before it reads the position', () => {
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);
  setTile(s.map, tx, ty, BLOCK.SOFT, 1);
  for (let i = 0; i < 30; i++) step(s, p, IN_RIGHT);
  assert.ok(!blocked(s, p, p.x, p.y));
});

/* RAILS replaced both of the mechanisms this test used to measure.
 *
 * It asserted two things: that corridor centring was a gentle one-unit-a-tick drift onto the
 * lane, and that corner assist cleared a near-miss at a doorway within a few dozen ticks. Lane
 * centring is gone because the lane is exact rather than approached, and corner assist is gone
 * because queued turns do its job without requiring you to already be nearly lined up.
 *
 * What is worth keeping is the PROPERTY both of them existed to protect: a pirate walking at a
 * gap gets through it, and never spends ticks standing still against a doorway they can see they
 * fit through. That is tested here against the rails, and at every pace - the old assist had a
 * window (CORNER_ASSIST_UNITS) outside which it refused, and the rails have no such window.
 */
test('a pirate walking at a doorway always gets through it', () => {
  for (let speed = 0; speed <= 3; speed++) {
    // A doorway on row 4: solid above and below the gap, so the only way through is the lane.
    const s = createState(ROOM);
    for (const y of [3, 5]) setTile(s.map, 5, y, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
    const p = seat(s, 0, 2, 4);
    p.speed = speed;
    p.dir = DIR_R;

    let ticks = 0;
    while ((p.x >> 8) < 7 && ticks < 200) { step(s, p, IN_RIGHT); ticks++; }
    assert.ok((p.x >> 8) >= 7,
      `speed ${speed}: stuck at ${p.x >> 8},${p.y >> 8} after ${ticks} ticks`);
    assert.equal(p.y, tileCentre(4), `speed ${speed}: came off the lane getting through`);
  }
});

test('the escape from a wall is a drift, never a teleport', () => {
  /* The regression this replaces was real and invisible.
   *
   * The old flush-to-wall slide, applied from a position already overlapping a wall, computed an
   * edge a whole tile further on and moved the player 255 units in ONE tick. It read as a snap,
   * and it was what made the entombed-escape test pass - so the escape looked about a second
   * long while actually being two seconds of crawl and one frame of teleport.
   */
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);
  setTile(s.map, tx, ty, BLOCK.SOFT, 1);

  let biggest = 0, ticks = 0;
  while (blocked(s, p, p.x, p.y) && ticks < 200) {
    const bx = p.x, by = p.y;
    step(s, p, IN_RIGHT);
    biggest = Math.max(biggest, Math.abs(p.x - bx) + Math.abs(p.y - by));
    ticks++;
  }
  assert.ok(!blocked(s, p, p.x, p.y), `never escaped: ${ticks} ticks`);
  assert.ok(ticks <= 30, `the escape took ${ticks} ticks - entombment should cost about a second`);
  /* Two tick-sized movements is the honest ceiling: the drift out of the wall, plus - on the one
   * tick the position becomes legal again - easing back onto the lane. Both are bounded by the
   * legs. What must never reappear is a jump of a whole tile or more. */
  assert.ok(biggest <= 2 * speedOf(p),
    `one tick of the escape moved ${biggest} units against a pace of ${speedOf(p)} - that is a snap`);
  assert.ok(biggest < UNITS_PER_TILE, `one tick of the escape moved ${biggest} units - a teleport`);
});

test('walking off your own bomb never pushes you', () => {
  /* The commonest action in the game, and it used to shove you a third of a tile.
   *
   * A bomb became solid the instant your CENTRE left its tile, which left eighty units of
   * hitbox suddenly inside a solid square for `unstick` to push back out. Testing the hitbox
   * instead means it becomes solid exactly when you are clear of it, so there is nothing to
   * push and the unstick never runs.
   */
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);
  // Facing a wall, so the bomb lands underneath - which is the case this test is about.
  setTile(s.map, tx + 1, ty, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
  p.dir = DIR_R;
  place(s, p, IN_BOMB);
  assert.deepEqual([s.bombs[0]?.tx, s.bombs[0]?.ty], [tx, ty], 'setup failed: bomb not underfoot');

  const pace = speedOf(p);
  let biggest = 0;
  for (let n = 0; n < 60; n++) {
    const before = p.x;
    step(s, p, IN_RIGHT);
    biggest = Math.max(biggest, p.x - before);
    assert.ok(!blocked(s, p, p.x, p.y), `ended up inside something on tick ${n}`);
  }
  assert.ok(biggest <= pace, `moved ${biggest} units in a tick against a walking pace of ${pace}`);
  assert.ok(p.x > tileCentre(tx), 'did not actually walk away');
});

test('a bomb is still solid once you are clear of it', () => {
  // The other half: it has to become a wall, or you could walk back onto your own bomb and
  // stand on it indefinitely.
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);
  p.dir = DIR_D;
  place(s, p, IN_BOMB);                      // lands on the tile below
  assert.deepEqual([s.bombs[0]?.tx, s.bombs[0]?.ty], [tx, ty + 1]);
  for (let n = 0; n < 60; n++) step(s, p, IN_DOWN);
  assert.ok((p.y >> 8) === ty, 'walked onto a bomb it should have been stopped by');
});

test('standing on a bomb is never a shove, and standing in a wall always is', () => {
  // A bomb you are squarely on top of must not push you anywhere: you can walk off it, and
  // being moved when you were perfectly capable of moving yourself is the complaint this whole
  // area exists to answer. A wall grown on top of you is the opposite - inescapable without
  // help - and still gets the full seatbelt.
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);
  setTile(s.map, tx + 1, ty, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
  p.dir = DIR_R;
  place(s, p, IN_BOMB);                      // falls back to the tile underfoot
  assert.deepEqual([s.bombs[0]?.tx, s.bombs[0]?.ty], [tx, ty]);
  assert.equal(unstick(s, p), false, 'pushed by a bomb it is standing in the middle of');

  setTile(s.map, tx, ty, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
  assert.equal(unstick(s, p), true, 'a wall grown on top of you must still move you');
});

test('easing off the edge of a bomb is a nudge, not a shove', () => {
  // The bomb firms up a few units before you are completely clear, so there is something to
  // ease out of and stepping off one has a little weight. What must never come back is the
  // third of a tile the old centre-based rule produced.
  const { s, tx, ty } = world();
  const p = seat(s, 0, tx, ty);
  setTile(s.map, tx, ty + 1, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
  p.dir = DIR_D;
  place(s, p, IN_BOMB);
  assert.deepEqual([s.bombs[0]?.tx, s.bombs[0]?.ty], [tx, ty]);

  let nudges = 0, travelled = 0;
  for (let n = 0; n < 60; n++) {
    const before = p.x;
    if (unstick(s, p)) { nudges++; travelled += Math.abs(p.x - before); }
    step(s, p, IN_RIGHT);
  }
  assert.ok(travelled <= 24, `eased ${travelled} units off a bomb - that is a shove`);
  assert.ok(!blocked(s, p, p.x, p.y), 'left inside something');
});
