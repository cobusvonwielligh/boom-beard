// Seagulls, and the room keeping bots topped up. Both are rules with a "hard on purpose" or a
// "never argue with the host" in them, which is exactly the kind of rule that quietly erodes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GULL_FIRST_TICK, GULL_MAX, GULL_LOW_ALT, GULL_COINS, GULL_RAID_COINS, FIRE_TICKS, PERK, AUTO_BOTS_MIN,
  UNITS_PER_TILE, SCORE, BLOCK, GULL_RAID_AT_MIN, GULL_RAID_AT_MAX,
} from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';
import { createState, createPlayer, tileAt, tileCentre } from '../shared/sim/state.js';
import { gulls, gullAt, gullAltitude } from '../shared/sim/gulls.js';
import { rng } from '../shared/util/rng.js';
import { createRoom } from '../server/room.js';

const fresh = () => createState(MAPS[0]);

/** Run the gull system alone until one is in the air. */
function withGull() {
  const s = fresh();
  s.tick = GULL_FIRST_TICK;
  gulls(s);
  assert.equal(s.gulls.length, 1, 'no gull arrived at GULL_FIRST_TICK');
  return s;
}

/** The first tick, from `from`, at which the gull is low and over a floor tile. */
function lowOverFloor(s, g) {
  for (let t = s.tick; t < g.t0 + g.dur; t++) {
    const at = gullAt(g, t);
    if (at.alt > GULL_LOW_ALT) continue;
    const tx = Math.floor(at.x / UNITS_PER_TILE), ty = Math.floor(at.y / UNITS_PER_TILE);
    if (tx < 0 || ty < 0 || tx >= s.map.w || ty >= s.map.h) continue;
    return { t, tx, ty };
  }
  return null;
}

test('a gull enters and leaves off the map, and dives on the way', () => {
  const s = withGull();
  const g = s.gulls[0];
  const W = s.map.w * UNITS_PER_TILE, H = s.map.h * UNITS_PER_TILE;
  const off = p => p.x < 0 || p.y < 0 || p.x > W || p.y > H;
  assert.ok(off(gullAt(g, g.t0)), 'it appeared over the island');
  assert.ok(off(gullAt(g, g.t0 + g.dur)), 'it vanished over the island');
  assert.equal(gullAltitude(g, g.t0), 1, 'it should enter high, not mid-dive');
  let low = 0;
  for (let t = g.t0; t < g.t0 + g.dur; t++) if (gullAt(g, t).alt <= GULL_LOW_ALT) low++;
  const share = low / g.dur;
  // Catchable, and rarely: the whole point is that this is a hard shot.
  assert.ok(share > 0.05 && share < 0.2, `low for ${(share * 100).toFixed(1)}% of its flight`);
});

test('never more than GULL_MAX in the air, and they leave', () => {
  const s = fresh();
  let most = 0;
  for (s.tick = 0; s.tick < 20 * 60 * 30; s.tick++) {
    gulls(s);
    most = Math.max(most, s.gulls.length);
  }
  assert.ok(most >= 1, 'twenty minutes and not one gull');
  assert.ok(most <= GULL_MAX);
});

test('gulls have their own random stream, so drops and regrowth are unchanged', () => {
  const s = fresh();
  const shadow = rng(s.seed ^ 0x9e3779b9);
  for (s.tick = 0; s.tick < GULL_FIRST_TICK + 10; s.tick++) gulls(s);
  assert.equal(s.next(), shadow(), 'the gulls drew from the simulation\'s main stream');
});

test('a blast with nobody behind it leaves its coin on the floor, outside the round cap', () => {
  const s = withGull();
  const g = s.gulls[0];
  const shot = lowOverFloor(s, g);
  assert.ok(shot, 'this flight never went low over the island');
  s.tick = shot.t;
  // Owner 3, with no player in that seat: a powder keg, as far as this rule is concerned.
  s.fires = [{ tx: shot.tx, ty: shot.ty, kind: 'arm', rot: 0, until: s.tick + FIRE_TICKS, owner: 3 }];
  s.events.length = 0;
  gulls(s);
  assert.equal(s.gulls.length, 0, 'it flew on through the fire');
  const hit = s.events.find(e => e.e === 'gullhit');
  assert.ok(hit, 'no gullhit event');
  assert.equal(hit.by, 3);
  assert.ok(s.perks.some(k => k.type === PERK.GOLD), 'no coin');
  assert.equal(s.goldDropped, 0, 'an earned coin counted against the round\'s random gold');
});

