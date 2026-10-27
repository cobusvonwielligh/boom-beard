import test from 'node:test';
import assert from 'node:assert/strict';
import { createBotEmoter } from '../server/botEmotes.js';
import { createRoom } from '../server/room.js';
import { RESPAWN_COUNTDOWN_TICKS } from '../shared/constants.js';
import { TICK_HZ } from '../shared/constants.js';
import { toTile } from '../shared/sim/state.js';

const bot = name => ({ isBot: true, name, brain: {} });

test('a bot occasionally reacts to a kill using the existing chat message shape', () => {
  const messages = [];
  const emoter = createBotEmoter({ broadcast: message => messages.push(message), random: () => 0 });
  const seats = [{ isBot: false, name: 'Player' }, bot('Charles')];

  assert.equal(emoter.react({ e: 'died', i: 0, by: 1 }, seats, 100), true);
  assert.deepEqual(messages, [{ t: 'chat', i: 1, name: 'Charles', msg: '👍' }]);
});

test('a bot reacts with a downbeat emote when a human kills it', () => {
  const messages = [];
  const emoter = createBotEmoter({ broadcast: message => messages.push(message), random: () => 0 });
  const seats = [{ isBot: false, name: 'Player' }, bot('Charles')];

  assert.equal(emoter.react({ e: 'died', i: 1, by: 0 }, seats, 100), true);
  assert.equal(messages[0].msg, '👎');
  assert.equal(messages[0].i, 1);
});

test('bot reactions are occasional and respect per-bot and room-wide cooldowns', () => {
  const messages = [];
  let chance = 0;
  const emoter = createBotEmoter({
    broadcast: message => messages.push(message),
    random: () => chance,
  });
  const seats = [{ isBot: false, name: 'Player' }, bot('Charles'), bot('Rosa')];

  assert.equal(emoter.react({ e: 'died', i: 0, by: 1 }, seats, 100), true);
  assert.equal(emoter.react({ e: 'died', i: 0, by: 2 }, seats, 100 + TICK_HZ * 2), false);
  assert.equal(emoter.react({ e: 'died', i: 0, by: 1 }, seats, 100 + TICK_HZ * 20), false);

  chance = 1;
  assert.equal(emoter.react({ e: 'died', i: 0, by: 1 }, seats, 100 + TICK_HZ * 31), false);
  assert.equal(messages.length, 1);
});

test('human-only deaths and non-death events never trigger bot chat', () => {
  const messages = [];
  const emoter = createBotEmoter({ broadcast: message => messages.push(message), random: () => 0 });
  const seats = [{ isBot: false, name: 'Player' }, bot('Charles')];

  assert.equal(emoter.react({ e: 'died', i: 0, by: 0 }, seats, 100), false);
  assert.equal(emoter.react({ e: 'hurt', i: 1, by: 0 }, seats, 200), false);
  assert.deepEqual(messages, []);
});

test('the room broadcasts a bot reaction when the bot earns a kill', () => {
  const messages = [];
  const room = createRoom({
    countIn: 0,
    onBroadcast: message => messages.push(message),
    botEmoteRandom: () => 0,
  });
  try {
    room.setBots(1);
    const { seat: victimSeat } = room.join('human-id', 'Human');
    room.requestRespawn(victimSeat);
    for (let i = 0; i <= RESPAWN_COUNTDOWN_TICKS; i++) room.tick();
    const victim = room.state.players[victimSeat];
    victim.status = 0;
    victim.statusUntil = {};
    victim.hp = 1;
    victim.shields = 0;
    victim.shieldGrace = 0;
    victim.hitBy = [];
    room.state.fires.push({
      tx: toTile(victim.x),
      ty: toTile(victim.y),
      until: room.state.tick + 1000,
      owner: 0,
      src: 'bot-test-fire',
      kind: 'core',
    });

    room.tick();

    assert.ok(messages.some(message =>
      message.t === 'chat' && message.i === 0 && message.msg === '👍'));
  } finally {
    room.stop();
  }
});
