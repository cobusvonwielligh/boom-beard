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

test('a player present during count-in spawns with the round at the start tick', () => {
  const r = createRoom({
    countIn: COUNT_IN_TICKS,
    arriveIn: ARRIVE_DELAY_TICKS,
    onBroadcast: () => {},
  });
  try {
    const { seat } = r.join('a', 'alice');
    const p = r.state.players[seat];
    assert.equal(p.alive, false);
    assert.equal(p.arriveAt, COUNT_IN_TICKS);

    for (let i = 0; i < COUNT_IN_TICKS - 1; i++) r.tick();
    assert.equal(p.alive, false, 'spawned before the shared count-in ended');
    r.tick();
    r.tick();
    assert.equal(p.alive, true, 'did not spawn with the round start');
    assert.ok(r.state.events.some(event => event.e === 'spawn' && event.i === seat
      && event.tick === COUNT_IN_TICKS), 'spawn animation event was not synchronized to round start');
  } finally { r.stop(); }
});

test('a player joining before the count-in finishes spawns at the shared start', () => {
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
    assert.equal(p.arriveAt, COUNT_IN_TICKS);

    r.tick();
    r.tick();
    assert.equal(p.alive, true, 'received an extra private delay despite joining during count-in');
  } finally { r.stop(); }
});

test('a player joining after count-in gets a private three-second arrival timer', () => {
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
    const joinedAt = r.state.tick;
    const { seat } = r.join('a', 'alice');
    const p = r.state.players[seat];
    assert.equal(p.alive, false);
    assert.equal(p.arriveAt, joinedAt + ARRIVE_DELAY_TICKS);

    for (let i = 0; i < ARRIVE_DELAY_TICKS - 1; i++) r.tick();
    assert.equal(p.alive, false, 'spawned before the private timer ended');
    assert.ok(snapshots.some(snap => snap.players.find(player => player.i === seat)?.art === p.arriveAt),
      'private arrival deadline was not sent for the countdown');

    r.tick();
    r.tick();
    assert.equal(p.alive, true, 'did not spawn when the private timer ended');
  } finally { r.stop(); }
});

test('a new player is arriving, not dead, until the delay is up - then placed with a spawn', () => {
  const { r, snaps } = room();
  try {
    const { seat } = r.join('a', 'alice');
    const p = r.state.players[seat];
    assert.equal(p.alive, false);
    assert.equal(p.arriving, true);
    assert.equal(p.deaths, 0, 'arriving counted as a death');
    r.tick(); r.tick();
    assert.equal(snaps.at(-1).players.find(q => q.i === seat).ar, 1, 'arriving never reached the wire');
    // Pressing respawn cannot jump the queue.
    r.requestRespawn(seat);
    assert.equal(p.alive, false, 'the respawn key placed an arriving player early');
    for (let i = 0; i < ARRIVE_DELAY_TICKS; i++) r.tick();
    assert.equal(p.alive, true, 'never placed');
    assert.equal(p.arriving, false);
    r.tick(); r.tick();
    const wire = snaps.at(-1).players.find(q => q.i === seat);
    assert.equal(wire.ar, undefined);
    assert.ok(snaps.some(s => s.ev.some(e => e.e === 'spawn' && e.i === seat)), 'no spawn event to show the arrival');
  } finally { r.stop(); }
});

test('rejoining while alive lifts you off and places you again after the delay', () => {
  const { r } = room();
  try {
    const { seat } = r.join('a', 'alice');
    for (let i = 0; i <= ARRIVE_DELAY_TICKS; i++) r.tick();
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
    for (let i = 0; i <= ARRIVE_DELAY_TICKS; i++) r.tick();
    const p = r.state.players[seat];
    p.alive = false; p.respawnAt = r.state.tick + 9999;
    r.disconnect(seat);
    r.join('a', 'alice');
    assert.equal(p.arriving ?? false, false);
    for (let i = 0; i <= ARRIVE_DELAY_TICKS; i++) r.tick();
    assert.equal(p.alive, false, 'a dead rejoin was respawned for free');
  } finally { r.stop(); }
});
