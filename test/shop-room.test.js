import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_BOMBS_CARRIED, MAX_RADIUS, MAX_SHIELDS, MAX_SKATES, MAX_STAMINA_LEVELS,
  ROUND_INTERMISSION_MS, START_RADIUS, staminaMaxFor,
} from '../shared/constants.js';
import { createLeaderboard, careerKey } from '../server/leaderboard.js';
import { createRoom } from '../server/room.js';

async function setup(t, onBroadcast = () => {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bv-shop-room-'));
  const leaderboard = createLeaderboard({ dataDir });
  const room = createRoom({ countIn: 0, arriveIn: 0, onBroadcast, leaderboard });
  t.after(async () => {
    room.stop();
    await leaderboard.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, leaderboard, room };
}

test('room-authoritative gold shop', async t => {
  await t.test('only dead humans or players in intermission can purchase', async t => {
    const { leaderboard, room } = await setup(t);
    const human = room.join('human-id', 'ann').seat;
    const p = room.state.players[human];
    p.coins = 2;

    assert.equal(room.buyShop(human, 'speed').why, 'shop is closed');
    assert.equal(leaderboard.economy(careerKey('human-id', 'ann')), null,
      'an alive-player rejection did not bank or create a career');

    p.alive = false;
    const bought = room.buyShop(human, 'speed');
    assert.equal(bought.ok, true);
    assert.equal(bought.wallet, 1, 'coins collected immediately before death are banked first');
    room.bankScores();
    assert.equal(leaderboard.get(careerKey('human-id', 'ann')).coins, 2,
      'the same coins were not banked twice');

    room.setBots(1);
    const bot = room.state.players.findIndex(player => player?.isBot);
    assert.equal(room.buyShop(bot, 'speed').why, 'shop unavailable');
    assert.equal(room.shopState(-1).ok, false);
  });

  await t.test('purchased upgrades apply on the next respawn', async t => {
    const { leaderboard, room } = await setup(t);
    const seat = room.join('human-id', 'ann').seat;
    const p = room.state.players[seat];
    p.alive = false;
    p.coins = 6;

    for (const item of ['bombs', 'fire', 'speed', 'shield', 'stim']) {
      assert.equal(room.buyShop(seat, item).ok, true);
    }

    room.requestRespawn(seat);
    assert.equal(p.alive, true);
    assert.equal(p.bombs, MAX_BOMBS_CARRIED - 2);
    assert.equal(p.radius, START_RADIUS + 1);
    assert.equal(p.speed, 2);
    assert.equal(p.shields, 1);
    assert.equal(p.staminaLevel, 2);
    assert.equal(p.stamina, staminaMaxFor(p));
    assert.deepEqual(leaderboard.economy(careerKey('human-id', 'ann')).pending,
      { bombs: 0, fire: 0, speed: 0, shield: 0, stim: 0 });
  });

  await t.test('intermission is 16 seconds and allows living players to buy', async t => {
    const messages = [];
    const { leaderboard, room } = await setup(t, m => messages.push(typeof m === 'function' ? m(0) : m));
    const seat = room.join('human-id', 'ann').seat;
    room.state.players[seat].coins = 2;
    room.setRoundTime(0.1);
    for (let i = 0; i < 180; i++) room.tick();

    const roundend = messages.findLast(m => m.t === 'roundend');
    assert.equal(ROUND_INTERMISSION_MS, 16_000);
    assert.equal(roundend.startsInMs, ROUND_INTERMISSION_MS);
    assert.equal(room.roundInfo().between, true);
    const reconnect = room.welcomeFor(seat);
    assert.ok(reconnect.intermissionMs > 0 && reconnect.intermissionMs <= ROUND_INTERMISSION_MS);
    assert.deepEqual(reconnect.standings, roundend.standings);
    assert.equal(reconnect.nextMap, roundend.nextMap);
    room.state.players[seat].alive = true;
    const walletBefore = leaderboard.economy(careerKey('human-id', 'ann'))?.wallet
      ?? room.state.players[seat].coins;
    const shield = room.buyShop(seat, 'shield');
    assert.equal(shield.ok, true);
    assert.equal(shield.wallet, walletBefore - 2);
  });

  await t.test('connected human queues apply once before the next welcome', async t => {
    const messages = [];
    const { leaderboard, room } = await setup(t, m => {
      messages.push(typeof m === 'function' ? m(0) : m);
    });
    const seat = room.join('human-id', 'ann').seat;
    const p = room.state.players[seat];
    p.alive = false;
    p.coins = 7;
    for (const item of ['bombs', 'bombs', 'fire', 'speed', 'shield', 'stim']) {
      assert.equal(room.buyShop(seat, item).ok, true);
    }

    room.restartRound();
    const loaded = room.state.players[seat];
    assert.equal(loaded.bombs, MAX_BOMBS_CARRIED);
    assert.equal(loaded.speed, 2);
    assert.equal(loaded.shields, 1);
    assert.equal(loaded.staminaLevel, 2);
    assert.equal(loaded.stamina, staminaMaxFor(loaded));
    assert.equal(loaded.radius, START_RADIUS + 1);
    const welcome = messages.findLast(m => m.t === 'welcome');
    const wirePlayer = welcome.players.find(player => player.i === seat);
    assert.deepEqual([wirePlayer.b, wirePlayer.f, wirePlayer.sp, wirePlayer.sh],
      [MAX_BOMBS_CARRIED, START_RADIUS + 1, 2, 1]);
    assert.deepEqual(leaderboard.economy(careerKey('human-id', 'ann')).pending,
      { bombs: 0, fire: 0, speed: 0, shield: 0, stim: 0 });

    assert.ok(MAX_SKATES >= loaded.speed && MAX_SHIELDS >= loaded.shields);
    assert.ok(MAX_STAMINA_LEVELS >= loaded.staminaLevel && MAX_RADIUS >= loaded.radius);
  });

  await t.test("disconnected queues apply on that player's next spawn", async t => {
    const { leaderboard, room } = await setup(t);
    const held = room.join('held-id', 'held').seat;
    room.state.players[held].alive = false;
    room.state.players[held].coins = 1;
    assert.equal(room.buyShop(held, 'speed').ok, true);
    room.disconnect(held);
    room.restartRound();
    assert.equal(leaderboard.economy(careerKey('held-id', 'held')).pending.speed, 2);

    const lateKey = careerKey('late-id', 'late');
    leaderboard.record(lateKey, { name: 'late', coins: 1 });
    leaderboard.buy(lateKey, 'fire');
    room.restartRound();
    const late = room.join('late-id', 'late').seat;
    assert.equal(room.state.players[late].radius, START_RADIUS + 1);
    assert.equal(leaderboard.economy(lateKey).pending.fire, 0);
    room.restartRound();
    assert.equal(room.state.players[late].radius, START_RADIUS);
  });
});
