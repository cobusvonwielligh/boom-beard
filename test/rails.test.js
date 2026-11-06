/* Rail-lane movement.
 *
 * A pirate is always on the centre line of a row or a column. Travel is along that line; a press
 * across it is a TURN REQUEST, buffered and spent at the first tile centre where it is legal.
 *
 * This file is long on purpose. Movement is the one piece of the game that cannot be "fixed
 * later" - it is imported unchanged by both the server tick and the client's prediction, so a
 * mistake here is either a desync or a feel problem, and neither announces itself. The tests are
 * grouped as invariants (things that must hold after EVERY tick, checked over long random input
 * streams) and behaviours (the specific promises the rails make).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK, UNITS_PER_TILE, SPEED_UNITS_PER_TICK, MAX_SKATES, STATUS, HITBOX_UNITS,
  IN_RIGHT, IN_LEFT, IN_UP, IN_DOWN, IN_BOMB, IN_SLIDE,
  DIR_R, DIR_U, DIR_L, DIR_D, DIR_NONE, TURN_BUFFER_UNITS, STAMINA_MAX,
} from '../shared/constants.js';
import {
  createState, createPlayer, setTile, tileAt, tileCentre, walkable, hashState, applyStatus,
} from '../shared/sim/state.js';
import { step, speedOf, blocked } from '../shared/sim/movement.js';
import { tick } from '../shared/sim/round.js';
import { MAPS } from '../shared/maps.js';
import { createRoom } from '../server/room.js';
import { bombTile } from '../shared/sim/bombs.js';

const HALF = UNITS_PER_TILE >> 1;
const DIRS = [DIR_R, DIR_U, DIR_L, DIR_D];
const VEC = { [DIR_R]: [1, 0], [DIR_U]: [0, -1], [DIR_L]: [-1, 0], [DIR_D]: [0, 1] };
const MASK = { [DIR_R]: IN_RIGHT, [DIR_U]: IN_UP, [DIR_L]: IN_LEFT, [DIR_D]: IN_DOWN };

/** An empty room with an iron border, so a test only sees the walls it placed. */
function room(w = 15, h = 15) {
  const st = createState({ id: 't', name: 't', w, h, seed: 7, density: 0, reinforced: 0, shrubs: 0 });
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    setTile(st.map, x, y, (x === 0 || y === 0 || x === w - 1 || y === h - 1) ? BLOCK.IRON : BLOCK.FLOOR);
  }
  st.map.spawns = [];
  return st;
}

function spawn(st, tx, ty, { seat = 0, speed = 0, dir = DIR_R } = {}) {
  const p = createPlayer(seat, `p${seat}`);
  p.alive = true;
  p.x = tileCentre(tx); p.y = tileCentre(ty);
  p.speed = speed;
  p.dir = dir;
  p.stamina = STAMINA_MAX;
  st.players[seat] = p;
  return p;
}

const offset = u => u & (UNITS_PER_TILE - 1);
const onLaneCentre = u => offset(u) === HALF;
const atTileCentre = p => onLaneCentre(p.x) && onLaneCentre(p.y);

/** The invariant, as one assertion. Either x or y is dead on a lane centre line, always. */
function assertOnRail(p, where) {
  assert.ok(onLaneCentre(p.x) || onLaneCentre(p.y),
    `${where}: off the rails at x=${p.x} (off ${offset(p.x)}) y=${p.y} (off ${offset(p.y)})`);
}

// ─── invariants ───────────────────────────────────────────────────────────────

test('rails: invariants', async t => {
  await t.test('a pirate is always on a lane centre line, whatever the input', () => {
    const st = room(21, 21);
    // A scattering of walls, so the stream meets corners, dead ends and open ground.
    for (const [x, y] of [[4, 4], [4, 5], [5, 4], [8, 3], [8, 4], [8, 5], [12, 7], [13, 7],
      [6, 10], [7, 10], [8, 10], [15, 12], [15, 13], [15, 14], [10, 16], [11, 16]]) {
      setTile(st.map, x, y, BLOCK.SOFT, 1);
    }
    const p = spawn(st, 2, 2, { speed: 2 });
    // A deterministic pseudo-random input stream: every mask, including nonsense combinations.
    let seed = 12345;
    const nextMask = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >>> 7) & (IN_RIGHT | IN_UP | IN_LEFT | IN_DOWN | IN_SLIDE);
    };
    for (let n = 0; n < 4000; n++) {
      step(st, p, nextMask());
      assertOnRail(p, `tick ${n}`);
      assert.ok(DIRS.includes(p.dir), `tick ${n}: facing ${p.dir} is not one of four`);
    }
  });

  await t.test('a pirate is never left standing inside a solid tile', () => {
    const st = room(17, 17);
    for (const [x, y] of [[5, 5], [5, 6], [6, 5], [9, 9], [10, 9], [9, 10]]) {
      setTile(st.map, x, y, BLOCK.SOFT, 1);
    }
    const p = spawn(st, 2, 2, { speed: MAX_SKATES });
    let seed = 999;
    const nextMask = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return (seed >>> 9) & (IN_RIGHT | IN_UP | IN_LEFT | IN_DOWN);
    };
    for (let n = 0; n < 3000; n++) {
      step(st, p, nextMask());
      assert.ok(!blocked(st, p, p.x, p.y),
        `tick ${n}: standing in a wall at ${p.x >> 8},${p.y >> 8}`);
    }
  });

  await t.test('holding a clear direction never costs a tick of standing still', () => {
    for (let speed = 0; speed <= MAX_SKATES; speed++) {
      const st = room(21, 5);
      const p = spawn(st, 2, 2, { speed });
      const pace = speedOf(p);
      for (let n = 0; n < 15; n++) {
        const before = p.x;
        step(st, p, IN_RIGHT);
        assert.equal(p.x - before, pace,
          `speed ${speed}, tick ${n}: moved ${p.x - before} units, pace is ${pace}`);
      }
    }
  });

  await t.test('the same inputs always produce the same positions', () => {
    const run = () => {
      const st = room(19, 19);
      for (const [x, y] of [[6, 6], [6, 7], [7, 6], [11, 11]]) setTile(st.map, x, y, BLOCK.SOFT, 1);
      const p = spawn(st, 3, 3, { speed: 1 });
      let seed = 4242;
      const out = [];
      for (let n = 0; n < 600; n++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        step(st, p, (seed >>> 11) & (IN_RIGHT | IN_UP | IN_LEFT | IN_DOWN));
        out.push(`${p.x},${p.y},${p.dir}`);
      }
      return out.join('|');
    };
    assert.equal(run(), run(), 'movement is not reproducible from the same inputs');
  });

  /* The desync test. The server runs movement inside round.tick(); the client's prediction calls
   * step() directly on its own world. Both must agree to the unit over a long run, or the game
   * rubber-bands a minute into a round and no unit test would have said so. */
  await t.test('the round tick and a bare step agree over a long run', () => {
    const build = () => {
      const st = room(21, 21);
      for (const [x, y] of [[5, 5], [5, 6], [9, 4], [9, 5], [13, 9], [7, 14], [8, 14]]) {
        setTile(st.map, x, y, BLOCK.SOFT, 1);
      }
      return st;
    };
    const server = build(), client = build();
    const sp = spawn(server, 2, 2, { speed: 2 });
    const cp = spawn(client, 2, 2, { speed: 2 });

    /* Every field movement reads or writes, as one string. Not hashState: the server's tick also
     * runs the gulls, the regrowth and the perks, so the two WORLDS are legitimately different
     * and only the movement state has to match. Including the buffered turn is the point - a
     * divergence there is invisible until the next corner, which is exactly the bug class that
     * shows up as rubber-banding a minute into a round rather than as a failing assertion. */
    const moveState = p =>
      `${p.x},${p.y},${p.dir},${p.turnWant},${p.turnLeft},${p.slideV},${p.slideDir},${p.slide}`;

    let seed = 777;
    for (let n = 0; n < 1500; n++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const mask = (seed >>> 8) & (IN_RIGHT | IN_UP | IN_LEFT | IN_DOWN | IN_SLIDE);
      tick(server, [mask]);                  // the server's whole tick
      step(client, cp, mask);                // the client's prediction
      client.tick++;                         // ...which only advances movement
      assert.equal(moveState(cp), moveState(sp), `diverged on tick ${n}`);
    }
  });
});

