import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESPAWN_COUNTDOWN_TICKS, RESPAWN_DELAY_TICKS, TICK_HZ,
} from '../shared/constants.js';
import { createRoom } from '../server/room.js';
import { IN_BOMB } from '../shared/constants.js';

function room() {
  return createRoom({ countIn: 0, onBroadcast: () => {} });
}

test('death cooldown is 5 seconds and each countdown digit lasts one second', () => {
  assert.equal(RESPAWN_DELAY_TICKS, 5 * TICK_HZ);
  assert.equal(RESPAWN_COUNTDOWN_TICKS, 3 * TICK_HZ);
  assert.equal(RESPAWN_COUNTDOWN_TICKS / 3, TICK_HZ);
});

/* The countdown is drawn over the TAIL of the wait, so it has to be strictly shorter than it.
 *
 * At eleven seconds this had eight seconds of slack and nobody had to think about it. At five it
 * has two, which is little enough that the next tuning pass could cross them - and a countdown
 * longer than the wait it counts down would start before the player was allowed to ask. */
test('the countdown still fits inside the wait', () => {
  assert.ok(RESPAWN_COUNTDOWN_TICKS < RESPAWN_DELAY_TICKS,
    `a ${RESPAWN_COUNTDOWN_TICKS}-tick countdown does not fit in a ${RESPAWN_DELAY_TICKS}-tick wait`);
});

test('a respawn request counts down 3, 2, 1 before spawning', () => {
  const r = room();
  try {
    const { seat } = r.join('first-id', 'first');
    const p = r.state.players[seat];
    r.requestRespawn(seat);

    assert.equal(p.alive, false);
    assert.equal(p.respawnRequested, true);
    assert.equal(p.respawnAt, r.state.tick + RESPAWN_COUNTDOWN_TICKS);
    const wire = r.welcomeFor(seat).players.find(player => player.i === seat);
    assert.equal(wire.rr, RESPAWN_COUNTDOWN_TICKS);

    for (let i = 0; i < RESPAWN_COUNTDOWN_TICKS; i++) r.tick();
    assert.equal(p.alive, false, 'spawned before the countdown ended');
    r.tick();
    assert.equal(p.alive, true, 'did not spawn when the countdown ended');
    assert.equal(p.respawnRequested, false);
  } finally { r.stop(); }
});

test('a respawn request cannot skip the death cooldown', () => {
  const r = room();
  try {
    const { seat } = r.join('first-id', 'first');
    const p = r.state.players[seat];
    r.requestRespawn(seat);
    for (let i = 0; i <= RESPAWN_COUNTDOWN_TICKS; i++) r.tick();

    p.alive = false;
    p.deaths = 1;
    p.respawnAt = r.state.tick + RESPAWN_DELAY_TICKS;
    const cooldownEndsAt = p.respawnAt;

    r.requestRespawn(seat);
    assert.equal(p.respawnRequested, false);
    assert.equal(p.respawnAt, cooldownEndsAt);

    for (let i = 0; i < RESPAWN_DELAY_TICKS; i++) r.tick();
    r.requestRespawn(seat);
    assert.equal(p.respawnRequested, true);
    assert.equal(p.respawnAt, r.state.tick + RESPAWN_COUNTDOWN_TICKS);
  } finally { r.stop(); }
});

test('holding the bomb key cannot bypass the post-click countdown', () => {
  const r = room();
  try {
    const { seat } = r.join('first-id', 'first');
    const p = r.state.players[seat];
    r.requestRespawn(seat);
    for (let i = 0; i <= RESPAWN_COUNTDOWN_TICKS; i++) r.tick();

    p.alive = false;
    p.deaths = 1;
    p.respawnAt = r.state.tick + RESPAWN_DELAY_TICKS;
    for (let i = 0; i <= RESPAWN_DELAY_TICKS; i++) {
      r.input(seat, r.state.tick, IN_BOMB);
      r.tick();
    }

    assert.equal(p.alive, false, 'the input path spawned without its countdown');
    assert.equal(p.respawnRequested, true);
    assert.equal(p.respawnAt, r.state.tick - 1 + RESPAWN_COUNTDOWN_TICKS);
  } finally { r.stop(); }
});
