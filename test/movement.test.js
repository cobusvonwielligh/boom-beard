// Movement is the one piece of the game that cannot be "fixed later" - everything after M1
// inherits its feel, and both the client prediction and the server run this exact code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, createPlayer, setTile, tileAt, tileCentre, hashState } from '../shared/sim/state.js';
import { step, blocked, speedOf } from '../shared/sim/movement.js';
import {
  BLOCK, IN_RIGHT, IN_LEFT, IN_DOWN, IN_UP, UNITS_PER_TILE, CORNER_ASSIST_UNITS,
  SPEED_UNITS_PER_TICK, MAX_SKATES, STATUS, DIR_R, DIR_D, DIR_L, BLOCK_HP, DIAG_NUM, DIAG_DEN,
} from '../shared/constants.js';
import { applyStatus } from '../shared/sim/state.js';
import { mossValue, mossyTile } from '../shared/moss.js';

/** An empty room with an iron border, so tests only see the walls they place. */
function room(w = 9, h = 9) {
  const st = createState({ id: 't', name: 't', w, h, seed: 1, density: 0, reinforced: 0, shrubs: 0 });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    setTile(st.map, x, y, (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? BLOCK.IRON : BLOCK.FLOOR);
  }
  return st;
}

function spawn(st, tx, ty) {
  const p = createPlayer(0, 'p');
  p.alive = true;
  p.x = tileCentre(tx); p.y = tileCentre(ty);
  st.players[0] = p;
  return p;
}