// ─── travel and turning ───────────────────────────────────────────────────────

test('rails: travel and turning', async t => {
  await t.test('running a row keeps you dead centre in it for its whole length', () => {
    const st = room(21, 7);
    const p = spawn(st, 2, 3, { speed: 3 });
    const lane = tileCentre(3);
    for (let n = 0; n < 60; n++) {
      step(st, p, IN_RIGHT);
      assert.equal(p.y, lane, `tick ${n}: drifted to y=${p.y}, lane is ${lane}`);
    }
  });

  await t.test('a turn pressed early fires at the junction, not past it', () => {
    // A corridor along row 5 with one opening upward at column 9.
    const st = room(21, 11);
    for (let x = 1; x < 20; x++) { setTile(st.map, x, 4, BLOCK.SOFT, 1); }
    setTile(st.map, 9, 4, BLOCK.FLOOR);
    setTile(st.map, 9, 3, BLOCK.FLOOR);

    const p = spawn(st, 3, 5, { speed: 0 });
    // Hold right AND up from six tiles out. The up must be kept, then spent at column 9.
    let turned = -1;
    for (let n = 0; n < 120 && turned < 0; n++) {
      step(st, p, IN_RIGHT | IN_UP);
      if (p.dir === DIR_U) turned = n;
    }
    assert.ok(turned >= 0, 'the pirate ran past the only opening and never turned');
    assert.equal(p.x, tileCentre(9),
      `turned at column ${p.x >> 8} (x=${p.x}) instead of exactly at the junction, column 9`);
  });

  await t.test('a turn tapped once, well before the junction, still fires there', () => {
    const st = room(21, 11);
    for (let x = 1; x < 20; x++) setTile(st.map, x, 4, BLOCK.SOFT, 1);
    setTile(st.map, 5, 4, BLOCK.FLOOR);
    setTile(st.map, 5, 3, BLOCK.FLOOR);

    const p = spawn(st, 4, 5, { speed: 0 });
    // One tick of UP, released, a full tile short of the junction - the worst case the budget is
    // sized for. Run until the junction is reached or the budget is certainly gone.
    step(st, p, IN_RIGHT | IN_UP);
    for (let n = 0; n < 40 && p.dir !== DIR_U; n++) step(st, p, IN_RIGHT);
    assert.equal(p.dir, DIR_U, 'a buffered turn was dropped before it could be spent');
    assert.equal(p.x, tileCentre(5), 'the buffered turn fired at the wrong column');
  });

  await t.test('the buffer is a tile and a half of travel, at every pace', () => {
    /* The promise is about DISTANCE, so it has to hold for a pirate with four skates and for one
     * who is tired and slowed - the two ends of a 44-to-1 range of ticks per tile. A tick-based
     * budget could not be both, which is why this is in units. */
    for (const [label, speed, slowed] of [
      ['base', 0, false], ['skates', MAX_SKATES, false], ['slowed', 0, true],
    ]) {
      const st = room(21, 11);
      for (let x = 1; x < 20; x++) setTile(st.map, x, 4, BLOCK.SOFT, 1);
      setTile(st.map, 6, 4, BLOCK.FLOOR);
      setTile(st.map, 6, 3, BLOCK.FLOOR);
      const p = spawn(st, 5, 5, { speed });
      if (slowed) applyStatus(st, p, STATUS.SLOWDOWN, 100000);

      step(st, p, IN_RIGHT | IN_UP);                 // ask once, a tile out, then let go
      for (let n = 0; n < 600 && p.dir !== DIR_U; n++) step(st, p, IN_RIGHT);
      assert.equal(p.dir, DIR_U, `${label}: the turn expired before reaching the junction`);
    }
  });

  /* Review Focus 1: a request aimed at a wall that only opens much later must NOT fire then. */
  await t.test('a turn request expires rather than firing minutes later', () => {
    const st = room(21, 11);
    for (let x = 1; x < 20; x++) setTile(st.map, x, 4, BLOCK.SOFT, 1);

    const p = spawn(st, 3, 5, { speed: 0 });
    step(st, p, IN_RIGHT | IN_UP);                      // ask for a turn into solid wall
    // Travel well past the budget - two and a half tiles, where it is a tile and a half.
    const budgetTicks = Math.ceil((TURN_BUFFER_UNITS + UNITS_PER_TILE) / speedOf(p));
    for (let n = 0; n < budgetTicks; n++) step(st, p, IN_RIGHT);
    assert.equal(p.turnWant, DIR_NONE, 'the turn request outlived its distance budget');
    // Now open the wall, far later than the buffer.
    const col = p.x >> 8;
    setTile(st.map, col + 2, 4, BLOCK.FLOOR);
    for (let n = 0; n < 30; n++) step(st, p, IN_RIGHT);
    assert.equal(p.dir, DIR_R, 'an expired turn request fired when the wall finally opened');
  });

  /* The budget is charged on GROUND COVERED, not on ticks, which matters most for a pirate who is
   * not covering any: jammed against a wall with a turn asked for, the request must not rot while
   * they stand there. It is the commonest real situation - run into a corner, press the way you
   * want to go - and a tick-charged budget would expire it before they could back off. */
  /* Running into a corner and pressing the way you want to go.
   *
   * This is how everybody takes a corner, and it is the case the flush stop made delicate: flush
   * is mid-segment, a turn can only be spent at a junction, so without the glide back to the
   * junction the press would do nothing and the pirate would sit in the corner. Both the
   * press-the-new-direction form and the hold-both form have to work.
   */
  await t.test('jammed in a corner, pressing the new direction takes it', () => {
    const st = room(21, 11);
    setTile(st.map, 8, 5, BLOCK.SOFT, 1);               // a wall straight ahead
    const p = spawn(st, 6, 5, { speed: 0 });
    for (let n = 0; n < 60; n++) step(st, p, IN_RIGHT); // jam into it
    const jammedY = p.y;

    for (let n = 0; n < 40; n++) step(st, p, IN_DOWN);  // now just press down
    assert.ok(p.y > jammedY + UNITS_PER_TILE,
      `only got ${p.y - jammedY} units down after turning out of a corner`);
    assert.equal(p.dir, DIR_D, 'never turned out of the corner');
  });

  await t.test('jammed in a corner while still holding into the wall also turns', () => {
    const st = room(21, 11);
    setTile(st.map, 8, 5, BLOCK.SOFT, 1);
    const p = spawn(st, 6, 5, { speed: 0 });
    for (let n = 0; n < 60; n++) step(st, p, IN_RIGHT);
    const jammedY = p.y;
    // Both keys held, which is what a player mid-panic actually does.
    for (let n = 0; n < 40; n++) step(st, p, IN_RIGHT | IN_DOWN);
    assert.ok(p.y > jammedY,
      'holding into the wall while asking to turn left the pirate stuck in the corner');
  });

  /* The budget is charged on GROUND COVERED, never on ticks.
   *
   * Stated as an invariant rather than as a scenario, because it is the property the whole
   * distance-based buffer rests on: a pirate who is not moving cannot be losing grace. Checked
   * directly - the drop in `turnLeft` over a tick never exceeds the distance travelled in it.
   */
  await t.test('the turn budget is only ever spent on distance travelled', () => {
    const st = room(21, 21);
    for (const [x, y] of [[8, 5], [5, 8], [12, 12], [12, 13]]) setTile(st.map, x, y, BLOCK.SOFT, 1);
    const p = spawn(st, 3, 5, { speed: 1 });
    let seed = 24680;
    for (let n = 0; n < 1500; n++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const mask = (seed >>> 12) & (IN_RIGHT | IN_UP | IN_LEFT | IN_DOWN);
      const bx = p.x, by = p.y, bLeft = p.turnLeft;
      step(st, p, mask);
      const dist = Math.abs(p.x - bx) + Math.abs(p.y - by);
      // A fresh request re-stamps the budget upward, which is not a charge.
      if (p.turnLeft > bLeft) continue;
      // A request that was SPENT or expired zeroes it, which is also not a per-tick charge.
      if (p.turnLeft === 0) continue;
      assert.ok(bLeft - p.turnLeft <= dist,
        `tick ${n}: the budget lost ${bLeft - p.turnLeft} units having travelled ${dist}`);
    }
  });

  await t.test('a held direction is never treated as expired', () => {
    const st = room(31, 11);
    for (let x = 1; x < 30; x++) setTile(st.map, x, 4, BLOCK.SOFT, 1);
    setTile(st.map, 25, 4, BLOCK.FLOOR);
    setTile(st.map, 25, 3, BLOCK.FLOOR);

    const p = spawn(st, 2, 5, { speed: 0 });
    // Twenty-three tiles of travel, far beyond the buffer, with UP held the whole way.
    let turned = false;
    for (let n = 0; n < 400 && !turned; n++) {
      step(st, p, IN_RIGHT | IN_UP);
      turned = p.dir === DIR_U;
    }
    assert.ok(turned, 'a held turn key expired instead of waiting for its junction');
    assert.equal(p.x, tileCentre(25), 'the held turn fired at the wrong column');
  });

  await t.test('reversing needs no junction and happens at once', () => {
    const st = room(21, 7);
    const p = spawn(st, 5, 3, { speed: 0 });
    step(st, p, IN_RIGHT);
    const mid = p.x;
    assert.ok(!onLaneCentre(mid), 'the test needs the pirate off a tile centre');
    step(st, p, IN_LEFT);
    assert.equal(p.dir, DIR_L, 'reversing waited for a junction');
    assert.ok(p.x < mid, 'reversing did not actually move the pirate back');
  });

  /* "No diagonals" is not "never two axes in one tick", and the difference matters.
   *
   * Taking a corner at full pace necessarily moves on both axes in the tick the turn is spent -
   * part of the pace down the old lane, the rest down the new one. That is the same fact as "a
   * corner costs no distance" seen from another angle, and a test that forbade it would be
   * demanding the stutter the rails were built to remove.
   *
   * The property that actually distinguishes an L-shaped corner from a diagonal is that any tick
   * touching both axes PASSED THROUGH A JUNCTION: the two legs meet at a tile centre, so the path
   * is two straight segments and never a line cutting a corner off. Checked by reconstructing the
   * corner - the junction has to be the old lane's coordinate and the new lane's, both exact.
   */
  await t.test('two axes in one tick only ever means an L through a junction', () => {
    const st = room(15, 15);
    const p = spawn(st, 7, 7, { speed: 2 });
    const pace = speedOf(p);
    let corners = 0;
    for (let n = 0; n < 200; n++) {
      const bx = p.x, by = p.y;
      step(st, p, IN_RIGHT | IN_UP);
      const dxm = Math.abs(p.x - bx), dym = Math.abs(p.y - by);
      assert.ok(DIRS.includes(p.dir), `tick ${n}: facing ${p.dir}`);
      if (!dxm || !dym) continue;                     // a straight tick, nothing to check
      corners++;
      // The two legs sum to exactly one tick of pace: no diagonal speed bonus, no lost pace.
      assert.equal(dxm + dym, pace,
        `tick ${n}: an L of ${dxm}+${dym} units against a pace of ${pace}`);
      /* And they meet at a real junction, so the corner is square rather than cut.
       *
       * Either leg can come first - whichever lane the pirate was on when the tick began - so the
       * elbow is one of two points, and the test accepts either rather than assuming an order
       * that depends on the direction of travel. */
      const elbows = [[bx, p.y], [p.x, by]];
      assert.ok(elbows.some(([ex, ey]) => onLaneCentre(ex) && onLaneCentre(ey)),
        `tick ${n}: ${bx},${by} -> ${p.x},${p.y} is a cut corner, not an L`);
    }
    assert.ok(corners > 0, 'the pirate never turned, so nothing was tested');
  });

  /* The thing that makes a corner feel smooth rather than like a stop and a start: the tick a
   * turn is spent, the pirate still travels its full pace - part down the old lane, the rest down
   * the new one. A corner that cost a tick of pace would read as catching on it. */
  await t.test('a corner costs no distance: full pace through the turn', () => {
    const st = room(15, 15);
    // A clean right-angle: row 7 open, column 7 open upward.
    const p = spawn(st, 4, 7, { speed: 0 });
    const pace = speedOf(p);
    // Walk up to just short of the junction with UP held, then watch the turning tick.
    let turningTick = -1;
    for (let n = 0; n < 60 && turningTick < 0; n++) {
      const bx = p.x, by = p.y, bdir = p.dir;
      step(st, p, IN_RIGHT | IN_UP);
      const dist = Math.abs(p.x - bx) + Math.abs(p.y - by);
      assert.equal(dist, pace,
        `tick ${n}: travelled ${dist} of ${pace} units (dir ${bdir} -> ${p.dir})`);
      if (p.dir !== bdir) turningTick = n;
    }
    assert.ok(turningTick >= 0, 'the pirate never turned, so the corner was never tested');
  });

  await t.test('a turn passes exactly through the junction centre, never overshooting', () => {
    const st = room(15, 15);
    for (let speed = 0; speed <= MAX_SKATES; speed++) {
      const s = room(15, 15);
      const p = spawn(s, 3, 7, { speed });
      for (let n = 0; n < 80; n++) {
        step(s, p, IN_RIGHT | IN_UP);
        if (p.dir === DIR_U) break;
      }
      assert.equal(p.dir, DIR_U, `speed ${speed}: never turned`);
      // The column it turned up is whichever junction it reached first; what matters is that it
      // is exactly on that column's centre line, with no fraction of a tile left over.
      assert.ok(onLaneCentre(p.x),
        `speed ${speed}: turned at x=${p.x}, which is ${offset(p.x)} into the tile, not ${HALF}`);
    }
    assert.ok(st);
  });

  /* Pressing across the lane while standing still mid-corridor.
   *
   * The naive rail implementation deadlocks here: the turn can only be spent at a tile centre,
   * the pirate is not at one, and with no along-lane input they never reach one. The press does
   * nothing, the buffer expires, and the player has found the exact "stuck on a corner" feeling
   * rails were supposed to remove. So a turn request with no along-input glides to the nearest
   * centre to spend itself. */
  await t.test('a turn pressed while stopped mid-corridor glides to the nearest centre', () => {
    const st = room(15, 15);
    const p = spawn(st, 5, 7, { speed: 0 });
    step(st, p, IN_RIGHT);                     // now mid-tile, stopped
    assert.ok(!onLaneCentre(p.x), 'the test needs the pirate off a tile centre');

    let turned = false;
    for (let n = 0; n < 30 && !turned; n++) {
      step(st, p, IN_UP);                      // only across the lane - no along-lane input
      turned = p.dir === DIR_U;
    }
    assert.ok(turned, 'a pirate stopped mid-corridor could not turn at all');
    assert.ok(onLaneCentre(p.x), `turned off-centre at x=${p.x}`);
  });

  /* Flush against the wall, not stopped a tile short of it.
   *
   * The first rail implementation stopped at the last tile CENTRE, which left 48 units of
   * daylight - a tile is 256 and the hitbox 160 - and made walls read as repellent rather than
   * solid. Flush is the leading edge of the box exactly on the boundary.
   */
  await t.test('walking into a wall leaves you touching it, not a tile short', () => {
    const st = room(15, 15);
    setTile(st.map, 8, 7, BLOCK.SOFT, 1);
    const p = spawn(st, 5, 7, { speed: 0 });
    for (let n = 0; n < 60; n++) step(st, p, IN_RIGHT);

    const half = HITBOX_UNITS >> 1;
    assert.equal(p.x, tileCentre(8) - HALF - half,
      `stopped at x=${p.x}; flush against column 8 is ${tileCentre(8) - HALF - half}`);
    assert.ok(!blocked(st, p, p.x, p.y), 'flush put the pirate inside the wall');
    assert.equal(p.dir, DIR_R, 'facing changed while pressed against a wall');

    // And it stays there: no oscillation between two positions.
    const resting = p.x;
    for (let n = 0; n < 10; n++) {
      step(st, p, IN_RIGHT);
      assert.equal(p.x, resting, `tick ${n}: jittered to ${p.x} while held against a wall`);
    }
  });

  await t.test('a dead end can be backed out of', () => {
    const st = room(15, 15);
    // A one-tile pocket off row 7, open only to the left.
    for (const [x, y] of [[9, 6], [9, 8], [10, 7]]) setTile(st.map, x, y, BLOCK.SOFT, 1);
    const p = spawn(st, 9, 7, { speed: 0, dir: DIR_R });
    for (let n = 0; n < 20; n++) step(st, p, IN_RIGHT);     // jam into the end
    for (let n = 0; n < 20; n++) step(st, p, IN_LEFT);      // and out again
    assert.ok(p.x < tileCentre(9), `could not back out of a dead end, x=${p.x}`);
  });
});