test('the shooter is paid GULL_COINS in the air, and nothing is left on the floor', () => {
  const s = withGull();
  const g = s.gulls[0];
  const shot = lowOverFloor(s, g);
  s.tick = shot.t;
  const p = createPlayer(2, 'cobus');
  p.alive = true;
  s.players[2] = p;
  s.fires = [{ tx: shot.tx, ty: shot.ty, kind: 'arm', rot: 0, until: s.tick + FIRE_TICKS, owner: 2 }];
  s.events.length = 0;
  gulls(s);
  assert.equal(p.coins, GULL_COINS, 'the shooter was not paid');
  assert.equal(p.score, SCORE.GOLD, 'one coin of XP for the shot, not three');
  assert.equal(s.perks.length, 0, 'a coin was left on the floor as well as paid out');
  assert.equal(s.events.find(e => e.e === 'gullhit')?.coins, GULL_COINS);
});

test('height is no longer a defence, but embers and bots are not shots', () => {
  const s = withGull();
  const g = s.gulls[0];

  // Embers: over the island, but the fire is past its lethal window.
  const shot = lowOverFloor(s, g);
  s.tick = shot.t;
  s.fires = [{ tx: shot.tx, ty: shot.ty, kind: 'arm', rot: 0, until: s.tick + 2, owner: 0 }];
  gulls(s);
  assert.equal(s.gulls.length, 1, 'smoke at the end of a blast brought a gull down');

  // A bot's fire, live and right underneath: the bird flies on.
  const bot = createPlayer(0, 'Charles');
  bot.alive = true;
  bot.isBot = true;
  s.players[0] = bot;
  s.fires = [{ tx: shot.tx, ty: shot.ty, kind: 'arm', rot: 0, until: s.tick + FIRE_TICKS, owner: 0 }];
  gulls(s);
  assert.equal(s.gulls.length, 1, 'a bot shot a gull down');

  // Cruising at full height over a person's blast: down it comes.
  let t = s.tick;
  while (gullAt(g, t).alt < 1 || gullAt(g, t).x < 0 || gullAt(g, t).y < 0) t++;
  const at = gullAt(g, t);
  s.tick = t;
  s.fires = [{ tx: Math.floor(at.x / UNITS_PER_TILE), ty: Math.floor(at.y / UNITS_PER_TILE),
    kind: 'core', rot: 0, until: t + FIRE_TICKS, owner: 5 }];
  gulls(s);
  assert.equal(s.gulls.length, 0, 'a cruising gull survived a live blast under it');
});

// ─── the raid ─────────────────────────────────────────────────────────────────

/** A round's worth of gull ticks, with one person and one bot standing on floor. */
function raidRound({ person = true, joinFraction = 0 } = {}) {
  const s = fresh();
  s.roundTicks = 60 * 30;
  let at = null;
  for (let ty = 1; ty < s.map.h - 1 && !at; ty++) {
    for (let tx = 1; tx < s.map.w - 1; tx++) {
      if (tileAt(s.map, tx, ty) === BLOCK.FLOOR) { at = { tx, ty }; break; }
    }
  }
  const stand = (i, name, isBot) => {
    const p = createPlayer(i, name);
    p.alive = true; p.shields = 2;
    p.x = tileCentre(at.tx); p.y = tileCentre(at.ty);
    if (isBot) p.isBot = true;
    s.players[i] = p;
    return p;
  };
  const p = person ? stand(1, 'cobus', false) : null;
  if (p) p.joinedAtTick = Math.round(s.roundTicks * joinFraction);
  const bot = stand(2, 'Charles', true);

  const raids = [], kills = [];
  for (s.tick = 0; s.tick < s.roundTicks; s.tick++) {
    s.events.length = 0;
    gulls(s);
    for (const e of s.events) {
      if (e.e === 'gullraid') raids.push({ tick: s.tick, seat: e.seat });
      if (e.e === 'gullkill') kills.push({ tick: s.tick, seat: e.i });
    }
    // Back on their feet, so a second raid in the same round would have somebody to take.
    for (const q of [p, bot]) if (q && !q.alive && s.tick >= q.respawnAt) q.alive = true;
  }
  return { s, p, bot, raids, kills };
}

test('once a round, two gulls take a real person and kill them', () => {
  const { s, p, bot, raids, kills } = raidRound();
  assert.equal(raids.length, 1, `the raid fired ${raids.length} times in one round`);
  assert.equal(kills.length, 1);
  assert.equal(raids[0].seat, p.i, 'the gulls went for the bot');
  assert.equal(bot.gulled, false, 'a bot was claimed by the gull raid, which is nobody\'s story');

  const when = raids[0].tick / s.roundTicks;
  assert.ok(when >= GULL_RAID_AT_MIN && when <= GULL_RAID_AT_MAX,
    `the raid landed at ${(when * 100).toFixed(1)}% of the round`);
  assert.ok(kills[0].tick > raids[0].tick, 'the kill landed with no warning at all');
  assert.equal(p.gulled, true, 'the scoreboard will not know who it was');
  assert.equal(s.gulled, p.i);
  assert.equal(p.shields, 0, 'a shield saved them from a bird');
  assert.equal(p.deaths, 1);
  assert.equal(p.coins, GULL_RAID_COINS, 'the gull raid did not pay its gold');
  assert.equal(p.score, SCORE.GOLD * GULL_RAID_COINS, 'the gull raid gold was not scored');
});

