import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESPAWN_DELAY_TICKS, TICK_HZ,
} from '../shared/constants.js';
import { createRoom } from '../server/room.js';
import { IN_BOMB } from '../shared/constants.js';

const RESPAWN_COUNTDOWN_TICKS = Math.round(4.5 * TICK_HZ);

function room() {
  return createRoom({ countIn: 0, onBroadcast: () => {} });
}

test('death cooldown is 11 seconds and the post-click countdown is 4.5 seconds', () => {
  assert.equal(RESPAWN_DELAY_TICKS, 11 * TICK_HZ);
  assert.equal(RESPAWN_COUNTDOWN_TICKS, 4.5 * TICK_HZ);
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