/* Pirates are not solid to each other, and never have been.
 *
 * `blocked` tests terrain and bombs; there is no player-versus-player collision anywhere in the
 * simulation, and the rails did not add one - `canStand` asks the same question. Worth pinning
 * because rails are exactly the kind of change that could quietly introduce it: two pirates on
 * one lane are now perfectly aligned rather than passing at an offset, so a collision rule that
 * did not exist would be very obvious the moment anybody added one.
 */
test('rails: pirates walk through each other', async t => {
  await t.test('head-on, on the same lane', () => {
    const st = room(21, 7);
    const a = spawn(st, 3, 3, { seat: 0, dir: DIR_R });
    const b = spawn(st, 12, 3, { seat: 1, dir: DIR_L });
    // Nine tiles each at base pace is ~86 ticks; 150 leaves room and still ends inside the room.
    for (let n = 0; n < 150; n++) {
      step(st, a, IN_RIGHT);
      step(st, b, IN_LEFT);
    }
    assert.ok((a.x >> 8) > 12, `a stopped at ${a.x >> 8}; it should have passed b`);
    assert.ok((b.x >> 8) < 3, `b stopped at ${b.x >> 8}; it should have passed a`);
  });

  await t.test('standing on top of one another, then walking off', () => {
    const st = room(15, 15);
    const a = spawn(st, 7, 7, { seat: 0 });
    const b = spawn(st, 7, 7, { seat: 1 });
    assert.equal(a.x, b.x);
    for (let n = 0; n < 40; n++) step(st, a, IN_RIGHT);
    assert.ok((a.x >> 8) > 7, 'could not walk out from under another pirate');
    assert.equal(b.x >> 8, 7, 'the other pirate was dragged along');
  });

  await t.test('a crowd on one tile does not wedge anybody', () => {
    const st = room(15, 15);
    const crowd = [];
    for (let i = 0; i < 8; i++) crowd.push(spawn(st, 7, 7, { seat: i }));
    for (let n = 0; n < 40; n++) for (const q of crowd) step(st, q, IN_UP);
    for (const q of crowd) {
      assert.ok((q.y >> 8) < 7, `seat ${q.i} never got out of the pile`);
      assertOnRail(q, `seat ${q.i}`);
    }
  });
});

