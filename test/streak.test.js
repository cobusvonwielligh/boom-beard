import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCK, FIRE_TICKS, STREAK_WINDOW_TICKS, TICK_HZ } from '../shared/constants.js';
import {
  createPlayer, recordStreakKill, resetStreak, streakActive, tileAt, tileCentre,
} from '../shared/sim/state.js';
import { createRoom } from '../server/room.js';

test('a streak starts on the second kill within the configured window', () => {
  const player = createPlayer(0, 'captain');
  recordStreakKill(player, 10);
  assert.equal(streakActive(player, 10), false);
  recordStreakKill(player, 10 + STREAK_WINDOW_TICKS);
  assert.equal(streakActive(player, 10 + STREAK_WINDOW_TICKS), true);
});

test('a streak remains alive for 11 seconds after the latest kill', () => {
  assert.equal(STREAK_WINDOW_TICKS, 11 * TICK_HZ);
});

test('a streak expires after the window and death resets its count', () => {
  const player = createPlayer(0, 'captain');
  recordStreakKill(player, 10);
  recordStreakKill(player, 11);
  assert.equal(streakActive(player, 11 + STREAK_WINDOW_TICKS), true);
  assert.equal(streakActive(player, 12 + STREAK_WINDOW_TICKS), false);
  resetStreak(player);
  assert.equal(player.streakCount, 0);
  assert.equal(player.streakLastKillTick, -1);
  assert.equal(streakActive(player, 11), false);
});

test('room announcements use the simulation streak count', () => {
  const messages = [];
  const room = createRoom({
    onBroadcast: message => { if (message?.t) messages.push(message); },
    countIn: 0,
    arriveIn: 0,
  });
  const killerSeat = room.join('killer', 'captain').seat;
  const victimSeat = room.join('victim', 'target').seat;
  const killer = room.state.players[killerSeat];
  const victim = room.state.players[victimSeat];
  const floors = [];
  for (let ty = 1; ty < room.state.map.h - 1; ty++) {
    for (let tx = 1; tx < room.state.map.w - 1; tx++) {
      if (tileAt(room.state.map, tx, ty) === BLOCK.FLOOR) floors.push({ tx, ty });
      if (floors.length === 2) break;
    }
    if (floors.length === 2) break;
  }

  killer.alive = true;
  killer.x = tileCentre(floors[0].tx); killer.y = tileCentre(floors[0].ty);
  killer.streakCount = 1; killer.streakLastKillTick = room.state.tick;
  victim.alive = true;
  victim.x = tileCentre(floors[1].tx); victim.y = tileCentre(floors[1].ty);
  victim.hp = 1; victim.status = 0; victim.statusUntil = {};
  room.state.fires.push({
    ...floors[1], kind: 'core', rot: 0, until: FIRE_TICKS, owner: killerSeat, src: 1,
  });

  room.tick();

  assert.equal(killer.streakCount, 2);
  assert.ok(messages.some(message => message.t === 'streak' && message.i === killerSeat && message.n === 2));
  room.stop();
});
