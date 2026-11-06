// One round: the authoritative loop, the seats, and the snapshots.
//
// The loop is the only thing in the project allowed to decide the order of operations - see
// docs/ARCHITECTURE.md §4. Everything it calls is a pure-ish system from shared/sim.

import {
  TICK_MS, TICK_HZ, SNAP_EVERY_TICKS, MAX_PLAYERS, ROUND_TICKS, STATUS, STATUS_TICKS,
  ROUNDTIME_MIN_MIN, ROUNDTIME_MAX_MIN,
  TILE_PX, UNITS_PER_TILE, HITBOX_UNITS, FUSE_TICKS, FIRE_TICKS, FIRE_LETHAL_TICKS,
  paletteColor, COLOUR_PREFERENCE, DISTINCT_PLAYERS, isDistinctColour, encodeSeatColours,
  SCORE, ROUND_INTERMISSION_MS, MAX_HP, START_BOMBS, START_RADIUS, staminaMaxFor,
  progressFor, RESPAWN_COUNTDOWN_TICKS,
  STREAK_NAMES, STREAK_ACE, GAMESPEED_MIN, GAMESPEED_MAX,
  IDLE_KICK_TICKS, AUTO_BOTS_EMPTY_ROUNDS, IN_MASK, COUNT_IN_TICKS,
} from '../shared/constants.js';
import { MAPS, encodeCells } from '../shared/maps.js';
import { createState, createPlayer, applyStatus, tileCentre } from '../shared/sim/state.js';
import { blocked } from '../shared/sim/movement.js';
import { burns } from '../shared/sim/fire.js';
import { tick as simTick } from '../shared/sim/round.js';
import { gullWire } from '../shared/sim/gulls.js';
import { careerKey } from './leaderboard.js';
import { emptyShopQueue } from '../shared/shop.js';
import { createBrain, delayBotInput, think, dangerMap } from './ai.js';
import { createBotEmoter } from './botEmotes.js';
import { nameKey } from './names.js';

// How long a seat is held for someone who vanished. A closed laptop lid, a wifi roam or a tunnel
// all look identical to a crash, and losing your stats to a two-second blip is maddening.
const RECONNECT_GRACE_TICKS = 45 * 30;      // 45 seconds
const INPUT_BUFFER_TICKS = 64;

// An ACE needs a crowd to mean anything. With two players seated, "everyone else" is one person
// and every ordinary kill would announce itself; three victims is the smallest sweep worth a
// banner. See docs/RULES.md §13.
const ACE_MIN_VICTIMS = 3;

const newStreak = () => ({ victims: new Set() });

// Bots go by people's names. Twenty-eight, more than the fifteen bot seats there can ever be.
export const BOT_NAMES = [
  'Charles', 'Tango', 'Johnson', 'Echo', 'Sanchez', 'Franky', 'Steven',
  'Marco', 'Rosa', 'Dmitri', 'Kenji', 'Priya', 'Olu', 'Bianca',
  'Hector', 'Ingrid', 'Mateo', 'Nadia', 'Ravi', 'Sasha', 'Tomas',
  'Wendell', 'Yusuf', 'Zara', 'Lena', 'Bruno', 'Gus', 'Mabel',
];