// ─── the whole map ────────────────────────────────────────────────────────────

test('rails: every open adjacency on every real map is traversable', () => {
  /* The strongest form of "we never get stuck on corners".
   *
   * For every pair of neighbouring walkable tiles on every shipped map, stand on one, hold the
   * direction of the other, and require arrival. A single refusing adjacency is a place on a real
   * island where a player presses a direction into open floor and does not go - which is the
   * whole complaint rails exist to answer.
   */
  let checked = 0;
  const failures = [];
  for (const [mi, map] of MAPS.entries()) {
    const probe = createState(map, 7);
    for (let ty = 1; ty < probe.map.h - 1; ty++) {
      for (let tx = 1; tx < probe.map.w - 1; tx++) {
        if (!walkable(probe.map, tx, ty)) continue;
        for (const dir of DIRS) {
          const [dx, dy] = VEC[dir];
          const nx = tx + dx, ny = ty + dy;
          if (!walkable(probe.map, nx, ny)) continue;
          checked++;
          const p = spawn(probe, tx, ty, { dir });
          /* Did we ever ENTER the neighbour - not "is it where we stopped". A tile is 256 units
           * and base pace is 27, so twenty ticks is two tiles of travel and the pirate sails
           * straight through the target on an open map. Arrival is the question. */
          let arrived = false;
          for (let n = 0; n < 20 && !arrived; n++) {
            step(probe, p, MASK[dir]);
            arrived = (p.x >> 8) === nx && (p.y >> 8) === ny;
          }
          if (!arrived && failures.length < 10) {
            failures.push(`map${mi} ${tx},${ty} -> ${nx},${ny} (dir ${dir}) ended at ${p.x >> 8},${p.y >> 8}`);
          }
          probe.players[0] = null;
        }
      }
    }
  }
  assert.ok(checked > 1000, `the sweep only found ${checked} adjacencies to try`);
  assert.deepEqual(failures, [], `${failures.length}+ adjacencies refused a legal move`);
});

