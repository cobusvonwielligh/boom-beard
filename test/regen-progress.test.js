// Walls grow back faster the later it is in the round.
//
// There were already two reasons for walls to regrow and only one of them was implemented. The
// existing scaling answers "is there cover left", off the map's wall fill. It only reacts AFTER
// the map is already bare, which was tolerable in a ten-minute round and is not in a six-minute
// one: the back half is over before the emptiness term has noticed. This adds the second
// question - "should this round be tightening" - off the clock, and the two multiply.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, tileAt, setTile, createPlayer, tileCentre } from '../shared/sim/state.js';
import { regenerate } from '../shared/sim/blocks.js';
import {
  BLOCK, REGEN_EVERY_TICKS, REGEN_MAX_FILL, ROUND_TICKS,
  REGEN_PROGRESS_AT_START, REGEN_PROGRESS_AT_END,
} from '../shared/constants.js';

/** An open room with an iron border: bare enough that the emptiness term is already saturated. */
function arena(w = 31, h = 21) {
  const st = createState({ id: 't', name: 't', w, h, seed: 7, density: 0, reinforced: 0, shrubs: 0 });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    setTile(st.map, x, y, (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? BLOCK.IRON : BLOCK.FLOOR);
  }
  st.map.spawns = [];
  st.roundTicks = ROUND_TICKS;
  return st;
}

const walls = st => {
  let n = 0;
  for (let y = 0; y < st.map.h; y++) for (let x = 0; x < st.map.w; x++) {
    const t = tileAt(st.map, x, y);
    if (t === BLOCK.SOFT || t === BLOCK.ICE) n++;
  }
  return n;
};

/* One regen cycle at a given tick, on a fresh arena. Returns how many walls appeared.
 *
 * The tick is snapped to a multiple of REGEN_EVERY_TICKS, because `regenerate` returns
 * immediately on any other tick - an un-snapped tick would measure zero and prove nothing.
 */
function cycleAt(tick) {
  const st = arena();
  st.tick = Math.max(REGEN_EVERY_TICKS, Math.round(tick / REGEN_EVERY_TICKS) * REGEN_EVERY_TICKS);
  regenerate(st);
  return walls(st);
}

test('regeneration scales with round progress', async t => {
  await t.test('the two ends of the scale are an increase', () => {
    assert.ok(REGEN_PROGRESS_AT_END > REGEN_PROGRESS_AT_START,
      'the end of a round must want at least as many walls as the start');
    assert.equal(REGEN_PROGRESS_AT_START, 1, 'the start of a round is the unscaled baseline');
  });

  await t.test('a late cycle grows more walls than an early one at the same fill', () => {
    // Same map, same fill, same rng seed - the only difference is the tick.
    const early = cycleAt(REGEN_EVERY_TICKS);
    const late = cycleAt(Math.floor(ROUND_TICKS * 0.9));
    assert.ok(late > early,
      `a cycle at 90% of the round grew ${late} walls, one at the start grew ${early}`);
  });

  await t.test('progress never beats the hard fill ceiling', () => {
    const st = arena();
    // Fill it well past the ceiling, then run the very last cycle of the round.
    for (let y = 1; y < st.map.h - 1; y++) for (let x = 1; x < st.map.w - 1; x++) {
      setTile(st.map, x, y, BLOCK.SOFT, 1);
    }
    // Carve a little floor back so there is somewhere a wall could go if the cap were ignored.
    for (let x = 1; x < st.map.w - 1; x++) setTile(st.map, x, 1, BLOCK.FLOOR);
    const before = walls(st);
    st.tick = Math.floor(ROUND_TICKS / REGEN_EVERY_TICKS) * REGEN_EVERY_TICKS;
    regenerate(st);
    assert.equal(walls(st), before,
      `a map over REGEN_MAX_FILL (${REGEN_MAX_FILL}) grew walls at the end of the round`);
  });

  await t.test('progress never walls a spawn or its neighbours', () => {
    const st = arena();
    st.map.spawns = [[5, 5], [20, 12]];
    st.tick = Math.floor(ROUND_TICKS * 0.95 / REGEN_EVERY_TICKS) * REGEN_EVERY_TICKS;
    for (let n = 0; n < 40; n++) {
      regenerate(st);
      st.tick += REGEN_EVERY_TICKS;
    }
    for (const [sx, sy] of st.map.spawns) {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        assert.equal(tileAt(st.map, sx + dx, sy + dy), BLOCK.FLOOR,
          `a wall grew on the spawn ring at ${sx + dx},${sy + dy}`);
      }
    }
  });

  await t.test('a state with no roundTicks behaves as the start of a round', () => {
    // Bots benches and most tests never set roundTicks. A divide by zero here would be NaN walls.
    for (const roundTicks of [0, undefined]) {
      const st = arena();
      st.roundTicks = roundTicks;
      st.tick = REGEN_EVERY_TICKS * 50;          // far past any round length
      regenerate(st);
      const n = walls(st);
      assert.ok(Number.isInteger(n) && n > 0,
        `roundTicks=${roundTicks} produced ${n} walls`);
    }
  });

  await t.test('a player standing there is still never walled in', () => {
    const st = arena();
    const p = createPlayer(0, 'p');
    p.alive = true;
    p.x = tileCentre(15); p.y = tileCentre(10);
    st.players[0] = p;
    st.tick = Math.floor(ROUND_TICKS * 0.95 / REGEN_EVERY_TICKS) * REGEN_EVERY_TICKS;
    for (let n = 0; n < 30; n++) {
      regenerate(st);
      st.tick += REGEN_EVERY_TICKS;
    }
    assert.equal(tileAt(st.map, 15, 10), BLOCK.FLOOR, 'a wall grew on top of a living player');
  });
});
