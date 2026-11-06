// Shields, then health, then your life. See killInFire, SHIELD_GRACE_TICKS and MAX_HP.
//
// Every blast that catches you costs one: a shield if you have one, otherwise half your health,
// and the hit after that kills. Blasts that land on the SAME tick - a chain whose flames cross on
// you - are each paid for. Anything arriving after that tick, inside the grace, is shrugged off.
//
// These tests once asserted that two same-tick blasts cost ONE shield. That was changed on
// purpose when health arrived: it made a crossfire the safest place to stand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRE_TICKS, SHIELD_GRACE_TICKS, BLOCK, MAX_HP, MAX_RADIUS, MAX_SKATES,
  START_RADIUS, STAMINA_MAX, staminaMaxFor,
} from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';
import { createState, createPlayer, tileCentre, tileAt } from '../shared/sim/state.js';
import { tick } from '../shared/sim/round.js';

function arena({ shields, hp = MAX_HP, seed }) {
  // `seed` varies the simulation PRNG, which is what decides how much of the loadout survives a
  // death - see keepOnDeath. Absent means the map's own seed, as every other test here wants.
  const s = createState(seed === undefined ? MAPS[0] : { ...MAPS[0], seed: MAPS[0].seed + seed });
  let at = null;
  for (let ty = 1; ty < s.map.h - 1 && !at; ty++) {
    for (let tx = 1; tx < s.map.w - 1; tx++) if (tileAt(s.map, tx, ty) === BLOCK.FLOOR) { at = { tx, ty }; break; }
  }
  const p = createPlayer(0, 'you');
  p.alive = true; p.x = tileCentre(at.tx); p.y = tileCentre(at.ty); p.shields = shields; p.hp = hp;
  s.players[0] = p;
  for (const n of [5, 6]) { const q = createPlayer(n, `p${n}`); s.players[n] = q; }
  const blast = (src, owner, streakPowered = false) =>
    s.fires.push({
      tx: at.tx, ty: at.ty, kind: 'arm', rot: 0, until: s.tick + FIRE_TICKS, owner, src, streakPowered,
    });
  const step = () => tick(s, new Array(16).fill(0));
  const wait = () => { for (let i = 0; i < SHIELD_GRACE_TICKS; i++) step(); };
  return { s, p, blast, step, wait };
}

test('everybody starts whole', () => {
  assert.equal(createPlayer(0, 'x').hp, MAX_HP);
  assert.equal(MAX_HP, 2);
});

test('one hit with no shield takes half, and the next one kills', () => {
  const { s, p, blast, step, wait } = arena({ shields: 0 });
  blast(101, 5);
  step();
  assert.equal(p.alive, true, 'one hit killed a whole pirate');
  assert.equal(p.hp, 1);
  assert.ok(s.events.some(e => e.e === 'hurt' && e.i === 0 && e.hp === 1 && e.by === 5));
  wait();
  blast(102, 6);
  step();
  assert.equal(p.alive, false, 'the second hit did not kill');
  assert.equal(s.events.find(e => e.e === 'died').by, 6);
});

test('two blasts crossing on the same tick cost two shields', () => {
  const { p, blast, step } = arena({ shields: 2 });
  blast(101, 5); blast(102, 6);
  step();
  assert.equal(p.alive, true);
  assert.equal(p.shields, 0, 'a crossfire only took one shield');
  assert.equal(p.hp, MAX_HP, 'health went before the shields');
});

test('two blasts crossing on the same tick cost a shield and a half', () => {
  const { p, blast, step } = arena({ shields: 1 });
  blast(101, 5); blast(102, 6);
  step();
  assert.equal(p.alive, true);
  assert.equal(p.shields, 0);
  assert.equal(p.hp, 1);
});

test('streak-powered blast costs two shield-first damage units', () => {
  const { p, blast, step } = arena({ shields: 1 });
  blast(101, 5, true);
  step();

  assert.equal(p.alive, true);
  assert.equal(p.shields, 0);
  assert.equal(p.hp, 1);
});

test('two-unit streak damage can kill and retains the blast owner', () => {
  const { s, p, blast, step } = arena({ shields: 0 });
  blast(101, 5, true);
  step();

  assert.equal(p.alive, false);
  assert.equal(s.events.find(e => e.e === 'died').by, 5);
});

test('two blasts crossing on the same tick take both halves, and the second gets the kill', () => {
  const { s, p, blast, step } = arena({ shields: 0 });
  blast(101, 5); blast(102, 6);
  step();
  assert.equal(p.alive, false, 'a crossfire only took half');
  assert.equal(s.events.find(e => e.e === 'died').by, 6, 'the kill went to the wrong blast');
});