test('rails: a pirate can walk a real map from one end to the other', () => {
  /* Connectivity, end to end, on real geometry.
   *
   * Counting tiles visited by a random walk was the first version of this and it was a bad test:
   * it failed because the spawn it picked sits in a tight corner of the maze, which says nothing
   * about the rails. This asks the question that matters instead - breadth-first search the map
   * for the FURTHEST tile reachable on foot, then actually drive the pirate there along that path
   * and require arrival. If the rails can walk the longest route on every shipped island, there
   * is no corner on any of them that refuses.
   */
  /* Both a fresh map and a chewed-open one.
   *
   * At the top of a round the island is full of soft walls, so the region reachable ON FOOT is
   * small - a couple of dozen tiles around each spawn - and that is the correct early-round
   * shape, not a bug. The long routes only exist once the walls have been blown through, which is
   * also when the corners get interesting, so both states are walked.
   */
  const cases = [];
  for (const [mi, map] of MAPS.entries()) {
    /* A fresh spawn can be almost entirely walled in - five tiles on one of the islands - because
     * the soft walls have not been blown yet. That is the correct early-round shape, so the floor
     * is low and the real reach is tested by the blown-open case below. */
    cases.push([`map${mi} fresh`, createState(map, 7), 3]);
    const open = createState(map, 7);
    for (let y = 0; y < open.map.h; y++) for (let x = 0; x < open.map.w; x++) {
      const t = tileAt(open.map, x, y);
      if (t === BLOCK.SOFT || t === BLOCK.ICE || t === BLOCK.POWDER) setTile(open.map, x, y, BLOCK.FLOOR, 0);
    }
    cases.push([`map${mi} blown open`, open, 60]);
  }

  for (const [label, st, minTiles] of cases) {
    const start = st.map.spawns?.[0];
    assert.ok(start, `${label} has no spawns`);

    // BFS over walkable tiles, keeping each tile's predecessor so the path can be rebuilt.
    const key = (x, y) => `${x},${y}`;
    const from = new Map([[key(start[0], start[1]), null]]);
    const queue = [[start[0], start[1]]];
    let furthest = [start[0], start[1]];
    for (let head = 0; head < queue.length; head++) {
      const [cx, cy] = queue[head];
      furthest = [cx, cy];                           // BFS order: the last dequeued is furthest
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (!walkable(st.map, nx, ny) || from.has(key(nx, ny))) continue;
        from.set(key(nx, ny), [cx, cy]);
        queue.push([nx, ny]);
      }
    }
    assert.ok(queue.length >= minTiles,
      `${label}: only ${queue.length} tiles reachable from the spawn, so this proves little`);

    const path = [];
    for (let at = furthest; at; at = from.get(key(at[0], at[1]))) path.unshift(at);

    const p = spawn(st, start[0], start[1]);
    for (let i = 1; i < path.length; i++) {
      const [tx, ty] = path[i];
      const dir = tx > (p.x >> 8) ? DIR_R : tx < (p.x >> 8) ? DIR_L
        : ty > (p.y >> 8) ? DIR_D : DIR_U;
      let arrived = false;
      /* The budget is derived from the CURRENT pace, not a flat tick count.
       *
       * A flat 30 ticks was the first version and it failed about forty legs in - not because the
       * rails got stuck but because the pirate had run out of stamina by then and was limping at
       * half pace, and a leg that needs a glide back to a junction plus a full tile is 384 units.
       * Moss drags it further. Deriving it keeps the test about movement rather than about how
       * tired a long walk makes you.
       */
      const budget = Math.ceil((UNITS_PER_TILE * 2) / speedOf(p)) + 6;
      const startedAt = `${p.x},${p.y}`;
      for (let n = 0; n < budget && !arrived; n++) {
        step(st, p, MASK[dir]);
        st.tick++;
        assertOnRail(p, `${label} leg ${i}`);
        assert.ok(!blocked(st, p, p.x, p.y), `${label} leg ${i}: inside a wall`);
        arrived = (p.x >> 8) === tx && (p.y >> 8) === ty;
      }
      assert.ok(arrived,
        `${label}: stuck on leg ${i} of ${path.length - 1}, heading for ${tx},${ty} from ${p.x >> 8},${p.y >> 8}`);
      // Belt and braces: a leg that "arrived" without the pirate moving at all would mean the
      // path had a duplicate tile in it and the walk proved nothing.
      assert.notEqual(`${p.x},${p.y}`, startedAt, `${label}: leg ${i} moved nobody`);
    }
    assert.equal(`${p.x >> 8},${p.y >> 8}`, `${furthest[0]},${furthest[1]}`,
      `${label}: did not finish the walk`);
  }
});

