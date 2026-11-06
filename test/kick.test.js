/* Sliding into a bomb kicks it off the board.
 *
 * It never explodes and it never hurts anybody. The owner's slot is NOT handed straight back -
 * it frees at the tick the original fuse would have ended - and that asymmetry is the whole
 * design: kicking denies the blast, but the bomber is not instantly rearmed, so a kick is a save
 * rather than a free reset for everyone involved.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOCK, IN_RIGHT, IN_LEFT, IN_SLIDE, IN_BOMB, FUSE_TICKS, UNITS_PER_TILE, STAMINA_MAX,
  DIR_R, MAX_BOMBS_CARRIED, KICK_FLIGHT_TICKS, SCORE,
} from '../shared/constants.js';
import { createState, createPlayer, setTile, tileCentre, tileAt } from '../shared/sim/state.js';
import { step } from '../shared/sim/movement.js';
import { place, placeable, detonate } from '../shared/sim/bombs.js';
import { tick } from '../shared/sim/round.js';

/** A long clear room, so a slide has somewhere to go. */
function room(w = 21, h = 9) {
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

/** A bomb on a tile, owned by `owner`, with a full fuse. */
function bombAt(s, tx, ty, owner, { radius = 1 } = {}) {
  const b = {
    id: s.nextBombId++, tx, ty, o: owner, owner,
    r: radius, radius, at: s.tick + FUSE_TICKS, fuseTicks: FUSE_TICKS, streakPowered: false,
  };
  s.bombs.push(b);
  return b;
}

/** Launch a slide to the right and run until it ends (or `cap` ticks pass). */
function slideRight(s, p, cap = 40) {
  tick(s, slideMask(p.i));
  assert.ok(p.slideV > 0, 'the slide never launched');
  for (let n = 0; n < cap && p.slideV > 0; n++) tick(s, []);
}

const slideMask = seat => { const m = []; m[seat] = IN_RIGHT | IN_SLIDE; return m; };

test('kicking a bomb', async t => {
  await t.test('a slide into a bomb takes it off the board', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const victim = spawn(s, 1, 12, 4);          // the owner, well out of the way
    const b = bombAt(s, 6, 4, victim.i);

    slideRight(s, p);
    assert.equal(s.bombs.find(x => x.id === b.id), undefined, 'the bomb is still on the board');
    const ev = s.events.find(e => e.e === 'kick' && e.id === b.id);
    assert.ok(ev, 'no kick event was emitted');
    assert.equal(ev.by, p.i, 'the kick event names the wrong kicker');
  });

  await t.test('a kicked bomb never produces fire, and nobody is hurt', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const owner = spawn(s, 1, 15, 4);
    // Somebody standing exactly where the blast would have reached.
    const bystander = spawn(s, 2, 7, 4);
    bystander.hp = 1;
    bombAt(s, 6, 4, owner.i, { radius: 3 });

    slideRight(s, p);
    for (let n = 0; n < FUSE_TICKS * 2; n++) {
      tick(s, []);
      assert.equal(s.fires.length, 0, `fire appeared on tick ${n} from a kicked bomb`);
    }
    assert.equal(bystander.alive, true, 'a kicked bomb killed somebody');
    assert.equal(owner.alive, true, 'a kicked bomb killed its owner');
  });

  await t.test('a kicked bomb cannot be chained by another blast', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const owner = spawn(s, 1, 16, 4);
    const kicked = bombAt(s, 6, 4, owner.i);
    slideRight(s, p);
    assert.equal(s.bombs.find(x => x.id === kicked.id), undefined);

    // A live bomb right beside where the kicked one was. Its blast must find nothing to chain.
    const live = bombAt(s, 7, 4, owner.i, { radius: 3 });
    live.at = s.tick + 1;
    const before = s.events.length;
    for (let n = 0; n < FUSE_TICKS; n++) tick(s, []);
    const booms = s.events.slice(before).filter(e => e.e === 'boom').map(e => e.id);
    assert.ok(!booms.includes(kicked.id), 'a kicked bomb was detonated by a chain');
  });

  await t.test("the owner's slot frees at the original fuse, not on the kick", () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const owner = spawn(s, 1, 14, 4);
    owner.bombs = 1;                            // exactly one slot, and it is spent
    const b = bombAt(s, 6, 4, owner.i);
    const freesAt = b.at;

    slideRight(s, p);
    assert.ok(s.tick < freesAt, 'the test needs the kick to land before the fuse would have');
    assert.equal(placeable(s, owner), null,
      'the kick handed the bomber their slot straight back');

    while (s.tick < freesAt) tick(s, []);
    tick(s, []);
    assert.ok(placeable(s, owner), 'the slot never came back after the original fuse');
  });

  await t.test('the kicked tile stops being solid at once', () => {
    // A slide covers about 3.2 tiles, so the bomb goes two out and the slide has room to carry
    // on past it. Stopping ON the cleared square is the failure this is looking for.
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const owner = spawn(s, 1, 15, 4);
    bombAt(s, 5, 4, owner.i);

    tick(s, slideMask(p.i));
    let crossed = false;
    for (let n = 0; n < 40 && !crossed; n++) {
      tick(s, []);
      if ((p.x >> 8) > 5) crossed = true;
    }
    assert.ok(crossed, 'the slide stopped dead on the square it had just cleared');
  });

  await t.test('no score, no kill, no stat for a kick', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const owner = spawn(s, 1, 15, 4);
    bombAt(s, 6, 4, owner.i);
    const score = p.score, kills = p.kills;

    slideRight(s, p);
    assert.equal(p.score, score, 'a kick awarded score');
    assert.equal(p.kills, kills, 'a kick awarded a kill');
  });

  await t.test('walking into a bomb does not kick it - only a slide does', () => {
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const owner = spawn(s, 1, 15, 4);
    const b = bombAt(s, 6, 4, owner.i);

    const held = []; held[p.i] = IN_RIGHT;
    for (let n = 0; n < 60; n++) tick(s, held);
    assert.ok(s.bombs.find(x => x.id === b.id), 'walking into a bomb kicked it');
    assert.equal(p.x >> 8, 5, 'the walker did not stop against the bomb');
  });

  await t.test('your own bomb is kickable too', () => {
    // No ownership rule: a slide is a slide. Kicking your own bomb away from somebody is a
    // perfectly good thing to want, and an ownership exception would be a rule to memorise.
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const b = bombAt(s, 6, 4, p.i);
    slideRight(s, p);
    assert.equal(s.bombs.find(x => x.id === b.id), undefined, 'could not kick my own bomb');
  });

  await t.test('a death bomb is kickable like any other', () => {
    // Task 7 leaves a live bomb where a player died, owned by them. Nothing about it is special.
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const dead = spawn(s, 1, 16, 4);
    dead.alive = false;
    const b = bombAt(s, 6, 4, dead.i);
    slideRight(s, p);
    assert.equal(s.bombs.find(x => x.id === b.id), undefined, 'a death bomb refused a kick');
  });

  await t.test('two bombs in a row are both kicked by one slide', () => {
    const s = room();
    const p = spawn(s, 0, 2, 4);
    const owner = spawn(s, 1, 18, 4);
    // Both inside one slide's reach of about 3.2 tiles from column 2.
    const a = bombAt(s, 4, 4, owner.i);
    const b = bombAt(s, 5, 4, owner.i);
    slideRight(s, p, 60);
    assert.equal(s.bombs.find(x => x.id === a.id), undefined, 'the first bomb survived');
    assert.equal(s.bombs.find(x => x.id === b.id), undefined, 'the second bomb survived');
  });

  await t.test('a bomb placed and kicked on the same tick resolves one way or the other', () => {
    /* Review Focus 2. Movement (and the kick with it) runs BEFORE placement in the tick order,
     * so on the tick a slide crosses the tile, either the bomb is not there yet and is placed
     * normally, or it is there and is kicked. What must not exist is a half state: a bomb that
     * was kicked and also lit, or one counted against its owner twice. */
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const owner = spawn(s, 1, 6, 4);
    owner.dir = DIR_R;

    tick(s, slideMask(p.i));
    for (let n = 0; n < 40 && p.slideV > 0; n++) {
      const held = [];
      held[owner.i] = IN_BOMB;                  // hammering the bomb key the whole way through
      tick(s, held);
      for (const b of s.bombs) {
        assert.ok(!b.kicked, 'a kicked bomb is still in the live bomb list');
      }
    }
    // Whatever happened, the simulation is coherent: no bomb is in two states at once.
    const ids = s.bombs.map(b => b.id);
    assert.equal(new Set(ids).size, ids.length, 'the same bomb is on the board twice');
  });

  await t.test('the flight is short, and is a client-side flourish only', () => {
    assert.ok(KICK_FLIGHT_TICKS > 0 && KICK_FLIGHT_TICKS <= 20,
      `a kick flight of ${KICK_FLIGHT_TICKS} ticks is not "about half a second"`);
    const s = room();
    const p = spawn(s, 0, 3, 4);
    const owner = spawn(s, 1, 15, 4);
    bombAt(s, 6, 4, owner.i);
    slideRight(s, p);
    // The simulation is done with it immediately: nothing lingers in the bomb list for the
    // animation's benefit, because a bomb that is still there is a bomb that can still chain.
    assert.equal(s.bombs.length, 0, 'the kicked bomb lingered in the simulation for the flight');
  });
});