test('two gulls, crossing, and no shot credited to anybody', () => {
  const { raids, kills } = raidRound();
  assert.equal(kills[0].seat, raids[0].seat);
  // The kill event carries no `by`: this one is nobody's, which is what makes it funny rather
  // than a thing to be annoyed at somebody about.
  assert.equal(Object.hasOwn(kills[0], 'by'), false);
});

test('a room of nothing but bots is never raided', () => {
  const { raids, kills, bot } = raidRound({ person: false });
  assert.equal(raids.length, 0, 'the gulls raided a bot');
  assert.equal(kills.length, 0);
  assert.equal(bot.gulled, false);
});

test('a player joining during the final 70% is not eligible for the gull raid', () => {
  const { p, raids, kills } = raidRound({ joinFraction: 0.4 });
  assert.equal(raids.length, 0, 'the raid targeted a late joiner');
  assert.equal(kills.length, 0, 'the late joiner was killed');
  assert.equal(p.deaths, 0);
});

// ─── bots ─────────────────────────────────────────────────────────────────────

const room = () => createRoom({ countIn: 0, onBroadcast: () => {}, minBots: AUTO_BOTS_MIN });

test('the room records a human join tick for gull-raid eligibility', () => {
  const r = room();
  try {
    r.state.tick = 321;
    const { seat } = r.join('late', 'late');
    assert.equal(r.state.players[seat].joinedAtTick, 321);
  } finally { r.stop(); }
});

/** Play out one (six-second) round, then start the next by hand. */
function round(r) {
  r.setRoundTime(0.1);
  for (let i = 0; i < 400 && !r.roundInfo().between; i++) r.tick();
  assert.ok(r.roundInfo().between, 'the round did not end');
  r.restartRound();
}

test('a person joining is met by at least AUTO_BOTS_MIN bots', () => {
  const r = room();
  try {
    assert.equal(r.botCount(), 0, 'bots before anyone came');
    r.join('a', 'alice');
    assert.equal(r.botCount(), AUTO_BOTS_MIN);
    r.join('b', 'bob');
    assert.equal(r.botCount(), AUTO_BOTS_MIN, 'a second person should not add more');
  } finally { r.stop(); }
});

test('two empty rounds send the bots home', () => {
  const r = room();
  try {
    const { seat } = r.join('a', 'alice');
    r.disconnect(seat);
    round(r);                     // alice was here for this one
    assert.equal(r.botCount(), AUTO_BOTS_MIN);
    round(r);                     // empty
    assert.equal(r.botCount(), AUTO_BOTS_MIN, 'gone after one empty round');
    round(r);                     // empty again
    assert.equal(r.botCount(), 0, 'still here after two empty rounds');
  } finally { r.stop(); }
});

test('the US room starts with four bots and keeps them through empty rounds', () => {
  const r = createRoom({ regionId: 'us', minBots: 4, countIn: 0, onBroadcast: () => {} });
  try {
    assert.equal(r.botCount(), 4);
    round(r);
    round(r);
    round(r);
    assert.equal(r.botCount(), 4);
    assert.equal(r.autoBots, true);
  } finally { r.stop(); }
});

test('a host removing bots by hand is not overruled until the room has emptied', () => {
  const r = room();
  try {
    r.join('a', 'alice');
    const bot = r.state.players.findIndex((p, i) => p && r.isBot(i));
    r.kickSeat(bot);
    assert.equal(r.autoBots, false);
    r.join('b', 'bob');
    assert.equal(r.botCount(), AUTO_BOTS_MIN - 1, 'the top-up put the kicked bot straight back');

    r.setBots(10, { byHand: true });
    assert.equal(r.botCount(), 10, 'asking for MORE by hand is fine');
    r.setBots(2, { byHand: true });
    assert.equal(r.botCount(), 2);

    // Everyone leaves; two empty rounds later the policy is back.
    for (let i = 0; i < 16; i++) if (r.state.players[i] && !r.isBot(i)) r.disconnect(i);
    round(r); round(r); round(r);
    assert.equal(r.autoBots, true);
    assert.equal(r.botCount(), 0);
    r.join('c', 'carol');
    assert.equal(r.botCount(), AUTO_BOTS_MIN);
  } finally { r.stop(); }
});