// ─── interactions ─────────────────────────────────────────────────────────────

test('rails: slides, water and rum', async t => {
  await t.test('a slide stays on its lane and cannot be steered', () => {
    const st = room(21, 21);
    const p = spawn(st, 3, 10, { speed: 1 });
    const lane = tileCentre(10);
    // Launch right, then hold UP for the whole slide: it must not turn.
    step(st, p, IN_RIGHT | IN_SLIDE);
    assert.ok(p.slideV > 0, 'no slide started');
    while (p.slideV > 0) {
      step(st, p, IN_UP);
      assert.equal(p.y, lane, `a slide left its lane, y=${p.y}`);
      assert.equal(p.slideDir, DIR_R, 'a slide changed direction mid-flight');
    }
  });

  await t.test('a slide never leaves the pirate off a lane centre', () => {
    const st = room(21, 21);
    for (let speed = 0; speed <= MAX_SKATES; speed++) {
      const s = room(21, 21);
      const p = spawn(s, 3, 10, { speed });
      step(s, p, IN_RIGHT | IN_SLIDE);
      let guard = 0;
      while (p.slideV > 0 && guard++ < 60) {
        step(s, p, 0);
        assertOnRail(p, `slide at speed ${speed}`);
      }
    }
    assert.ok(st);
  });

  await t.test('coasting out of water carries along the lane, not off it', () => {
    const st = room(21, 11);
    const p = spawn(st, 4, 5, { speed: 0 });
    for (let x = 3; x < 12; x++) st.puddles.push({ tx: x, ty: 5, at: 0, until: 100000 });
    for (let n = 0; n < 12; n++) step(st, p, IN_RIGHT);
    const lane = tileCentre(5);
    for (let n = 0; n < 12; n++) {
      step(st, p, 0);                       // let go: the puddle coast carries on
      assert.equal(p.y, lane, `coasting drifted to y=${p.y}`);
      assertOnRail(p, `coast tick ${n}`);
    }
  });

  /* Rum used to sway you sideways off the line you were walking. On rails there is no sideways to
   * be swayed into, so the cost moves into the TURNS: a drunk pirate sometimes fumbles one. The
   * cost has to still exist - a defensive perk with no downside is just a better perk. */
  await t.test('rum cannot push a pirate off a lane', () => {
    const st = room(21, 21);
    const p = spawn(st, 3, 10, { speed: 1 });
    applyStatus(st, p, STATUS.DRUNK, 100000);
    let seed = 8080;
    for (let n = 0; n < 1200; n++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      step(st, p, (seed >>> 10) & (IN_RIGHT | IN_UP | IN_LEFT | IN_DOWN));
      assertOnRail(p, `drunk tick ${n}`);
      assert.ok(!blocked(st, p, p.x, p.y), `drunk tick ${n}: inside a wall`);
    }
  });

  /* A fumbled turn must still leave the pirate facing a real direction.
   *
   * `spendTurn` clears the request when rum fumbles it, so code that read `p.turnWant` after
   * calling it got DIR_NONE and assigned -1 to `p.dir`. Nothing threw - DIR_VEC[-1] falls back
   * to DIR_D - the pirate just walked the wrong way for a tick, occasionally, only while drunk.
   */
  await t.test('a fumbled turn never leaves the pirate facing nowhere', () => {
    const st = room(21, 21);
    const p = spawn(st, 10, 10, { speed: 1 });
    applyStatus(st, p, STATUS.DRUNK, 1e6);
    let seed = 5150;
    for (let n = 0; n < 2000; n++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      step(st, p, (seed >>> 9) & (IN_RIGHT | IN_UP | IN_LEFT | IN_DOWN));
      st.tick++;
      assert.ok(DIRS.includes(p.dir), `tick ${n}: facing ${p.dir}, which is not a direction`);
      assert.ok(p.turnWant === DIR_NONE || DIRS.includes(p.turnWant),
        `tick ${n}: turnWant is ${p.turnWant}`);
    }
  });

  await t.test('rum still costs something: some turns are fumbled', () => {
    // A long corridor with openings above at every other column, so a sober pirate turns at the
    // first one every time and a drunk one sometimes does not.
    const fumbles = drunk => {
      let missed = 0;
      for (let trial = 0; trial < 40; trial++) {
        const st = room(31, 11);
        for (let x = 1; x < 30; x++) setTile(st.map, x, 4, BLOCK.SOFT, 1);
        for (let x = 4; x < 28; x += 2) { setTile(st.map, x, 4, BLOCK.FLOOR); setTile(st.map, x, 3, BLOCK.FLOOR); }
        const p = spawn(st, 2, 5, { speed: 0, seat: trial % 8 });
        if (drunk) applyStatus(st, p, STATUS.DRUNK, 100000);
        st.tick = trial * 17;
        let turnedAt = -1;
        for (let n = 0; n < 60 && turnedAt < 0; n++) {
          step(st, p, IN_RIGHT | IN_UP);
          if (p.dir === DIR_U) turnedAt = p.x >> 8;
        }
        // The first opening is column 4. Turning later means a fumbled turn.
        if (turnedAt < 0 || turnedAt > 4) missed++;
      }
      return missed;
    };
    assert.equal(fumbles(false), 0, 'a sober pirate missed a turn');
    assert.ok(fumbles(true) > 0, 'rum costs nothing at all on rails');
  });
});