export function createRoom({ onKick, onBroadcast, adminName = '', maxPlayers = MAX_PLAYERS,
  leaderboard = null, regionId = 'za',
  // Overridable so a test can watch a seat be recycled without waiting 45 real seconds.
  graceTicks = RECONNECT_GRACE_TICKS,
  // How many bots to keep topped up while people are here; see AUTO_BOTS_MIN. Zero - the
  // default, so a test room stays exactly as its test seats it - turns the policy off.
  minBots = 0,
  /* Ticks of frozen count-in at the top of each round. See COUNT_IN_TICKS.
   *
   * Overridable for the same reason `graceTicks` is: a test about input, events or medals is not
   * a test about the count-in, and making every one of them wait five simulated seconds for the
   * whistle would hide what they are actually asserting. Zero means the round is live on tick 0,
   * which is what the room did before the freeze existed.
   */
  countIn = COUNT_IN_TICKS,
  /* Ticks a living reconnect is held off the board before being placed. A first-time entrant
   * now waits in the shop instead. See ARRIVE_DELAY_TICKS. */
  arriveIn = 0,
  botEmoteRandom = Math.random,
}) {
  // Start the regional queues at different maps while keeping their round-by-round rotation.
  let mapIndex = regionId === 'us' ? 2 : 0;
  let state = createState(MAPS[mapIndex]);

  // seat -> identity/input state plus a same-round, pre-disconnect loadout snapshot
  const seats = new Array(maxPlayers).fill(null);
  let timer = null;
  let nextDeadline = 0;
  let between = false;      // intermission: scoreboard up, simulation paused
  let intermissionDeadline = 0;
  let intermissionStandings = [];
  const tickTimes = [];

  // The handle for the intermission's "start the next round" timer. Kept so /restart and /map can
  // cancel it; see cancelIntermission.
  let roundTimer = null;

  // Percent of the real-time tick rate. The tick itself is always 1/30 s of simulated time.
  let gamespeed = 100;
  // How long a round runs, in ticks. Defaults to ROUND_TICKS and is changeable at runtime by the
  // host with /roundtime - a Friday session is not always a ten-minute-round session.
  let roundTicks = ROUND_TICKS;
  const tickMs = () => TICK_MS * 100 / gamespeed;

  // Monotonic, so "the most recently added bot" survives bots being removed from the middle.
  let botSeq = 0;

  // The automatic top-up. Off once a host removes bots by hand; back on after the room has been
  // empty of people for AUTO_BOTS_EMPTY_ROUNDS rounds in a row. See AUTO_BOTS_MIN.
  let autoBots = minBots > 0;
  let emptyRounds = 0;
  // Whether a connected human was seen at any point this round, not just at its end: somebody
  // who played eight minutes and left before the whistle was present.
  let humanThisRound = false;

  // The simulation owns streak count and expiry; this set tracks only ACE victim coverage.
  const streaks = new Array(maxPlayers).fill(null).map(() => newStreak());
  const botEmoter = createBotEmoter({ broadcast: onBroadcast, random: botEmoteRandom });

  // ─── seating ────────────────────────────────────────────────────────────────

  const findSeatByPlayerId = id => (id ? seats.findIndex(s => s && s.playerId === id) : -1);

  /** Seat of a living or reserved player by name, case-insensitively. -1 for nobody. */
  const seatOfName = name => {
    const want = nameKey(name);
    return seats.findIndex(s => s && nameKey(s.name) === want);
  };

  /** The bot that joined most recently, or -1. */
  const newestBotSeat = () => {
    let seat = -1, newest = -1;
    for (let i = 0; i < maxPlayers; i++) {
      if (seats[i]?.isBot && seats[i].addedAt > newest) { newest = seats[i].addedAt; seat = i; }
    }
    return seat;
  };

  /* ─── colours ───
   *
   * Picked when somebody sits down and then left alone; see COLOUR_PREFERENCE for why the order
   * is what it is. `seat.colour` is a palette slot, and the table goes out in every snapshot. */
  const coloursInUse = except => new Set(seats.filter((s, i) => s && i !== except).map(s => s.colour));
  const pickColour = seat => {
    const used = coloursInUse(seat);
    return COLOUR_PREFERENCE.find(k => !used.has(k)) ?? seat;
  };
  /** Between rounds only: a small room gets back onto the eight colours nobody can confuse. */
  function settleColours() {
    if (seats.filter(Boolean).length > DISTINCT_PLAYERS) return;
    for (let i = 0; i < maxPlayers; i++) {
      const s = seats[i];
      if (!s || isDistinctColour(s.colour)) continue;
      s.colour = pickColour(i);
    }
  }
  const coloursWire = () => encodeSeatColours(seats.map((s, i) => (s ? s.colour : i)));

  /** Vacate a seat without banking anything. Bots have no career to bank. */
  function clearSeat(seat) {
    seats[seat] = null;
    state.players[seat] = null;
    streaks[seat] = newStreak();
  }

  /** @param admin this connection presented the admin key; see `adminKey` in server/config.js. */
  function join(playerId, name, { admin = false } = {}) {
    const existing = findSeatByPlayerId(playerId);
    const named = seatOfName(name);

    // A name is one person, including while their disconnected seat is reserved. This check is
    // independent of playerId: a fresh browser/device ID must never create a second copy, while
    // the owner reconnecting to their own held seat remains valid.
    if (named >= 0 && named !== existing) {
      return { seat: -1, resumed: false, playerId: null, displaced: null, why: 'already-playing' };
    }

    if (existing >= 0) {
      const held = seats[existing];

      // An id is one person, and one person plays once. A second window on the same identity is
      // turned away rather than quietly handed a second seat or allowed to steal the first - a
      // sixteen-seat server where one person can hold two of them is a smaller server.
      //
      // Only a LIVE seat refuses. A socket that has actually gone is the reconnect case, and
      // that has to keep working: a wifi roam must not lock you out of your own score.
      if (held.connected) {
        return { seat: -1, resumed: false, playerId: null, displaced: null, why: 'already-playing' };
      }

      held.connected = true;
      held.goneSince = 0;
      held.lastInputAt = state.tick;
      held.name = name || held.name;
      held.admin = admin;
      if (state.players[existing]) state.players[existing].name = held.name;
      // Coming back mid-life: lifted off the board and placed again after the arrival delay, so
      // the rejoin is shown the same way a join is. Somebody who came back dead stays dead and
      // respawns as usual - lifting them would be a free respawn.
      if (state.players[existing]?.alive) holdArrival(state.players[existing]);
      topUpBots();
      return { seat: existing, resumed: true, playerId, displaced: null };
    }

    // A full server that is full of bots is not full. Turning away a real person so a brain we
    // wrote can keep playing is the wrong answer every time, so the newest bot gives up its seat
    // - newest because the bots that have been in longest are the ones already in a fight.
    let seat = seats.findIndex(s => s === null);
    let displaced = null;
    if (seat === -1) {
      const bot = newestBotSeat();
      if (bot >= 0) { displaced = seats[bot].name; clearSeat(bot); seat = bot; }
    }
    if (seat === -1) return { seat: -1, resumed: false, playerId: null, displaced: null };

    const id = playerId || `p_${seat}_${Date.now().toString(36)}_${(Math.random() * 1e6) | 0}`;
    seats[seat] = {
      playerId: id, name, admin, mask: 0, inputs: new Map(), lastAckTick: 0,
      connected: true, goneSince: 0, lastInputAt: state.tick, colour: pickColour(seat),
      firstSpawnPending: true,
    };
    streaks[seat] = newStreak();
    const p = createPlayer(seat, name);
    p.joinedAtTick = state.tick;
    state.players[seat] = p;
    p.respawnAt = state.tick;
    topUpBots();
    return { seat, resumed: false, playerId: id, displaced };
  }

  /* Arriving: wait for the shared round start, or a private delay after it has started.
   *
   * Not dead - no death, no score, and `arriving` rides on the wire so the client shows neither
   * the death card nor an empty heart. respawnAt is the arrival tick, so the respawn key cannot
   * place you early; `placeArrivals` places you on that tick through the ordinary respawn. */
  function holdArrival(p) {
    if (arriveIn <= 0) return;
    p.alive = false;
    p.arriving = true;
    p.arriveAt = state.tick < countIn ? countIn : state.tick + arriveIn;
    p.respawnAt = p.arriveAt;
  }
  function placeArrivals() {
    for (let i = 0; i < state.players.length; i++) {
      const p = state.players[i];
      if (!p?.arriving || state.tick < p.arriveAt) continue;
      p.arriving = false;
      p.arriveAt = 0;
      if (!p.alive) respawn(p);
    }
  }

  function placeRequestedRespawns() {
    for (const p of state.players) {
      if (!p?.respawnRequested || state.tick < p.respawnAt) continue;
      if (!respawn(p)) {
        p.respawnAt = state.tick + 1;
        p.respawnCountdownAt = state.tick;
      }
    }
  }

  function disconnect(seat) {
    const s = seats[seat];
    if (!s) return;
    const p = state.players[seat];
    if (p?.alive) {
      // Reconnect arrives through respawn(), which reapplies a queued shop loadout. Preserve
      // current-round pickups across that path, but only if no death happened while away.
      s.resumeLoadout = {
        bombs: p.bombs, radius: p.radius, speed: p.speed, shields: p.shields,
        staminaLevel: p.staminaLevel, stamina: p.stamina, tired: p.tired,
        deaths: p.deaths,
      };
    } else if (!p?.arriving) {
      s.resumeLoadout = null;
    }
    s.connected = false;
    s.goneSince = state.tick;
    s.mask = 0;                 // stop walking into a wall while you are away
  }

  function release(seat) {
    // Bank what they earned before the seat is recycled, or a disconnect loses the round.
    bankScores();
    clearSeat(seat);
  }

  /**
   * Admin kick. Banks a human's score exactly as a disconnect would - being thrown out of a round
   * is annoying enough without also losing the career points you earned in it.
   *
   * The socket is not ours to close; net.js does that when this returns a name.
   */
  function kickSeat(seat) {
    const s = seats[seat];
    if (!s) return null;
    const info = { name: s.name, bot: !!s.isBot };
    // A host throwing a bot out by hand has told us how many bots they want. Topping it straight
    // back up would be the server overruling them; see AUTO_BOTS_MIN.
    if (s.isBot) autoBots = false;
    release(seat);
    return info;
  }

  // ─── input ──────────────────────────────────────────────────────────────────

  function input(seat, tick, mask) {
    const s = seats[seat];
    if (!s) return;
    if (tick <= s.lastAckTick) return;                 // already simulated; too late to matter
    s.lastInputAt = state.tick;
    s.inputs.set(tick, mask & IN_MASK);
    if (s.inputs.size > INPUT_BUFFER_TICKS) {
      // Drop the oldest rather than growing without bound if a client floods us.
      const oldest = Math.min(...s.inputs.keys());
      s.inputs.delete(oldest);
    }
  }

  // ─── spawning ───────────────────────────────────────────────────────────────

  /**
   * Spawn as far as possible from the nearest living player, so nobody lands in a firefight.
   *
   * A map marker is only a preference: regrown walls, bombs, live fire and other bodies can make
   * one unsafe. Every candidate must fit the full hitbox and have an immediate exit. If every
   * marker fails, scan the map; if the map has no safe tile, do not spawn at all.
   */
  /** A spawn and one adjacent exit must both be free of geometry and live hazards. */
  function safeSpawn(p, tx, ty) {
    const x = tileCentre(tx), y = tileCentre(ty);
    const half = HITBOX_UNITS >> 1;
    const lethalAfter = state.tick + (FIRE_TICKS - FIRE_LETHAL_TICKS);
    const lethal = state.fires.filter(f => f.until > lethalAfter);
    const occupied = (cx, cy) => state.players.some(q => q && q !== p && q.alive
      && Math.abs(q.x - cx) < HITBOX_UNITS && Math.abs(q.y - cy) < HITBOX_UNITS);
    const dangerous = (cx, cy, qx, qy) => blocked(state, p, cx, cy)
      || state.bombs.some(b => b.tx === qx && b.ty === qy)
      || (lethal.length > 0 && burns(lethal, cx, cy, half))
      || state.puddles.some(w => w.tx === qx && w.ty === qy && w.until > state.tick)
      || occupied(cx, cy);

    if (dangerous(x, y, tx, ty)) return false;
    // A legal centre is not enough: a ring of blocks would still make the player wait to die.
    return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
      const qx = tx + dx, qy = ty + dy;
      return !dangerous(tileCentre(qx), tileCentre(qy), qx, qy);
    });
  }

  function respawn(p) {
    // Statuses go first: Reduction changes the hitbox and what counts as walkable, so a legality
    // check run before the clear would be answering for a body shape this player is about to lose.
    p.status = 0;
    p.statusUntil = {};

    const spawns = state.map.spawns;
    const preferred = spawns.filter(([tx, ty]) => safeSpawn(p, tx, ty));
    const fallback = [];
    if (!preferred.length) {
      for (let ty = 0; ty < state.map.h; ty++) {
        for (let tx = 0; tx < state.map.w; tx++) {
          if (safeSpawn(p, tx, ty)) fallback.push([tx, ty]);
        }
      }
    }
    const pool = preferred.length ? preferred : fallback;
    if (!pool.length) { p.alive = false; return false; }

    /* Every legal spawn is a candidate, weighted by how far the nearest living player is.
     *
     * Not "the best five, shuffled". That kept sending everyone back to the same handful of
     * corners, and a corner you can predict is a corner somebody can camp. Weighting the whole
     * list instead means any spot on the map can come up - a busy one is simply unlikely rather
     * than impossible - so there is no set of tiles to watch.
     *
     * Weight is the SQUARE of the distance to the nearest player, which is what makes it a
     * preference rather than a rule: twice as far away is four times as likely, so the far side
     * of the island dominates without the near side ever being ruled out. A floor keeps a map
     * where everybody is bunched together from dividing by nothing.
     *
     * Math.random is fine here: respawn position is decided by the server and shipped in a
     * snapshot, so it is not part of the deterministic simulation the client replays.
     */
    const FLOOR = UNITS_PER_TILE * 2;            // two tiles: nowhere is weight zero
    let total = 0;
    const weights = pool.map(([tx, ty]) => {
      let nearest = Infinity;
      for (const q of state.players) {
        if (!q || !q.alive || q === p) continue;
        const d = Math.abs(q.x - tileCentre(tx)) + Math.abs(q.y - tileCentre(ty));
        if (d < nearest) nearest = d;
      }
      // Nobody else alive: every spawn is equally good, and the loop below still works.
      const reach = (Number.isFinite(nearest) ? nearest : UNITS_PER_TILE * 20) + FLOOR;
      const w = (reach / UNITS_PER_TILE) ** 2;
      total += w;
      return w;
    });
    let roll = Math.random() * total;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i];
      if (roll <= 0) { idx = i; break; }
    }
    const pick = { tx: pool[idx][0], ty: pool[idx][1] };

    applyPendingShopLoadout(p);
    const seat = seats[p.i];
    const resumeLoadout = seat?.resumeLoadout;
    if (resumeLoadout) {
      seat.resumeLoadout = null;
      if (resumeLoadout.deaths === p.deaths) {
        p.bombs = resumeLoadout.bombs;
        p.radius = resumeLoadout.radius;
        p.speed = resumeLoadout.speed;
        p.shields = resumeLoadout.shields;
        p.staminaLevel = resumeLoadout.staminaLevel;
        p.stamina = resumeLoadout.stamina;
        p.tired = resumeLoadout.tired;
      }
    }
    p.x = tileCentre(pick.tx);
    p.y = tileCentre(pick.ty);
    p.alive = true;
    p.respawnRequested = false;
    p.respawnCountdownAt = 0;
    if (seats[p.i]?.firstSpawnPending) {
      seats[p.i].firstSpawnPending = false;
    }
    p.hp = MAX_HP;                               // everybody starts whole; see MAX_HP
    applyStatus(state, p, STATUS.INVULN, STATUS_TICKS[STATUS.INVULN]);
    // Godmode is a property of the SEAT, not of the body. `respawn` clears every status, and a
    // new round builds a new player object from scratch, so without this the admin quietly
    // stopped being invulnerable at the next round boundary and nothing said so.
    if (seats[p.i]?.god) grantGod(p);
    state.events.push({ e: 'spawn', tick: state.tick, i: p.i, x: p.x, y: p.y });
    return true;
  }

  function applyPendingShopLoadout(p) {
    const s = seats[p.i];
    if (!leaderboard || !s?.connected || s.isBot) return;
    const pending = leaderboard.consumePending(careerKey(s.playerId, s.name, false));
    p.bombs = START_BOMBS + pending.bombs;
    p.radius = START_RADIUS + pending.fire;
    p.speed = pending.speed;
    p.shields = pending.shield;
    p.staminaLevel = pending.stim;
    p.stamina = staminaMaxFor(p);
    p.tired = false;
  }

  // ─── kill streaks ───────────────────────────────────────────────────────────

  /**
   * An ACE is the whole room, by one person, in one streak.
   *
   * Precisely: at the instant of this kill the killer is alive, every other occupied seat is dead,
   * every one of those seats was killed by this player inside the current streak, and there were
   * at least three of them. Respawning is a key press away and a corpse is only on the floor for a
   * second, so "everyone else down at once" is a genuinely hard thing to arrange - which is the
   * point. A streak that scores an ACE then starts its victim list again, so the next one needs
   * another full sweep rather than one more kill while the room happens to still be empty.
   */
  function isAce(seat, st) {
    if (st.victims.size < ACE_MIN_VICTIMS) return false;
    if (!state.players[seat]?.alive) return false;
    for (let i = 0; i < maxPlayers; i++) {
      if (i === seat || !seats[i]) continue;
      if (state.players[i]?.alive) return false;      // somebody is still standing
      if (!st.victims.has(i)) return false;           // down, but not by this player's hand
    }
    return true;
  }

  /**
   * Read this tick's `died` events and escalate or reset.
   *
   * Streak count is authoritative simulation state; the room keeps only the victim set needed
   * for ACE announcements.
   */
  function trackStreaks(from) {
    for (let n = from; n < state.events.length; n++) {
      const e = state.events[n];
      if (e.e !== 'died') continue;

      // Dying ends your own streak, whoever ended it. A suicide is only ever a death.
      const died = streaks[e.i];
      if (died) died.victims.clear();
      if (e.by === e.i) continue;

      const st = streaks[e.by];
      const killer = state.players[e.by];
      if (!st || !killer) continue;

      const count = e.streak ?? killer.streakCount;
      if (count <= 1) st.victims.clear();
      st.victims.add(e.i);

      /* `n` is the rung, and it rides along so the client never has to parse `kind`.
       *
       * Everything on the client that escalates with a streak - the size of the type, the chord,
       * how fast the rainbow pours through the letters - was reading the KIND STRING and matching
       * prefixes against it. That makes the announcement's wording part of the protocol: rename
       * "ULTRA KILL" and three unrelated effects quietly drop to their lowest setting. The number
       * is the fact; the words are a label for it.
       */
      if (isAce(e.by, st)) {
        st.victims.clear();
        onBroadcast({ t: 'streak', i: e.by, name: killer.name, kind: STREAK_ACE, ace: true, n: 6 });
      } else if (count >= 2) {
        const n = Math.min(count, 5);
        onBroadcast({ t: 'streak', i: e.by, name: killer.name, kind: STREAK_NAMES[n], ace: false, n });
      }
    }
  }

  // ─── the tick ───────────────────────────────────────────────────────────────

  function tick() {
    if (between) return;
    const t0 = performance.now();
    const inputs = new Array(maxPlayers).fill(0);

    /* The count-in. Nobody moves, and that includes the brains.
     *
     * The simulation still runs - the tick advances, snapshots go out, the clock stays honest and
     * a client that joins mid-count sees the board and the remaining digits - but every input is
     * zero, so nothing can walk and nothing can be placed. Freezing by zeroing the INPUTS rather
     * than by skipping the tick is what keeps it simple: there is no second code path through the
     * simulation, no state that only exists during a count-in, and the client's clock never
     * stalls. See COUNT_IN_TICKS.
     *
     * Bots are frozen by not being asked to think. A bot that thought while frozen would spend
     * the whole count-in deciding, and arrive on the first live tick with a plan made five
     * seconds ago - which is both wrong and unfair in the same direction.
     */
    const counting = state.tick < countIn;

    // Computed once per tick and shared by every bot - it is the same answer for all of them.
    const danger = !counting && seats.some(s => s?.isBot) ? dangerMap(state) : null;

    for (let i = 0; i < maxPlayers; i++) {
      const s = seats[i];
      if (!s) continue;
      if (s.isBot) {
        const planned = counting ? 0 : think(state, state.players[i], s.brain, danger);
        inputs[i] = delayBotInput(s.brain, planned, { frozen: counting });
        s.lastAckTick = state.tick;
        continue;
      }
      if (s.connected) humanThisRound = true;
      if (s.inputs.has(state.tick)) {
        s.mask = s.inputs.get(state.tick);
        s.inputs.delete(state.tick);
      }
      // Missing input repeats the last mask. A dropped packet should not make you stutter.
      s.lastAckTick = state.tick;
      inputs[i] = counting ? 0 : s.mask;
      /* And the idle clock does not run during the count-in.
       *
       * A client is told not to send inputs while the board is frozen (see the loop in
       * client/main.js), so five seconds of correct silence would otherwise count against the
       * idle timer - and on a long enough count-in, join the round and be kicked from it.
       */
      if (counting) s.lastInputAt = state.tick;

      if (!s.connected && state.tick - s.goneSince > graceTicks) release(i);

      // Connected but silent. A playing client sends an input every tick, including a mask of
      // zero while standing still, so silence means the tab is backgrounded, frozen or on a
      // sleeping laptop - not that somebody is thinking. Give the seat back: sixteen is a hard
      // cap, and a seat held by a closed lid is a person who cannot join.
      else if (s.connected && !s.isBot &&
               state.tick - (s.lastInputAt ?? state.tick) > IDLE_KICK_TICKS) {
        onBroadcast({ t: 'chat', i: -1, name: 'SERVER', msg: `${s.name} left (idle)` });
        onKick?.(i, 'idle');
        release(i);
      }
    }

    // Where the new events start, so the streak scan reads only this tick's deaths. Events linger
    // for two ticks because snapshots do, so the length before the step is the only safe cursor.
    const evFrom = state.events.length;
    placeRequestedRespawns();
    placeArrivals();
    simTick(state, inputs, { onRespawn: startRespawnCountdown });
    trackStreaks(evFrom);
    for (let i = evFrom; i < state.events.length; i++) {
      botEmoter.react(state.events[i], seats, state.tick);
    }

    const ms = performance.now() - t0;
    tickTimes.push(ms);
    if (tickTimes.length > 300) tickTimes.shift();
    if (ms > 20) console.warn(`slow tick: ${ms.toFixed(1)}ms at ${state.tick}`);

    if (state.tick % TICK_HZ === 0) emitScores();
    // Bank everyone's progress every ten seconds, not only at round end and on leaving. Banking is
    // by delta, so doing it often costs nothing and double-counts nothing - and the most a crash
    // can now take from anybody is ten seconds of play rather than the round so far.
    if (state.tick % (10 * TICK_HZ) === 0) bankScores();

    // Events accumulate until a snapshot actually carries them.
    //
    // This used to clear them every tick while snapshots go out every *second* tick, which threw
    // half of every event away. It cost: deaths that never showed a death screen or a kill-feed
    // line, so bombs looked like they did no damage; blocks that broke on the server and stayed
    // drawn here; and - worst - every single `blocknew`, because wall regrowth lands on tick
    // 600, 1200, 1800, always even. Clients never heard about a regenerated wall, so prediction
    // happily walked straight through it. That is the "I clip through walls" bug.
    if (state.tick % SNAP_EVERY_TICKS === 0) {
      emitSnapshot();
      state.events.length = 0;
    } else if (state.events.length > 1024) {
      state.events.length = 0;      // nobody listening; do not grow without bound
    }

    // The whistle, pushed out by the count-in so the round is a full `roundTicks` of PLAY. Must
    // agree with `roundEndsAtTick` in the welcome, or the clock on screen lies.
    if (state.tick >= roundTicks + countIn) endRound();
  }

  /**
   * End of round: bank everyone's score into the leaderboard, show the standings, then start
   * the next map. The simulation is paused during the intermission - people deserve to read
   * the scoreboard without being blown up behind it.
   */
  function endRound() {
    between = true;
    const standings = state.players
      .filter(Boolean)
      // `gl`: the one the gulls picked. The standings are what the round-over table and the
      // after-game card both read, so the bird follows them onto both without a second path.
      .map(p => ({ i: p.i, name: p.name, s: p.score, k: p.kills, d: p.deaths,
        ...(p.gulled ? { gl: 1 } : null) }))
      .sort((a, b) => b.s - a.s || b.k - a.k);
    intermissionStandings = standings;
    intermissionDeadline = performance.now() + ROUND_INTERMISSION_MS;

    // Survivors are paid BEFORE the banking, not after. The bonus used to be added on the line
    // below the write, so it was computed, displayed for twenty seconds, and then thrown away
    // when the round reset - fifty points that never once reached anybody's total.
    for (const p of state.players) if (p?.alive) p.score += SCORE.SURVIVE_ROUND;
    bankScores();
    awardMedals(standings);
    leaderboard?.flush();
    retireIdleBots();

    onBroadcast({
      t: 'roundend',
      winner: standings[0]?.i ?? -1,
      standings,
      nextMap: MAPS[(mapIndex + 1) % MAPS.length].id,
      startsInMs: ROUND_INTERMISSION_MS,
    });
    // Keep the handle. /restart and /map both install a fresh state, and a forgotten timer then
    // fired against the round that had already replaced the one it was waiting for.
    roundTimer = setTimeout(startNextRound, ROUND_INTERMISSION_MS);
    roundTimer.unref?.();
  }

  /**
   * Gold, silver and bronze for the top three, into everybody's lifetime stats.
   *
   * From the same `standings` the round-over table shows, so the medal you are given is the one
   * you were looking at. Two rules stop a medal meaning nothing:
   *
   *   - a place only pays if somebody finished BELOW it - gold needs two players, silver three,
   *     bronze four. Last is never on the podium, so a two-player round is a gold, not a gold
   *     and a silver for turning up.
   *   - a finish on zero points wins nothing. A round that nobody scored in has no podium.
   *
   * Ties go the way the table sorts them (score, then kills), which is also what was shown.
   */
  function awardMedals(standings) {
    if (!leaderboard) return;
    for (let place = 0; place < 3 && place < standings.length - 1; place++) {
      const st = standings[place];
      const seat = seats[st.i];
      if (!seat || st.s <= 0) continue;
      leaderboard.award(careerKey(seat.playerId, seat.name, seat.isBot), place, st.name);
    }
  }

  function cancelIntermission() {
    if (roundTimer) clearTimeout(roundTimer);
    roundTimer = null;
    intermissionDeadline = 0;
    intermissionStandings = [];
  }

  /**
   * Install a fresh state on `index`, keeping everyone seated, and tell the clients.
   *
   * One helper, two callers. There used to be two copies of this - startNextRound and
   * restartRound, identical apart from the map - and the seat-carrying bug below existed in both
   * precisely because it had to be fixed twice.
   *
   * The thing that has to happen here: a fresh `createState` restarts the tick at 0, so every
   * seat field measured in ticks has to come back to 0 with it. A carried `goneSince` of 20 000
   * can never satisfy `state.tick - goneSince > graceTicks` again, so a reserved seat was never
   * recycled and never banked - it leaked for the lifetime of the process. A carried `lastAckTick`
   * is just as bad in the other direction: `input()` drops anything `<= lastAckTick`, so a client
   * would be silently unable to move for the first 28 800 ticks of the new round.
   */
  function resetRound(index) {
    cancelIntermission();
    mapIndex = index;
    // `banked` is cleared with the rest: scores restart at zero, so the high-water mark has to
    // as well or the next bank would compute a negative delta and the board would ignore it.
    const carried = seats.map(s =>
      (s ? { ...s, inputs: new Map(), mask: 0, goneSince: 0, lastAckTick: 0, lastInputAt: 0,
             resumeLoadout: null, banked: null } : null));
    state = createState(MAPS[mapIndex]);
    // The only thing the simulation is told about the clock, and only the gull raid reads it:
    // see GULL_RAID_AT_MIN. Everything else that cares about the end of the round is up here.
    state.roundTicks = roundTicks + countIn;
    for (let i = 0; i < maxPlayers; i++) {
      seats[i] = carried[i];
      streaks[i] = newStreak();
      if (!carried[i]) continue;
      const p = createPlayer(i, carried[i].name);
      // Carried across the round boundary with the seat; see setBots.
      if (carried[i].isBot) p.isBot = true;
      state.players[i] = p;
      if (carried[i].firstSpawnPending) p.respawnAt = state.tick;
      else respawn(p);
    }
    // The one moment colours may move: nobody is mid-fight, and the welcome below repaints all.
    settleColours();
    between = false;
    nextDeadline = performance.now() + tickMs();
    onBroadcast(seat => welcomeFor(seat));
  }

  const startNextRound = () => {
    roundTimer = null;
    resetRound((mapIndex + 1) % MAPS.length);
  };

  // ─── snapshots ──────────────────────────────────────────────────────────────

  const playerWire = p => ({
    i: p.i, x: p.x, y: p.y, d: p.dir, st: p.alive ? 1 : 0,
    b: p.bombs, f: p.radius, sp: p.speed, sh: p.shields,
    // Health: whole or half. Only sent when it is not whole, which is the rare case.
    ...(p.alive && p.hp < MAX_HP ? { hp: p.hp } : null),
    // Arriving, not dead: lifted off the board briefly after a living reconnect. See holdArrival.
    ...(p.arriving ? { ar: 1, art: p.arriveAt } : null),
    ...(p.respawnRequested
      ? { rr: Math.max(0, p.respawnCountdownAt - state.tick) }
      : null),
    s: p.score, k: p.kills, dd: p.deaths, stat: p.status,
    sk: p.streakCount || 0, skt: p.streakLastKillTick ?? -1,
    // Coins. One small integer that only ever goes up, and the only stat on the wire that is
    // not about this round - it is what the HUD counter reads. `c`, not `g`: `gold` on the
    // leaderboard means a first-place finish.
    c: p.coins || 0,
    // Stamina rides along because the indicator is drawn beside EVERY player, not just you:
    // seeing that the pirate chasing you is limping is the whole point of showing it at all.
    sta: p.stamina, stl: p.staminaLevel, tr: p.tired ? 1 : 0,
    // Only while sliding on water, which is almost never - absent means zero.
    ...(p.slide ? { sl: p.slide } : null),
    /* The deliberate slide. Three fields, and all three only while one is actually running or
     * cooling down - which is the overwhelming majority of ticks omitted for everybody.
     *
     * `sv` is the live velocity, and the renderer needs it for the dust and the streaks; the
     * other two are what prediction has to start its replay from, or your own slide would be
     * re-launched or cut short every time a snapshot landed mid-slide. */
    ...(p.slideV ? { sv: p.slideV, sd: p.slideDir, sf: p.slideFor } : null),
    ...(p.slideCool ? { sc: p.slideCool } : null),
    /* The buffered turn, while there is one. See the RAILS note in shared/sim/movement.js.
     *
     * It has to be here even though it is derived from inputs the client also has, because
     * prediction REPLAYS pending inputs from a snapshot: the replay starts from whatever the
     * snapshot says, and a turn the server was holding that the snapshot never mentioned is a
     * divergence that stays invisible until the next corner and then shows up as the pirate
     * turning where the other machine did not.
     *
     * Absent means none, which is why `tw` is only sent alongside a live budget - DIR_R is 0, so
     * a bare `tw` could not distinguish "turn right" from "nothing". */
    ...(p.turnLeft > 0 ? { tw: p.turnWant, tl: p.turnLeft } : null),
    // Claimed by the gull raid. One player a round at most, so it is absent for everybody nearly
    // always - and it has to be in the snapshot, not only in the event, or a client that joined
    // after the raid would have no idea why the table says what it says.
    ...(p.gulled ? { gl: 1 } : null),
  });

  function emitSnapshot() {
    const players = [];
    for (const p of state.players) if (p) players.push(playerWire(p));
    const ev = state.events.slice();
    const gullsWire = state.gulls.map(gullWire);
    const pal = coloursWire();
    onBroadcast(seat => ({
      t: 'snap',
      tick: state.tick,
      ack: seats[seat]?.lastAckTick ?? 0,
      players,
      // Who is what colour, in every snapshot: sixteen characters, and a joiner must never be
      // drawn in a colour they do not have for even one frame. See COLOUR_PREFERENCE.
      pal,
      bombs: state.bombs,
      perks: state.perks,
      // In the snapshot rather than derived from `melt` events: movement prediction reads them,
      // and a client that joined mid-puddle or missed a snapshot must still agree with us.
      puddles: state.puddles,
      // Descriptions, not positions: a client draws the whole flight from its own clock. Absent
      // when the sky is empty, which is most of the time.
      ...(gullsWire.length ? { gulls: gullsWire } : null),
      ev,
    }));
  }

  /**
   * Lifetime rank, once a second.
   *
   * Deliberately NOT in the snapshot: rank changes a handful of times an hour and the snapshot
   * goes out fifteen times a second, so putting a rank name in there would spend most of the
   * bandwidth on a string that never changes. The round score in the snapshot is the live number;
   * this is the career one.
   *
   * It is the round score *plus* what is already banked, because the board is only written on
   * disconnect and at the end of a round - without the addition your rank would visibly refuse to
   * move for sixteen minutes while you earned it.
   */
  function emitScores() {
    if (!leaderboard) return;
    const ranks = [];
    for (let i = 0; i < maxPlayers; i++) {
      const s = seats[i], p = state.players[i];
      if (!s || !p) continue;
      const banked = leaderboard.get(careerKey(s.playerId, s.name, s.isBot));
      // Only the part of this round that has NOT been written yet, or a mid-round bank would
      // count the same points twice and the bar would jump.
      const unbanked = Math.max(0, p.score) - (s.banked?.score ?? 0);
      const lifetime = (banked?.score ?? 0) + Math.max(0, unbanked);
      const unbankedKills = p.kills - (s.banked?.kills ?? 0);
      const unbankedDeaths = p.deaths - (s.banked?.deaths ?? 0);
      const unbankedCoins = (p.coins || 0) - (s.banked?.coins ?? 0);
      // The name rides along because nothing else refreshes it. The snapshot leaves names out
      // on purpose - fifteen a second of a string that changes once per join is most of the
      // bandwidth - so a client that misses the welcome, or hydrates a seat from a snapshot
      // that arrived first, is stuck calling somebody "p1" for the rest of the round. Once a
      // second it heals itself.
      // Lifetime podium finishes, gold / silver / bronze, for the stats card and the TAB board.
      const medals = [banked?.gold ?? 0, banked?.silver ?? 0, banked?.bronze ?? 0];
      ranks.push({
        i, name: p.name, bot: !!s.isBot, medals,
        lifeKills: (banked?.kills ?? 0) + Math.max(0, unbankedKills),
        lifeDeaths: (banked?.deaths ?? 0) + Math.max(0, unbankedDeaths),
        lifeCoins: (banked?.coins ?? 0) + Math.max(0, unbankedCoins),
        wallet: s.isBot ? 0 : (leaderboard.economy(
          careerKey(s.playerId, s.name, false))?.wallet ?? 0) + Math.max(0, unbankedCoins),
        ...progressFor(lifetime),
      });
    }
    /* `owner` is the seat that owns the server, where one is sitting.
     *
     * Not a privilege on the wire - every owner-gated command is checked server-side and always
     * will be (see isOwner in server/net.js). It is here so the client can show the OWNER the
     * server's own vitals and show nobody else a number they cannot act on.
     */
    const owner = state.players.findIndex((p, i) => p && isAdminSeat(i));
    onBroadcast({ t: 'scores', ranks, host: hostSeat(), owner, top: leaderboard.top(5) });
  }

  const welcomePayloadBase = () => ({
    t: 'mapchange',
    map: {
      id: state.map.id, name: state.map.name, w: state.map.w, h: state.map.h,
      cells: encodeCells(state.map.cells), spawns: state.map.spawns,
    },
  });

  function welcomeFor(seat) {
    const players = [];
    for (const p of state.players) if (p) players.push({ ...playerWire(p), name: p.name, c: p.i });
    return {
      t: 'welcome',
      you: seat,
      // Every welcome carries the resume token, not just the one sent on `hello`. A round restart
      // broadcasts welcomes too, and without this the client stored `undefined` over its real id
      // and came back after the next drop claiming a seat under the literal string "undefined" -
      // which two clients would then fight over.
      playerId: seats[seat]?.playerId ?? null,
      tick: state.tick,
      // Pushed out by the count-in, so a ten-minute round is ten minutes of PLAY. The client's
      // clock counts down to this, so it is also what stops the bar reading 9:55 at the whistle.
      roundEndsAtTick: roundTicks + countIn,
      // When the freeze lifts. The client stops predicting and sending until this tick, and
      // draws the count-in down to it; see COUNT_IN_TICKS.
      startsAtTick: countIn,
      // A reconnect during the intermission must not be mistaken for the next round starting.
      between,
      ...(between ? {
        intermissionMs: Math.max(0, Math.ceil(intermissionDeadline - performance.now())),
        standings: intermissionStandings.map(p => ({ ...p })),
        nextMap: MAPS[(mapIndex + 1) % MAPS.length].id,
      } : null),
      color: paletteColor(seats[seat]?.colour ?? seat),
      pal: coloursWire(),
      map: welcomePayloadBase().map,
      players,
      bombs: state.bombs,
      perks: state.perks,
      puddles: state.puddles,
      gulls: state.gulls.map(gullWire),
      // Every rule constant the client needs, so a server tuning change needs no client deploy.
      config: {
        tickHz: TICK_HZ, snapEvery: SNAP_EVERY_TICKS, tileSize: TILE_PX,
        unitsPerTile: UNITS_PER_TILE, maxPlayers, fuseTicks: FUSE_TICKS, fireTicks: FIRE_TICKS,
        // Percent of real time the ticks are being issued at. `tickHz` is still the tick's
        // meaning; this is how fast they arrive, so a client can scale its own clock by it.
        gamespeed,
      },
    };
  }

  // ─── loop ───────────────────────────────────────────────────────────────────

  function start() {
    if (timer) return;
    const step = tickMs();
    nextDeadline = performance.now() + step;
    timer = setInterval(() => {
      const now = performance.now();
      // Absolute deadlines, so the tick rate does not drift. Capped catch-up, so a long GC pause
      // cannot trigger a storm of ticks that makes everyone teleport. Both still hold at any
      // gamespeed - the deadline spacing is the only thing that changes.
      let guard = 0;
      while (now >= nextDeadline && guard < 3) {
        tick();
        nextDeadline += step;
        guard++;
      }
      if (now > nextDeadline + step * 10) nextDeadline = now + step;        // way behind: resync
    }, Math.max(1, Math.floor(step / 2)));
  }

  function stop() {
    clearInterval(timer);
    timer = null;
    cancelIntermission();
  }

  const stats = () => {
    const sorted = [...tickTimes].sort((a, b) => a - b);
    return {
      tick: state.tick,
      map: state.map.id,
      players: seats.filter(s => s && s.connected).length,
      reserved: seats.filter(s => s && !s.connected).length,
      bots: botCount(),
      autoBots,
      gamespeed,
      tickMsP50: +(sorted[sorted.length >> 1] || 0).toFixed(2),
      tickMsP99: +(sorted[Math.floor(sorted.length * 0.99)] || 0).toFixed(2),
    };
  };

  // ─── bots and admin ─────────────────────────────────────────────────────────

  /**
   * Who is in charge.
   *
   * The admin whenever they are connected (the seat that joined with the admin key, or with
   * `adminName` where no key is configured), and otherwise the longest-standing human - the
   * lowest occupied seat, which is the first person who joined and has not left. A room always
   * has exactly one host while anybody is in it, and losing one promotes the next without
   * anybody having to do anything.
   */
  function hostSeat() {
    let admin = -1, first = -1;
    for (let i = 0; i < maxPlayers; i++) {
      const s = seats[i];
      if (!s || s.isBot || !s.connected) continue;
      if (first < 0) first = i;
      if (s.admin || (adminName && (s.name ?? '').toLowerCase() === adminName)) { admin = i; break; }
    }
    return admin >= 0 ? admin : first;
  }

  const botCount = () => seats.filter(s => s?.isBot).length;

  /**
   * Make the number of bots exactly n, adding or removing from the end.
   *
   * @param byHand a host typed this. Asking for FEWER bots than there are switches the
   *   automatic top-up off, for the same reason a /kick of one does - see kickSeat.
   */
  function setBots(n, { byHand = false } = {}) {
    n = Math.max(0, Math.min(maxPlayers - 1, n | 0));   // never fill the last human seat
    if (byHand && n < botCount()) autoBots = false;
    while (botCount() > n) {
      const seat = seats.findLastIndex(s => s?.isBot);
      if (seat < 0) break;
      clearSeat(seat);
      // No hand-rolled snapshot here. One without an `ack` made every client replay its whole
      // unacknowledged input queue on top of the server position, which rubber-banded everyone
      // forward. The next real snapshot drops the seat anyway - applySnap removes whoever is
      // missing from it.
    }
    while (botCount() < n) {
      const seat = seats.findIndex(s => s === null);
      if (seat < 0) break;
      const name = botName();
      seats[seat] = {
        playerId: `bot_${seat}`, name, mask: 0, inputs: new Map(), lastAckTick: 0,
        connected: true, goneSince: 0, isBot: true, brain: createBrain(), addedAt: ++botSeq,
        colour: pickColour(seat),
      };
      streaks[seat] = newStreak();
      const p = createPlayer(seat, name);
      // The one thing the simulation is told about brains: gulls will not fall to a bot's fire.
      // See gulls.js. Never on the wire and never in hashState, so prediction is unaffected -
      // the client does not run the gulls at all.
      p.isBot = true;
      state.players[seat] = p;
      respawn(p);
    }
    return botCount();
  }

  /**
   * A name for a new bot: a person's name, picked at random from BOT_NAMES and never one already
   * in the room, bot or human. "bot-7" told everybody exactly which pirates were not worth
   * worrying about; the robot beside the name on the scoreboard still says it, for anyone who
   * looks. Falls back to the old numbering only if all twenty-eight are somehow taken.
   */
  function botName() {
    const taken = new Set(seats.filter(Boolean).map(s => s.name.toLowerCase()));
    const free = BOT_NAMES.filter(n => !taken.has(n.toLowerCase()));
    if (!free.length) return `bot-${botSeq + 1}`;
    return free[(Math.random() * free.length) | 0];
  }

  /** Somebody arrived: make sure there is a fight waiting for them. See AUTO_BOTS_MIN. */
  function topUpBots() {
    humanThisRound = true;
    if (!autoBots || botCount() >= minBots) return;
    const had = botCount();
    const got = setBots(minBots);
    if (got > had) {
      onBroadcast({ t: 'chat', i: -1, name: 'SERVER',
        msg: `${got - had} bot${got - had === 1 ? '' : 's'} joined the crew` });
    }
  }

  /**
   * ZA retires bots after AUTO_BOTS_EMPTY_ROUNDS empty rounds. US keeps its configured complement
   * ready while idle, restoring the target at round end if a bot was removed.
   */
  function retireIdleBots() {
    const hadHuman = humanThisRound;
    humanThisRound = false;
    if (regionId === 'us') {
      emptyRounds = 0;
      if (minBots > 0) {
        autoBots = true;
        if (botCount() < minBots) setBots(minBots);
      }
      return;
    }

    emptyRounds = hadHuman ? 0 : emptyRounds + 1;
    if (!minBots || emptyRounds < AUTO_BOTS_EMPTY_ROUNDS) return;
    if (botCount()) {
      setBots(0);
      console.log(`bots   none of them had anyone to play with for ${emptyRounds} rounds; removed`);
    }
    autoBots = true;
  }

  /** Start the round over on the same map, keeping everyone seated. */
  const restartRound = () => resetRound(mapIndex);

  /** Switch map immediately, which is a round restart on a different map. */
  function setMap(index) {
    const i = (index | 0);
    if (i < 0 || i >= MAPS.length) return null;
    resetRound(i);
    return MAPS[i].id;
  }

  /**
   * Percent of the real-time tick rate: 200 runs the clock twice as fast, 50 half as fast.
   *
   * What changes is the wall-clock interval between ticks, never the tick's meaning. A tick stays
   * 1/30 s of simulated time, because the client predicts its own movement by running the same
   * `step()` once per tick and derives explosions from a bomb's `at` tick - redefining the tick
   * would desync every one of those. The poller period is re-derived too, because an interval
   * fixed at half of 33 ms cannot deliver a tick every 16 ms at 200 %.
   */
  function setGameSpeed(pct) {
    const n = Math.round(Number(pct));
    if (!Number.isFinite(n) || n < GAMESPEED_MIN || n > GAMESPEED_MAX) return null;
    gamespeed = n;
    if (timer) { stop(); start(); }
    onBroadcast({ t: 'gamespeed', pct: gamespeed });
    return gamespeed;
  }

  /**
   * Write what everybody has earned SINCE THE LAST TIME this ran, and remember where we got to.
   *
   * Deltas, not totals, because this has to be safe to call repeatedly. The leaderboard adds
   * what it is given, so banking a running total twice would double somebody's afternoon.
   *
   * It exists because the only two places that used to write were "round over" and "player
   * disconnected", and a server restart is neither. Deploys happen several times an hour on a
   * build day, rounds last ten minutes, and everybody still connected lost everything since the
   * last round boundary every single time. The file was never the problem - nothing was asking
   * it to save.
   */
  function bankSeat(i) {
    if (!leaderboard) return;
    const s = seats[i], p = state.players[i];
    if (!s || !p) return;
    const was = s.banked ?? { score: 0, kills: 0, deaths: 0, coins: 0 };
    const now = {
      score: Math.max(0, p.score), kills: p.kills, deaths: p.deaths, coins: p.coins || 0,
    };
    if (now.score === was.score && now.kills === was.kills
        && now.deaths === was.deaths && now.coins === was.coins) return;
    leaderboard.record(careerKey(s.playerId, s.name, s.isBot), {
      name: p.name,
      score: now.score - was.score,
      kills: now.kills - was.kills,
      deaths: now.deaths - was.deaths,
      coins: now.coins - (was.coins || 0),
    });
    s.banked = now;
  }

  function bankScores() {
    if (!leaderboard) return;
    for (let i = 0; i < maxPlayers; i++) bankSeat(i);
  }

  const shopEnvelope = (seat, extra = {}) => {
    const s = seats[seat];
    if (!leaderboard || !s || s.isBot) {
      return { t: 'shop', ok: false, why: 'shop unavailable', wallet: 0,
        pending: emptyShopQueue(), ...extra };
    }
    const economy = leaderboard.economy(careerKey(s.playerId, s.name, false));
    return { t: 'shop', ok: true, wallet: economy?.wallet ?? 0,
      pending: economy?.pending ?? emptyShopQueue(), ...extra };
  };

  function shopState(seat) {
    return shopEnvelope(seat);
  }

  function buyShop(seat, itemKey) {
    const s = seats[seat], p = state.players[seat];
    if (!leaderboard || !s || !p || !s.connected || s.isBot) return shopEnvelope(seat);
    if (!between && p.alive) return shopEnvelope(seat, { ok: false, why: 'shop is closed' });
    bankSeat(seat);
    const result = leaderboard.buy(careerKey(s.playerId, s.name, false), itemKey);
    if (result && typeof result.then === 'function') {
      return result.then(purchase => ({ t: 'shop', ...purchase }));
    }
    return { t: 'shop', ...result };
  }

  /**
   * Round length, in minutes, to a tenth.
   *
   * Changing it takes effect immediately rather than at the next round: the host asking for a
   * shorter round almost always means "this one is dragging". If the new length is already past,
   * the round ends on the next tick, which is the honest reading of the request.
   *
   * Everyone is told the new deadline, because the clock in the bar is driven from it and a
   * client that missed the change would count down to the wrong number.
   */
  function setRoundTime(minutes) {
    const m = Math.round(Number(minutes) * 10) / 10;
    if (!Number.isFinite(m) || m < ROUNDTIME_MIN_MIN || m > ROUNDTIME_MAX_MIN) return null;
    roundTicks = Math.max(1, Math.round(m * 60 * TICK_HZ));
    // A shorter round moves the raid with it, unless the birds have already gone.
    state.roundTicks = roundTicks + countIn;
    if (state.raidAt > 0) state.raidAt = 0;
    onBroadcast({ t: 'roundtime', endsAtTick: roundTicks, minutes: m });
    return m;
  }

  /** Permanent invulnerability, on the body in front of us. */
  function grantGod(p) {
    p.god = true;
    applyStatus(state, p, STATUS.INVULN, 1e9);
  }

  /* Toggle permanent invulnerability.
   *
   * The flag is kept on the SEAT, which survives a death, a round end and a map change; the
   * player object does not. It used to live on the player alone, so godmode lasted exactly
   * until the next round began and then went off without a word. `respawn` reads the seat and
   * puts it back on whatever body it has just built.
   */
  function toggleGod(seat) {
    const s = seats[seat];
    const p = state.players[seat];
    if (!s || !p) return false;
    const on = !s.god;
    s.god = on;
    if (on) grantGod(p);
    else {
      p.god = false;
      p.status &= ~STATUS.INVULN;
      delete p.statusUntil[STATUS.INVULN];
    }
    return on;
  }

  /**
   * Give up the seat and the identity. The score is banked on the way out by `release`, so
   * signing out is not a way to dodge a bad round.
   */
  function logout(seat) {
    if (!seats[seat]) return false;
    release(seat);
    return true;
  }

  function startRespawnCountdown(p) {
    if (!p || p.alive || p.arriving || between ||
        p.respawnRequested || state.tick < p.respawnAt) return;
    const countdownAt = state.tick + RESPAWN_COUNTDOWN_TICKS;
    p.respawnRequested = true;
    p.respawnCountdownAt = countdownAt;
    p.respawnAt = seats[p.i]?.firstSpawnPending
      ? Math.max(countdownAt, countIn)
      : countdownAt;
  }

  /** Pressing SPACE while dead starts the same server-owned countdown as the bomb-key path. */
  function requestRespawn(seat) {
    startRespawnCountdown(state.players[seat]);
  }

  const roundInfo = () => ({ tick: state.tick, endsAt: roundTicks, between, map: state.map.id });

  /**
   * Is this seat the REAL admin - the key-holder, or the configured admin name where no key is
   * set? Not the same question as `hostSeat`, which falls back to the longest-standing player
   * so that a room is never without somebody who can add bots.
   *
   * The dangerous commands check this one. See `isOwner` in server/net.js.
   */
  function isAdminSeat(seat) {
    const s = seats[seat];
    if (!s || s.isBot) return false;
    return !!s.admin || (!!adminName && (s.name ?? '').toLowerCase() === adminName);
  }

  if (regionId === 'us' && minBots > 0) setBots(minBots);

  return {
    start, stop, join, disconnect, input, requestRespawn, welcomeFor, roundInfo, stats,
    shopState, buyShop,
    setBots, botCount, restartRound, toggleGod, logout, hostSeat,
    kickSeat, seatOfName, setMap, setGameSpeed, setRoundTime,
    // Called on the way down, so a deploy does not throw away the round in progress.
    bankScores,
    // Exposed for tests: respawn placement is a rule worth asserting on directly.
    respawn,
    roundMinutes: () => Math.round((roundTicks / TICK_HZ / 60) * 10) / 10,
    isBot: seat => !!seats[seat]?.isBot,
    isAdminSeat,
    /** Whether the room is topping bots up by itself right now. See AUTO_BOTS_MIN. */
    get autoBots() { return autoBots; },
    maps: () => MAPS.map(m => m.id),
    gamespeed: () => gamespeed,
    // Exactly one tick, by hand. The loop calls this; tests call it directly so that behaviour
    // measured in thousands of ticks does not need thousands of ticks of wall clock.
    tick,
    get state() { return state; },
  };
}
