// Joining or rejoining: held off the board for ARRIVE_DELAY_TICKS, then placed. See holdArrival.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../server/room.js';
import {
  ARRIVE_DELAY_TICKS, COUNT_IN_TICKS, STATUS, TICK_HZ,
} from '../shared/constants.js';

const RESPAWN_COUNTDOWN_TICKS = 3 * TICK_HZ;

function room() {
  const snaps = [];
  const r = createRoom({ countIn: 0, arriveIn: ARRIVE_DELAY_TICKS,
    onBroadcast: m => { const x = typeof m === 'function' ? m(0) : m; if (x.t === 'snap') snaps.push(x); } });
  return { r, snaps };
}

function roomWithLeaderboard() {
  const pending = { bombs: 0, fire: 0, speed: 0, shield: 0, stim: 0 };
  const leaderboard = {
    consumePending: () => ({ ...pending }),
    record: () => {},
    flush: () => {},
    top: () => [],
    get: () => null,
    economy: () => ({ wallet: 0 }),
    award: () => {},
    buy: () => ({ ok: false }),
  };
  return createRoom({
    countIn: 0,
    arriveIn: ARRIVE_DELAY_TICKS,
    leaderboard,
    onBroadcast: () => {},
  });
}

test('the delay is three seconds', () => {
  assert.equal(ARRIVE_DELAY_TICKS, 3 * TICK_HZ);
});

test('a player present during count-in can request a first spawn at the shared start tick', () => {
  const r = createRoom({
    countIn: COUNT_IN_TICKS,
    arriveIn: ARRIVE_DELAY_TICKS,
    onBroadcast: () => {},
  });
  try {
    const { seat } = r.join('a', 'alice');
    const p = r.state.players[seat];
    assert.equal(p.alive, false);
    assert.equal(p.arriving, undefined);
    assert.equal(p.deaths, 0);

    r.requestRespawn(seat);
    for (let i = 0; i < COUNT_IN_TICKS - 1; i++) r.tick();
    assert.equal(p.alive, false, 'spawned before the shared count-in ended');
    r.tick();
    r.tick();
    assert.equal(p.alive, true, 'the requested spawn did not happen at the round start');
    assert.ok(r.state.events.some(event => event.e === 'spawn' && event.i === seat
      && event.tick === COUNT_IN_TICKS), 'spawn animation event was not synchronized to round start');
  } finally { r.stop(); }
});

test('a player joining before the count-in sees the shop before choosing to spawn', () => {
  const r = createRoom({
    countIn: COUNT_IN_TICKS,
    arriveIn: ARRIVE_DELAY_TICKS,
    onBroadcast: () => {},
  });
  try {
    for (let i = 0; i < COUNT_IN_TICKS - 1; i++) r.tick();
    const { seat } = r.join('a', 'alice');
    const p = r.state.players[seat];
    assert.equal(p.alive, false);
    assert.equal(p.deaths, 0);
    assert.equal(p.arriving, undefined);

    assert.equal(p.alive, false, 'spawned before the shared count-in ended');
    r.requestRespawn(seat);
    assert.equal(p.respawnRequested, true);
    for (let i = 0; i < COUNT_IN_TICKS + 2; i++) r.tick();
    assert.equal(p.alive, true, 'the requested spawn did not happen after count-in');
  } finally { r.stop(); }
});

test('a player joining after count-in spawns after the request countdown', () => {
  const snapshots = [];
  const r = createRoom({
    countIn: 2,
    arriveIn: ARRIVE_DELAY_TICKS,
    onBroadcast: message => {
      const payload = typeof message === 'function' ? message(0) : message;
      if (payload.t === 'snap') snapshots.push(payload);
    },
  });
  try {
    for (let i = 0; i < 3; i++) r.tick();
    const { seat } = r.join('a', 'alice');
    const p = r.state.players[seat];
    assert.equal(p.alive, false);
    assert.equal(p.deaths, 0);
    assert.equal(p.arriving, undefined);
    r.tick();
    r.tick();
    const wire = snapshots.at(-1).players.find(player => player.i === seat);
    assert.equal(wire.st, 0, 'the first-spawn dialog state was not sent');
    assert.equal(wire.dd, 0, 'first spawn was counted as a death');
    assert.equal(wire.ar, undefined, 'the player was treated as an arrival instead of dead');
    r.requestRespawn(seat);
    assert.equal(p.alive, false, 'the post-click countdown was skipped');
    for (let i = 0; i <= RESPAWN_COUNTDOWN_TICKS; i++) r.tick();
    assert.equal(p.alive, true, 'the first spawn did not happen after its countdown');
  } finally { r.stop(); }
});