test('rails: the seatbelt still works', async t => {
  await t.test('a wall grown on top of a pirate still eases them out', () => {
    const st = room(15, 15);
    const p = spawn(st, 7, 7, { speed: 0 });
    setTile(st.map, 7, 7, BLOCK.SOFT, 1);          // entombed
    let escaped = false;
    for (let n = 0; n < 200 && !escaped; n++) {
      step(st, p, 0);
      escaped = !blocked(st, p, p.x, p.y, false);
    }
    assert.ok(escaped, 'a pirate walled in was left stuck for good');
  });

  await t.test('being eased out still ends on a lane', () => {
    const st = room(15, 15);
    const p = spawn(st, 7, 7, { speed: 0 });
    setTile(st.map, 7, 7, BLOCK.SOFT, 1);
    for (let n = 0; n < 200; n++) {
      step(st, p, 0);
      if (!blocked(st, p, p.x, p.y, false)) break;
    }
    for (let n = 0; n < 40; n++) {
      step(st, p, IN_RIGHT);
      assertOnRail(p, `after unstick, tick ${n}`);
    }
  });

  await t.test('a bomb underfoot can always be walked off', () => {
    const st = room(15, 15);
    const p = spawn(st, 7, 7, { speed: 0 });
    st.bombs.push({
      id: 1, tx: 7, ty: 7, o: 1, owner: 1, r: 1, radius: 1, at: 1e9, fuseTicks: 72,
    });
    for (let n = 0; n < 30; n++) step(st, p, IN_RIGHT);
    assert.ok((p.x >> 8) > 7, `could not walk off a bomb, still at ${p.x >> 8}`);
  });

  await t.test('a bomb in the way is solid, and stops you flush', () => {
    const st = room(15, 15);
    const p = spawn(st, 5, 7, { speed: 0 });
    st.bombs.push({
      id: 1, tx: 8, ty: 7, o: 1, owner: 1, r: 1, radius: 1, at: 1e9, fuseTicks: 72,
    });
    for (let n = 0; n < 60; n++) step(st, p, IN_RIGHT);
    assert.equal(p.x >> 8, 7, `walked through or stopped short of a bomb, at ${p.x >> 8}`);
    const half = HITBOX_UNITS >> 1;
    assert.equal(p.x, tileCentre(8) - HALF - half, `did not come to rest flush against the bomb`);
    assert.ok(!blocked(st, p, p.x, p.y), 'ended up inside the bomb');
  });
});

/* The soak.
 *
 * Everything above tests movement in isolation, on hand-built rooms, with the pieces that touch
 * it stubbed or absent. This runs the WHOLE GAME - every map, a full room of bots, real bombs,
 * real fire, real perks, real wall regrowth, real gulls - and checks the rail invariants on every
 * player on every tick of it.
 *
 * It exists because the rail work turned up four bugs that no targeted test caught, and every one
 * of them needed two systems interacting: a flush stop that let the next tick walk into the wall,
 * a lane snap that only fired after an unstick, a turn that could skip the junction it was
 * waiting for, and a sentinel that collided with DIR_R so right turns silently never happened.
 * Isolated tests are the wrong shape for that class of bug.
 */
test('rails: a full room survives a long soak on every map', () => {
  for (const [mi, map] of MAPS.entries()) {
    const room = createRoom({ countIn: 0, onBroadcast: () => {} });
    try {
      room.setMap(mi);
      room.setBots(12);

      let seed = 90210 + mi;
      const nextMask = () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return (seed >>> 7) & (IN_RIGHT | IN_UP | IN_LEFT | IN_DOWN | IN_BOMB | IN_SLIDE);
      };

      for (let n = 0; n < 2500; n++) {
        // A couple of seats driven by noise on top of the bots, so the stream includes masks no
        // bot would ever produce - opposing keys, a slide into a wall, a bomb mid-turn.
        for (const seat of [0, 1]) room.input(seat, room.state.tick, nextMask());
        room.tick();

        for (const p of room.state.players) {
          if (!p || !p.alive) continue;
          assert.ok(DIRS.includes(p.dir),
            `map${mi} tick ${n}: seat ${p.i} faces ${p.dir}`);
          /* The invariant, with ONE exception that is the seatbelt doing its job: a player a wall
           * has regrown on top of is briefly off both lanes while `unstick` eases them out. That
           * is the definition of being stuck, not a rail failure - what matters is that it ends. */
          if (blocked(room.state, p, p.x, p.y, false)) continue;
          assertOnRail(p, `map${mi} tick ${n}: seat ${p.i}`);
        }
      }

      // And nobody is left permanently entombed at the end of it.
      for (let n = 0; n < 200; n++) room.tick();
      for (const p of room.state.players) {
        if (!p || !p.alive) continue;
        assert.ok(!blocked(room.state, p, p.x, p.y, false),
          `map${mi}: seat ${p.i} is still stuck in a wall after 200 quiet ticks`);
      }
    } finally {
      room.stop();
    }
  }
});

/* Two identical rooms, driven identically, must stay bit-identical.
 *
 * The client runs this same simulation to predict its own movement, so anything that reaches a
 * different answer from the same inputs is a desync by definition. The targeted desync test above
 * compares `step` against `round.tick` on a bare room; this compares two WHOLE rooms, hashed, so
 * it also covers the bombs, the fire, the perks and the regrowth that the rails now share ticks
 * with. A stray `Math.random` anywhere in `shared/sim` fails here and nowhere else.
 */