test('the kick is authoritative, and the client never predicts one', async () => {
  const { readFile } = await import('node:fs/promises');
  const main = await readFile(new URL('../public/client/main.js', import.meta.url), 'utf8');
  const world = await readFile(new URL('../public/client/world.js', import.meta.url), 'utf8');
  const render = await readFile(new URL('../public/client/render.js', import.meta.url), 'utf8');

  assert.match(main, /case 'kick'/, 'the client ignores the kick event');
  assert.match(render, /addKick/, 'the renderer has no kick flourish');

  /* The kicked bomb has to be dropped from the client's own bomb list AND marked burst.
   *
   * The local fuse loop bursts anything whose tick has arrived. A snapshot already in flight when
   * the kick landed still carries the bomb, so without the burst mark the client would re-add it
   * and then light it locally for a blast the server is never going to send - fire on one screen
   * and not the others, which is the worst shape a desync can take. */
  const removeBomb = world.match(/w\.removeBomb = [\s\S]*?\n  \};/)?.[0];
  assert.ok(removeBomb, 'there is no removeBomb');
  assert.match(removeBomb, /w\.burst\.add/, 'a kicked bomb can still be lit by the local fuse loop');
  assert.match(removeBomb, /splice/, 'a kicked bomb is never dropped from the bomb list');
});