test('a crossfire cannot come back for more once the grace runs out', () => {
  const { p, blast, step } = arena({ shields: 2 });
  blast(101, 5); blast(102, 6);
  step();
  // Both blasts are already paid for, so the far side of the grace window must not re-charge
  // for fire that has been burning the whole time.
  for (let i = 0; i < SHIELD_GRACE_TICKS + 4; i++) step();
  assert.equal(p.hp, MAX_HP, 'the same two blasts came back for health');
  assert.equal(p.alive, true);
});

test('a blast inside the grace is shrugged off; one after it is not', () => {
  const { p, blast, step } = arena({ shields: 2 });
  blast(101, 5);
  step();
  assert.equal(p.shields, 1, 'the first blast did not cost a shield');

  blast(102, 6);
  step();
  assert.equal(p.shields, 1, 'a blast inside the grace window took a shield');

  for (let i = 0; i < SHIELD_GRACE_TICKS; i++) step();
  blast(103, 6);
  step();
  assert.equal(p.shields, 0, 'a blast after the grace was swallowed');
  assert.equal(p.alive, true);
});

test('one blast never charges twice', () => {
  const { p, blast, step } = arena({ shields: 1 });
  blast(101, 5);
  for (let i = 0; i < SHIELD_GRACE_TICKS + 4; i++) step();
  assert.equal(p.shields, 0);
  assert.equal(p.hp, MAX_HP, 'one blast charged a shield and then health');
});

test('shields go first whatever the health: a shield at half health saves the last half', () => {
  const { p, blast, step } = arena({ shields: 1, hp: 1 });
  blast(101, 5);
  step();
  assert.equal(p.alive, true);
  assert.equal(p.shields, 0);
  assert.equal(p.hp, 1);
});

test('shield, then half, then dead - one bomb at a time', () => {
  const { p, blast, step, wait } = arena({ shields: 1 });
  blast(101, 5); step();
  assert.deepEqual([p.shields, p.hp, p.alive], [0, MAX_HP, true]);
  wait();
  blast(102, 6); step();
  assert.deepEqual([p.shields, p.hp, p.alive], [0, 1, true]);
  wait();
  blast(103, 6); step();
  assert.equal(p.alive, false, 'the grace outlived the hit that bought it');
});

/* Death keeps about half your upgrades now, and loses the rest - see keepOnDeath in sim/perks.js.
 *
 * So the assertion is a RANGE on the two that can survive and an exact zero on the three that
 * cannot. Shields, stim levels and the stamina bar are still a clean wipe: a shield that survives
 * the death it failed to prevent has done its job twice, and the stim is a starting-life upgrade
 * rather than something you are carrying. */
test('death keeps some of the loadout and wipes shields, stim and the bar', () => {
  const { p, blast, step } = arena({ shields: 0, hp: 1 });
  p.speed = MAX_SKATES;
  p.radius = MAX_RADIUS;
  p.staminaLevel = 2;
  p.stamina = staminaMaxFor(p);
  blast(104, 5);
  step();

  assert.equal(p.alive, false);
  assert.deepEqual([p.shields, p.staminaLevel], [0, 0]);
  assert.equal(p.stamina, STAMINA_MAX);
  assert.ok(p.radius >= START_RADIUS && p.radius <= MAX_RADIUS,
    `kept ${p.radius} fire, which is outside [${START_RADIUS}, ${MAX_RADIUS}]`);
  assert.ok(p.speed >= 0 && p.speed <= MAX_SKATES,
    `kept ${p.speed} skates, which is outside [0, ${MAX_SKATES}]`);
});

/* Half, over enough deaths to be sure it is a coin and not a constant.
 *
 * The distribution is the point: per POINT rather than per kind, so a player with five fire
 * usually comes back with two or three. A test that only checked the bounds would pass just as
 * well if nothing were ever kept, which is the bug worth catching here. */
test('about half of what you were carrying survives a death', () => {
  let kept = 0, carried = 0, allKept = 0, allLost = 0;
  for (let n = 0; n < 200; n++) {
    const { p, blast, step } = arena({ shields: 0, hp: 1, seed: n });
    p.speed = MAX_SKATES;
    p.radius = START_RADIUS + 4;
    blast(104, 5);
    step();
    const had = 4 + MAX_SKATES;
    const got = (p.radius - START_RADIUS) + p.speed;
    kept += got; carried += had;
    if (got === had) allKept++;
    if (got === 0) allLost++;
  }
  const share = kept / carried;
  assert.ok(share > 0.4 && share < 0.6, `kept ${(share * 100).toFixed(0)}% of the loadout`);
  assert.ok(allKept < 40 && allLost < 40,
    `${allKept} deaths kept everything and ${allLost} kept nothing - this is not a per-point roll`);
});