/* Nothing under shared/sim may reach for Math.random.
 *
 * The client runs this exact code to predict its own movement, so an unseeded roll anywhere in it
 * reaches a different answer on the two machines - which is a desync by construction. The rails
 * added new branches that take decisions (the turn buffer, the drunk fumble), so this is worth
 * stating as a rule rather than as a habit.
 *
 * A whole-room hash comparison was tried instead and cannot work: `room.js` picks respawn
 * positions with Math.random on purpose - the server decides them and ships them in a snapshot -
 * and `buildMap` knocks lattice pillars out from a clock seed, also on purpose. Neither is a
 * desync, because neither is ever recomputed by a client. The line that matters is the one around
 * `shared/sim`, and that is what this guards.
 */
test('rails: the shared simulation never reaches for Math.random', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const dir = new URL('../shared/sim/', import.meta.url);
  const files = (await readdir(dir)).filter(f => f.endsWith('.js'));
  assert.ok(files.length >= 8, `only found ${files.length} files under shared/sim`);

  // Comments are stripped first: state.js says "the sim never calls Math.random()", and a test
  // that fails on its own documentation is a test nobody will trust twice.
  const code = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  const offenders = [];
  for (const f of files) {
    if (/Math\.random/.test(code(await readFile(new URL(f, dir), 'utf8')))) offenders.push(f);
  }
  assert.deepEqual(offenders, [], 'these would desync the client from the server');
});

/* Two bugs reported from live play, both about being pressed up against something.
 *
 * They look unrelated and share a cause: the pirate ends up part-way into a tile they may not
 * enter, and the machinery that is supposed to resolve that argues with itself instead.
 */
test('rails: pressed against things', async t => {
  /* "holding S next to a block jiggles."
   *
   * A turn that cannot be taken must not make the pirate oscillate around the junction. Holding
   * one key across the lane, with the way it points walled off, used to: the pirate glided to
   * the junction, the turn was refused there WITHOUT being dropped, travel carried on through
   * the junction, and the next tick turned them round to come back for it.
   */
  await t.test('holding a direction into a wall does not jiggle', () => {
    for (const [label, mask, wall] of [
      ['down', IN_DOWN, [7, 8]],
      ['up', IN_UP, [7, 6]],
      ['left', IN_LEFT, [6, 7]],
      ['right', IN_RIGHT, [8, 7]],
    ]) {
      const st = room(15, 15);
      setTile(st.map, wall[0], wall[1], BLOCK.SOFT, 1);
      const p = spawn(st, 7, 7, { dir: DIR_R });

      // Settle, then watch: once at rest, nothing may move at all while the key is held.
      for (let n = 0; n < 40; n++) { step(st, p, mask); st.tick++; }
      const at = `${p.x},${p.y}`;
      for (let n = 0; n < 60; n++) {
        step(st, p, mask);
        st.tick++;
        assert.equal(`${p.x},${p.y}`, at,
          `${label}: jiggled to ${p.x},${p.y} from ${at} on tick ${n}`);
      }
    }
  });

  /* "I got stuck in a bomb I had just placed, having clipped a little."
   *
   * Placement is AIMED at the tile in front. Part-way through a tile the hitbox already overlaps
   * that tile, so a bomb dropped there lands partly underneath the pirate - and a bomb is solid
   * to anyone whose 5/8 box is not in it, which from there it is not. Every candidate move is
   * then blocked and the gentle unstick shoves them sideways off their lane, where the lane
   * correction pulls them back in. That is the stuck.
   */
  await t.test('a bomb is never aimed at a tile the pirate is already clipping', () => {
    const st = room(15, 15);
    const p = spawn(st, 5, 7, { dir: DIR_R });
    // Walk forward until the hitbox is clipping the next tile but the centre has not left this one.
    let clipped = false;
    for (let n = 0; n < 20 && !clipped; n++) {
      step(st, p, IN_RIGHT);
      st.tick++;
      // The trap window exactly: the full box reaches tile 6, the five-eighths box does not.
      const full = HITBOX_UNITS >> 1, grace = (full * 5) >> 3;
      clipped = ((p.x + full - 1) >> 8) === 6 && ((p.x + grace - 1) >> 8) === 5;
    }
    assert.ok(clipped, 'never reached the window where a bomb would be solid and underneath us');

    const at = bombTile(st, p);
    assert.deepEqual({ tx: at.tx, ty: at.ty }, { tx: 5, ty: 7 },
      'the bomb was aimed at a tile the pirate is already inside');
  });

  await t.test('placing a bomb while clipping never traps the placer', () => {
    const st = room(15, 15);
    const p = spawn(st, 5, 7, { dir: DIR_R });
    for (let n = 0; n < 20; n++) {
      const full = HITBOX_UNITS >> 1, grace = (full * 5) >> 3;
      if (((p.x + full - 1) >> 8) === 6 && ((p.x + grace - 1) >> 8) === 5) break;
      step(st, p, IN_RIGHT);
      st.tick++;
    }
    // Place, then try to walk away. Backwards is always available: it is where we came from.
    tick(st, [IN_RIGHT | IN_BOMB]);
    assert.equal(st.bombs.length, 1, 'no bomb was placed');
    const from = p.x;
    for (let n = 0; n < 40; n++) tick(st, [IN_LEFT]);
    assert.ok(p.x < from - UNITS_PER_TILE,
      `trapped by their own bomb: moved only ${from - p.x} units in 40 ticks`);
    assert.ok(!blocked(st, p, p.x, p.y), 'left standing inside the bomb');
  });
});

/* The drawn position must settle onto the SIMULATED one, never onto the tile centre.
 *
 * Reported as "holding a key into a block jiggles". The simulation is rock steady there - the
 * tests above prove a pirate pressed against a wall does not move a unit - so the oscillation
 * was in the renderer: `settleToLane` in client/world.js hauled an illegal drawn point back to
 * the centre of its tile, which on rails is 48 units behind where the pirate actually is when
 * flush against a wall. Interpolation pushed forward, the clamp yanked back, every frame.
 *
 * Asserted against the source because world.js imports through the browser's absolute
 * `/shared/...` specifiers and Node cannot resolve them.
 */
test('rails: the drawn position settles onto the simulated one, not the tile centre', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../public/client/world.js', import.meta.url), 'utf8');
  const fn = src.match(/function settleToLane\(p\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(fn, 'settleToLane is no longer recognisable - this test needs updating with it');
  assert.doesNotMatch(fn, /tileCentre/,
    'the drawn position is being pulled to the tile centre, which on rails is not where the pirate is');
  assert.match(fn, /const cx = p\.x, cy = p\.y;/,
    'the drawn position is not easing toward the simulated position');
});
