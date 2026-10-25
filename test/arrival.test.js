// Joining or rejoining: held off the board for ARRIVE_DELAY_TICKS, then placed. See holdArrival.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../server/room.js';
import { ARRIVE_DELAY_TICKS, TICK_HZ } from '../shared/constants.js';

function room() {
  const snaps = [];
  const r = createRoom({ countIn: 0, arriveIn: ARRIVE_DELAY_TICKS,
    onBroadcast: m => { const x = typeof m === 'function' ? m(0) : m; if (x.t === 'snap') snaps.push(x); } });
  return { r, snaps };
}

test('the delay is three seconds', () => {
  assert.equal(ARRIVE_DELAY_TICKS, 3 * TICK_HZ);
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