test('movement', async t => {
  await t.test('walks at exactly the tabled speed', () => {
    const st = room(); const p = spawn(st, 2, 2);
    const before = p.x;
    step(st, p, IN_RIGHT);
    assert.equal(p.x - before, SPEED_UNITS_PER_TICK[0]);
    assert.equal(p.dir, DIR_R);
  });

  await t.test('roller-skates stack up to the cap and no further', () => {
    assert.deepEqual(SPEED_UNITS_PER_TICK, [27, 33, 38, 44],
      'base pace stays fixed; boost bonuses rise 10%, with 10% extra at max');
    assert.equal(MAX_SKATES, 3);
    const p = createPlayer(0, 'p');
    const seen = [];
    for (let s = 0; s <= 8; s++) { p.speed = s; seen.push(speedOf(p)); }
    assert.deepEqual(seen.slice(0, MAX_SKATES + 1), SPEED_UNITS_PER_TICK);
    assert.equal(seen[8], SPEED_UNITS_PER_TICK.at(-1), 'over-cap speed clamps');
  });

  await t.test('slowdown halves it', () => {
    const st = room(); const p = spawn(st, 2, 2);
    applyStatus(st, p, STATUS.SLOWDOWN);
    assert.equal(speedOf(p), (SPEED_UNITS_PER_TICK[0] / 2) | 0);
  });

  await t.test('moss slowdown follows floor intensity', () => {
    const st = room();
    let at = null;
    for (let ty = 1; ty < st.map.h - 1 && !at; ty++) {
      for (let tx = 1; tx < st.map.w - 1; tx++) {
        if (tileAt(st.map, tx, ty) === BLOCK.FLOOR && mossyTile(tx, ty)) { at = { tx, ty }; break; }
      }
    }
    assert.ok(at, 'test room has no mossy floor tile');
    const p = spawn(st, at.tx, at.ty);
    const before = p.x;
    step(st, p, IN_RIGHT);
    const slow = 0.1 + 0.25 * mossValue(at.tx + 0.5, at.ty + 0.5);
    assert.equal(p.x - before, Math.max(1, (SPEED_UNITS_PER_TICK[0] * (1 - slow)) | 0));
  });

  await t.test('stops at a wall instead of entering it', () => {
    const st = room(); const p = spawn(st, 2, 2);
    setTile(st.map, 3, 2, BLOCK.SOFT);
    for (let i = 0; i < 40; i++) step(st, p, IN_RIGHT);
    assert.ok(!blocked(st, p, p.x, p.y), 'never ends up inside a wall');
    assert.ok(p.x < tileCentre(3), 'did not pass into the wall tile');
    // And it slid flush rather than stopping a visible gap short.
    assert.ok(tileCentre(3) - p.x < UNITS_PER_TILE, 'ends up adjacent to the wall');
  });

  // A doorway: solid above and below, gap straight ahead on your own row. Walking at it slightly
  // off-centre, your hitbox clips the jamb. This is the case that makes a grid game feel good or
  // awful, and it is what RULES.md §2 specifies.
  const doorway = () => {
    const st = room();
    setTile(st.map, 3, 1, BLOCK.SOFT);
    setTile(st.map, 3, 3, BLOCK.SOFT);
    return st;
  };

  await t.test('corner assist straightens you through a doorway you are nearly lined up with', () => {
    const st = doorway(); const p = spawn(st, 2, 2);
    p.y = tileCentre(2) + CORNER_ASSIST_UNITS;      // clipping the lower jamb
    // Centring is deliberately gentle - a few units a tick, easing - so getting lined up takes
    // tens of ticks rather than two. The assertion is still that it arrives EXACTLY.
    for (let i = 0; i < 220; i++) step(st, p, IN_RIGHT);
    assert.equal(p.y, tileCentre(2), 'straightened onto the doorway centre line');
    assert.ok(p.x > tileCentre(3), 'and went through');
  });

  await t.test('and does not when you are too far out of line', () => {
    const st = doorway(); const p = spawn(st, 2, 2);
    p.y = tileCentre(2) + CORNER_ASSIST_UNITS + 40; // beyond the window: aiming at the jamb
    for (let i = 0; i < 30; i++) step(st, p, IN_RIGHT);
    assert.ok(p.x < tileCentre(3), 'stopped at the wall, as it should');
  });

  await t.test('auto-centres onto a corridor while walking', () => {
    // A real corridor: walls above and below row 2, so there is nothing to corner into.
    const st = room();
    for (let x = 1; x <= 7; x++) { setTile(st.map, x, 1, BLOCK.SOFT); setTile(st.map, x, 3, BLOCK.SOFT); }
    const p = spawn(st, 2, 2);
    p.y = tileCentre(2) + 60;
    for (let i = 0; i < 160; i++) step(st, p, IN_RIGHT);
    assert.equal(p.y, tileCentre(2), 'drifted exactly onto the centre line');
  });

  /* RAILS. There is no "the line the player chose" any more.
   *
   * This test used to assert the opposite: that on open ground an off-centre pirate kept their
   * own line, because centring them would have dragged them off a gap they might be aiming for.
   * That trade-off existed because the gap had to be lined up with by hand. Queued turns removed
   * the need - you press the direction and the corner is taken for you - so the lane is now
   * exact, and being on it is the invariant everything else rests on.
   */
  await t.test('puts you on the lane and keeps you there, even on open ground', () => {
    const st = room(); const p = spawn(st, 2, 2);
    p.dir = DIR_R;
    p.y = tileCentre(2) + 60;                       // open above and below

    /* Walked back onto the lane, not snapped onto it. 60 units at base pace is three ticks, and
     * each of those ticks is spent correcting rather than travelling - easing sideways AND
     * travelling in the same tick would move both axes at once, which is the one thing a rail
     * pirate may never do. Only something external can put them off-lane in the first place. */
    let ticks = 0;
    while (p.y !== tileCentre(2) && ticks < 20) { step(st, p, IN_RIGHT); ticks++; }
    assert.ok(p.y === tileCentre(2), `never reached the lane centre, stuck at ${p.y}`);
    assert.ok(ticks <= 4, `took ${ticks} ticks to walk 60 units back onto the lane`);

    for (let i = 0; i < 20; i++) {
      step(st, p, IN_RIGHT);
      assert.equal(p.y, tileCentre(2), 'drifted off the lane while running along it');
    }
  });

  await t.test('changeling inverts both axes', () => {
    const st = room(); const p = spawn(st, 4, 4);
    applyStatus(st, p, STATUS.CHANGELING);
    const x0 = p.x;
    step(st, p, IN_RIGHT);
    assert.ok(p.x < x0, 'right went left');
  });

  await t.test('reduction fits through a column, normal size does not', () => {
    const st = room(); const p = spawn(st, 2, 2);
    setTile(st.map, 3, 2, BLOCK.COLUMN);
    for (let i = 0; i < 30; i++) step(st, p, IN_RIGHT);
    assert.ok(p.x < tileCentre(3), 'blocked by the column at full size');

    applyStatus(st, p, STATUS.REDUCTION);
    for (let i = 0; i < 40; i++) step(st, p, IN_RIGHT);
    assert.ok(p.x > tileCentre(3), 'squeezed through once reduced');
  });

  await t.test('diagonals do not stutter - it keeps the axis it is facing', () => {
    const st = room(); const p = spawn(st, 4, 4);
    step(st, p, IN_RIGHT);
    const dirAfterRight = p.dir;
    for (let i = 0; i < 5; i++) step(st, p, IN_RIGHT | IN_DOWN);
    assert.equal(p.dir, dirAfterRight, 'stayed on the axis it was already facing');
  });

  await t.test('is deterministic: same inputs, same state hash, twice', () => {
    const script = [IN_RIGHT, IN_RIGHT, IN_DOWN, IN_DOWN, IN_LEFT, IN_UP, 0, IN_RIGHT | IN_DOWN];
    const run = () => {
      const st = room(15, 15);
      const p = spawn(st, 3, 3);
      setTile(st.map, 5, 3, BLOCK.SOFT);
      setTile(st.map, 3, 6, BLOCK.REINFORCED);
      for (let i = 0; i < 300; i++) { step(st, p, script[i % script.length]); st.tick++; }
      return hashState(st);
    };
    assert.equal(run(), run());
  });
});