test('a new player waits in the shop and can respawn without a death cooldown', () => {
  const { r, snaps } = room();
  try {
    const { seat } = r.join('a', 'alice');
    const p = r.state.players[seat];
    assert.equal(p.alive, false);
    assert.equal(p.arriving, undefined);
    assert.equal(p.deaths, 0, 'first spawn was counted as a death');
    r.tick();
    r.tick();
    const wire = snaps.at(-1).players.find(q => q.i === seat);
    assert.equal(wire.st, 0, 'the dead state was not sent for the shop dialog');
    assert.equal(wire.dd, 0);
    assert.equal(wire.ar, undefined);
    r.requestRespawn(seat);
    assert.equal(p.alive, false, 'the countdown was skipped after the click');
    for (let i = 0; i <= RESPAWN_COUNTDOWN_TICKS; i++) r.tick();
    assert.equal(p.alive, true, 'the first spawn did not happen after its countdown');
    assert.ok(p.status & STATUS.INVULN, 'the normal spawn protection was not applied');
    r.tick(); r.tick();
    assert.ok(snaps.some(s => s.ev.some(e => e.e === 'spawn' && e.i === seat)), 'no spawn event to show the arrival');
  } finally { r.stop(); }
});

test('rejoining while alive lifts you off and places you again after the delay', () => {
  const { r } = room();
  try {
    const { seat } = r.join('a', 'alice');
    r.requestRespawn(seat);
    for (let i = 0; i <= RESPAWN_COUNTDOWN_TICKS; i++) r.tick();
    const p = r.state.players[seat];
    assert.equal(p.alive, true);
    r.disconnect(seat);
    r.tick();
    r.join('a', 'alice');
    assert.equal(p.alive, false);
    assert.equal(p.arriving, true);
    for (let i = 0; i <= ARRIVE_DELAY_TICKS; i++) r.tick();
    assert.equal(p.alive, true);
  } finally { r.stop(); }
});

test('a same-round reconnect restores pre-leave powerup stats and score, but not temporary statuses', () => {
  const r = roomWithLeaderboard();
  try {
    const { seat } = r.join('a', 'alice');
    r.requestRespawn(seat);
    for (let i = 0; i <= RESPAWN_COUNTDOWN_TICKS; i++) r.tick();

    const p = r.state.players[seat];
    Object.assign(p, {
      bombs: 4, radius: 5, speed: 3, shields: 2,
      staminaLevel: 2, stamina: 1000, tired: true, score: 987,
    });
    p.status |= STATUS.DRUNK | STATUS.INVISIBLE;
    p.statusUntil[STATUS.DRUNK] = r.state.tick + 500;
    p.statusUntil[STATUS.INVISIBLE] = r.state.tick + 600;

    r.disconnect(seat);
    assert.equal(r.join('a', 'alice').resumed, true);
    for (let i = 0; i <= ARRIVE_DELAY_TICKS; i++) r.tick();

    assert.deepEqual({
      bombs: p.bombs, radius: p.radius, speed: p.speed, shields: p.shields,
      staminaLevel: p.staminaLevel, score: p.score,
    }, {
      bombs: 4, radius: 5, speed: 3, shields: 2,
      staminaLevel: 2, score: 987,
    });
    assert.ok(p.stamina >= 1000 && p.stamina < 2300);
    assert.equal(p.tired, true);
    assert.equal(p.status & (STATUS.DRUNK | STATUS.INVISIBLE), 0);
  } finally { r.stop(); }
});

test('reconnect does not restore pre-leave powerups after an offline death', () => {
  const r = roomWithLeaderboard();
  try {
    const { seat } = r.join('a', 'alice');
    r.requestRespawn(seat);
    for (let i = 0; i <= RESPAWN_COUNTDOWN_TICKS; i++) r.tick();

    const p = r.state.players[seat];
    p.speed = 3;
    r.disconnect(seat);
    p.deaths++;
    p.speed = 0;
    p.alive = false;
    assert.equal(r.join('a', 'alice').resumed, true);
    r.requestRespawn(seat);
    for (let i = 0; i <= RESPAWN_COUNTDOWN_TICKS; i++) r.tick();

    assert.equal(p.speed, 0);
  } finally { r.stop(); }
});

test('a new round clears a disconnected player’s saved loadout', () => {
  const r = roomWithLeaderboard();
  try {
    const { seat } = r.join('a', 'alice');
    r.requestRespawn(seat);
    for (let i = 0; i <= RESPAWN_COUNTDOWN_TICKS; i++) r.tick();
    r.state.players[seat].speed = 3;
    r.disconnect(seat);

    r.restartRound();
    assert.equal(r.state.players[seat].speed, 0);
    assert.equal(r.join('a', 'alice').resumed, true);
    for (let i = 0; i <= ARRIVE_DELAY_TICKS; i++) r.tick();
    assert.equal(r.state.players[seat].speed, 0);
  } finally { r.stop(); }
});

test('rejoining while dead stays dead - no free respawn', () => {
  const { r } = room();
  try {
    const { seat } = r.join('a', 'alice');
    r.requestRespawn(seat);
    for (let i = 0; i <= RESPAWN_COUNTDOWN_TICKS; i++) r.tick();
    const p = r.state.players[seat];
    p.alive = false; p.respawnAt = r.state.tick + 9999;
    r.disconnect(seat);
    r.join('a', 'alice');
    assert.equal(p.arriving ?? false, false);
    for (let i = 0; i <= ARRIVE_DELAY_TICKS; i++) r.tick();
    assert.equal(p.alive, false, 'a dead rejoin was respawned for free');
  } finally { r.stop(); }
});
