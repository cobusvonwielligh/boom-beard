import { TICK_HZ } from '../shared/constants.js';

const REACTION_CHANCE = 0.2;
const BOT_COOLDOWN_TICKS = 30 * TICK_HZ;
const ROOM_COOLDOWN_TICKS = 3 * TICK_HZ;

export function createBotEmoter({ broadcast, random = Math.random }) {
  let lastRoomEmoteTick = -Infinity;

  return {
    react(event, seats, tick) {
      if (event?.e !== 'died') return false;

      const killer = seats[event.by];
      const victim = seats[event.i];
      const killerIsBot = event.by !== event.i && killer?.isBot;
      const speakerIndex = killerIsBot ? event.by : victim?.isBot ? event.i : -1;
      if (speakerIndex < 0) return false;

      const speaker = seats[speakerIndex];
      if (tick - (speaker.brain.lastEmoteTick ?? -Infinity) < BOT_COOLDOWN_TICKS ||
          tick - lastRoomEmoteTick < ROOM_COOLDOWN_TICKS ||
          random() >= REACTION_CHANCE) return false;

      speaker.brain.lastEmoteTick = tick;
      lastRoomEmoteTick = tick;
      broadcast({
        t: 'chat',
        i: speakerIndex,
        name: speaker.name,
        msg: killerIsBot ? '👍' : '👎',
      });
      return true;
    },
  };
}
