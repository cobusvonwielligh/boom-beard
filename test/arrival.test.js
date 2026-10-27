// Joining or rejoining: held off the board for ARRIVE_DELAY_TICKS, then placed. See holdArrival.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../server/room.js';
import { ARRIVE_DELAY_TICKS, COUNT_IN_TICKS, TICK_HZ } from '../shared/constants.js';

function room() {
  const snaps = [];
  const r = createRoom({ countIn: 0, arriveIn: ARRIVE_DELAY_TICKS,
    onBroadcast: m => { const x = typeof m === 'function' ? m(0) : m; if (x.t === 'snap') snaps.push(x); } });
  return { r, snaps };
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

    r.requestRespawn(seat);
    assert.equal(p.alive, false, 'spawned before the shared count-in ended');
    for (let i = 0; i < COUNT_IN_TICKS + 2; i++) r.tick();
    assert.equal(p.alive, true, 'the requested spawn did not happen after count-in');
  } finally { r.stop(); }
});

test('a player joining after count-in can spawn immediately when requested', () => {
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
    assert.equal(p.alive, true, 'the first spawn incorrectly had an arrival or death delay');
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
    assert.equal(p.alive, true, 'the first spawn waited for a death cooldown');
    r.tick(); r.tick();
    assert.ok(snaps.some(s => s.ev.some(e => e.e === 'spawn' && e.i === seat)), 'no spawn event to show the arrival');
  } finally { r.stop(); }
});

test('rejoining while alive lifts you off and places you again after the delay', () => {
  const { r } = room();
  try {
    const { seat } = r.join('a', 'alice');
    r.requestRespawn(seat);
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

test('rejoining while dead stays dead - no free respawn', () => {
  const { r } = room();
  try {
    const { seat } = r.join('a', 'alice');
    r.requestRespawn(seat);
    const p = r.state.players[seat];
    p.alive = false; p.respawnAt = r.state.tick + 9999;
    r.disconnect(seat);
    r.join('a', 'alice');
    assert.equal(p.arriving ?? false, false);
    for (let i = 0; i <= ARRIVE_DELAY_TICKS; i++) r.tick();
    assert.equal(p.alive, false, 'a dead rejoin was respawned for free');
  } finally { r.stop(); }
});