test('the corner chamfer cannot wedge you in a pocket', async t => {
  /* The cut forgives a corner so a diagonal glances off it. A corner with a solid tile beside it
   * is not that: it is a nook a tile deep, and forgiving it let a player slide in with a shoulder
   * inside both walls and no legal way out - the position being legal by the very rule that
   * produced it, so the unstick could not help either. */
  await t.test('a lone block corner is still forgiven', () => {
    const st = room();
    const p = spawn(st, 4, 4);
    setTile(st.map, 5, 5, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
    /* Clipping that corner by twenty units on both axes: the whole point of the chamfer.
     * The box is 160 wide, so its edge reaches 80 past the centre - putting the centre 20 units
     * short of the boundary means the SHOULDER is 20 units past it, which is the case being
     * forgiven. Putting the centre itself past the boundary would be standing in the block. */
    const x = tileCentre(4) + 68, y = tileCentre(4) + 68;
    assert.equal(blocked(st, p, x, y), false, 'the chamfer stopped working');
  });

  await t.test('the same corner with a neighbour is solid', () => {
    const st = room();
    const p = spawn(st, 4, 4);
    setTile(st.map, 5, 5, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
    setTile(st.map, 5, 4, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);   // beside it: now a nook
    const x = tileCentre(4) + 68, y = tileCentre(4) + 68;
    assert.equal(blocked(st, p, x, y), true, 'the cut opened a pocket to get wedged in');
  });

  await t.test('a diagonal cannot chamfer through a bomb corner', () => {
    const st = room();
    const p = spawn(st, 4, 4);
    st.bombs.push({ id: 1, tx: 5, ty: 5, owner: 1 });
    const x = tileCentre(4) + 68, y = tileCentre(4) + 68;
    assert.equal(blocked(st, p, x, y), true, 'the diagonal slipped through the bomb');
  });

  await t.test('and walking a diagonal into a pocket never ends up stuck', () => {
    const st = room();
    const p = spawn(st, 4, 4);
    setTile(st.map, 5, 5, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
    setTile(st.map, 5, 4, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
    setTile(st.map, 4, 5, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
    for (let i = 0; i < 30; i++) step(st, p, IN_RIGHT | IN_DOWN);
    assert.ok(!blocked(st, p, p.x, p.y), 'ended up inside the geometry');
    // And can still leave, which is the thing being wedged takes away.
    const x0 = p.x;
    for (let i = 0; i < 10; i++) step(st, p, IN_LEFT);
    assert.ok(p.x < x0, 'wedged: could not walk back out');
  });
});

test('a held diagonal slides along whatever is in the way', async t => {
  // Holding down-left with a wall below you used to do nothing at all: movement committed to
  // the axis you were facing and stopped dead when it was blocked, even with the other axis
  // wide open. You had to let go of one key to get round anything.
  await t.test('blocked below, pressed down-left: you go left', () => {
    const st = room();
    const p = spawn(st, 4, 4);
    p.dir = DIR_D;                                   // facing the blocked axis
    setTile(st.map, 4, 5, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
    const x0 = p.x;
    for (let i = 0; i < 12; i++) step(st, p, IN_DOWN | IN_LEFT);
    // Down is legal until the hitbox is flush against the wall, and taking that slack is
    // correct - what matters is that it then carries on LEFT instead of standing there.
    assert.ok(p.x < x0, 'did not slide along the obstacle');
    assert.ok(!blocked(st, p, p.x, p.y), 'ended up inside the wall');
    // Clearing the wall's column and THEN going down is the slide working, not a failure - with
    // a wide enough corner chamfer that now happens inside twelve ticks. What must never happen
    // is ending up over the wall itself.
    assert.ok((p.y >> 8) === 4 || (p.x >> 8) !== 4, 'descended through the blocked tile');
  });

  await t.test('blocked left, pressed down-left: you go down', () => {
    const st = room();
    const p = spawn(st, 4, 4);
    p.dir = DIR_L;
    setTile(st.map, 3, 4, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
    const y0 = p.y, x0 = p.x;
    for (let i = 0; i < 12; i++) step(st, p, IN_DOWN | IN_LEFT);
    assert.ok(p.y > y0, 'did not fall back to the open axis');
    assert.ok(p.x <= x0, 'moved away from the direction held');
    assert.ok(!blocked(st, p, p.x, p.y));
  });

  await t.test('boxed into the corner, you stop', () => {
    const st = room();
    const p = spawn(st, 4, 4);
    setTile(st.map, 4, 5, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
    setTile(st.map, 3, 4, BLOCK.SOFT, BLOCK_HP[BLOCK.SOFT]);
    const y0 = p.y, x0 = p.x;
    for (let i = 0; i < 12; i++) step(st, p, IN_DOWN | IN_LEFT);
    // Both axes take their slack up to the walls and then stop. What must not happen is ending
    // up inside either of them.
    assert.ok(!blocked(st, p, p.x, p.y), 'walked into a corner it should have stopped against');
    assert.ok(p.x <= x0 && p.y >= y0);
    assert.ok((p.x >> 8) === 4 && (p.y >> 8) === 4, 'left the tile it was boxed into');
  });

  /* RAILS. Holding two keys is not a diagonal; it is "keep going, and take the next corner
   * that way".
   *
   * The old behaviour moved both axes every tick at 1/sqrt(2) each, which is a real diagonal and
   * cannot exist on a lane. What a player holding two keys into a junction actually wants is to
   * round the corner without having to time the second press, and that is what the queued turn
   * gives them. The ground covered per tick is unchanged - a full pace, never more - so holding
   * two keys is still not a speed perk.
   */
  await t.test('two keys are travel plus a queued turn, never a diagonal', () => {
    const st = room();
    const p = spawn(st, 4, 4);
    p.dir = DIR_R;
    const pace = speedOf(p);
    let sawCorner = false;
    for (let i = 0; i < 40; i++) {
      const bx = p.x, by = p.y;
      step(st, p, IN_RIGHT | IN_DOWN);
      const dxm = Math.abs(p.x - bx), dym = Math.abs(p.y - by);
      // Never more than one tick of pace, whichever way it was spent.
      assert.ok(dxm + dym <= pace,
        `tick ${i}: covered ${dxm + dym} units against a pace of ${pace}`);
      if (dxm && dym) sawCorner = true;
      assert.ok(!blocked(st, p, p.x, p.y), `tick ${i}: ended up inside something`);
    }
    // And the second key did get used: the pirate turned rather than running straight forever.
    assert.ok(sawCorner || p.dir === DIR_D, 'the across-lane key was ignored entirely');
  });
});
