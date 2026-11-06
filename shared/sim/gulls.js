// Seagulls: scenery you can shoot down. See GULL_* in constants.js for the rules and why.
//
// A gull is described, not simulated. It is born with a start, an end, a departure tick and a
// couple of phase offsets, and `gullAt` turns that into a position and an altitude for any tick
// at all - so the snapshot carries the description once and the client draws the flight from its
// own clock, smoothly, with nothing to interpolate and nothing to correct.
//
// Only the SERVER decides a hit. The client never runs `gulls()`; it only draws `gullAt`. That is
// why the flight path is allowed a Math.sin: the one place its answer has rules attached is here,
// in one process, and the drawing only has to agree with it to within a pixel.

import {
  UNITS_PER_TILE, BLOCK, PERK, FIRE_TICKS, FIRE_LETHAL_TICKS, GULL_GAP_MIN_TICKS, GULL_GAP_MAX_TICKS, GULL_MAX, GULL_SPEED_UNITS,
  GULL_OFFMAP_TILES, GULL_WEAVE_UNITS, GULL_WEAVE_TICKS, GULL_DIVE_EVERY_TICKS, GULL_DIVE_TICKS,
  GULL_LOITER, GULL_COINS, GULL_DEPTH_MIN, GULL_DEPTH_MAX, SCORE,
  GULL_RAID_AT_MIN, GULL_RAID_AT_MAX, GULL_RAID_LATE_JOIN_FRACTION,
  GULL_RAID_SPEED_UNITS, GULL_RAID_RUN_TILES,
  GULL_RAID_RETRY_TICKS, RESPAWN_DELAY_TICKS, START_BOMBS, START_RADIUS, GULL_RAID_COINS,
} from '../constants.js';
import { tileAt } from './state.js';
import { drop, scatterOnDeath } from './perks.js';
import { randInt } from '../util/rng.js';

const TAU = Math.PI * 2;

/**
 * Height above the board, 1 cruising and 0 at the bottom of a dive.
 *
 * A dive is half a sine turned upside down: it drops away smoothly, bottoms out and climbs back,
 * with no corner anywhere in it - a gull that changed height in steps would read as a sprite
 * being swapped.
 */
export function gullAltitude(g, tick) {
  // A raid is one long dive: high at both ends of the run, on the deck where the two cross.
  if (g.raid) {
    const t = Math.max(0, Math.min(1, (tick - g.t0) / g.dur));
    return Math.min(1, Math.abs(t * 2 - 1) * 1.7);
  }
  const phase = ((tick - g.t0 + g.dive) % GULL_DIVE_EVERY_TICKS + GULL_DIVE_EVERY_TICKS)
    % GULL_DIVE_EVERY_TICKS;
  if (phase >= GULL_DIVE_TICKS) return 1;
  return 1 - Math.sin((phase / GULL_DIVE_TICKS) * Math.PI);
}

/**
 * Where a gull is at a tick, in sim units, and how high. Fractional ticks are fine - the
 * renderer passes them, so the flight is as smooth as the frame rate.
 */
export function gullAt(g, tick) {
  const age = tick - g.t0;
  const t = Math.max(0, Math.min(1, age / g.dur));
  // Eased, not linear: slow across the middle of the line, which is the part over the board. See
  // GULL_LOITER. Both ends are untouched, so the flight still starts and finishes where it says.
  // A raid runs flat out - the loiter is what makes a cruising bird dawdle over the island, and
  // dawdling is the opposite of what two birds doing eighty are up to. Both halves are still
  // symmetric about the middle of the line, which is where the victim is standing.
  const f = g.raid ? t : t + (GULL_LOITER / TAU) * Math.sin(TAU * t);
  const ex = g.x1 - g.x0, ey = g.y1 - g.y0;
  const len = Math.hypot(ex, ey) || 1;
  // The weave is across the line of flight, so the bird wanders without ever changing course.
  // A raid has none: the whole point is that the line it is on ends at somebody, and a bird
  // that wanders would cross over empty sand half a tile away from the victim.
  const w = g.raid ? 0 : Math.sin(((age + g.weave) / GULL_WEAVE_TICKS) * TAU) * GULL_WEAVE_UNITS;
  return {
    x: g.x0 + ex * f - (ey / len) * w,
    y: g.y0 + ey * f + (ex / len) * w,
    alt: gullAltitude(g, tick),
  };
}

/** A new gull, entering on one side of the map and leaving by the opposite one. */
function spawn(state) {
  const next = state.gullNext;
  const { w, h } = state.map;
  const T = UNITS_PER_TILE, M = GULL_OFFMAP_TILES * T;
  const W = w * T, H = h * T;
  // Somewhere along the middle half of each edge, so the flight always crosses the island
  // rather than clipping a corner of the sea.
  const along = n => (n * (0.25 + 0.5 * next())) | 0;
  const side = randInt(next, 4);                  // 0 from the left, 1 top, 2 right, 3 bottom
  let x0, y0, x1, y1;
  if (side === 0) { x0 = -M; y0 = along(H); x1 = W + M; y1 = along(H); }
  else if (side === 2) { x0 = W + M; y0 = along(H); x1 = -M; y1 = along(H); }
  else if (side === 1) { x0 = along(W); y0 = -M; x1 = along(W); y1 = H + M; }
  else { x0 = along(W); y0 = H + M; x1 = along(W); y1 = -M; }

  // How high this one flies. The renderer turns it into size, shadow reach and haze; here it
  // only stretches the flight, because a bird further away looks slower. See GULL_DEPTH_MIN.
  const depth = GULL_DEPTH_MIN + (GULL_DEPTH_MAX - GULL_DEPTH_MIN) * next();

  const g = {
    id: state.nextGullId++,
    x0, y0, x1, y1,
    hi: Math.round(depth * 100) / 100,   // two decimals: it rides in every snapshot
    t0: state.tick,
    dur: Math.ceil((Math.hypot(x1 - x0, y1 - y0) / GULL_SPEED_UNITS) * depth),
    // Phase offsets, in ticks, so no two gulls weave or dive in step.
    weave: randInt(next, GULL_WEAVE_TICKS),
    // Starting part-way through the cruise rather than in a dive: it should enter high.
    dive: GULL_DIVE_TICKS + randInt(next, GULL_DIVE_EVERY_TICKS - GULL_DIVE_TICKS),
  };
  state.gulls.push(g);
}

/**
 * The raid, in three parts: when, the run itself, and the moment it lands.
 *
 * See GULL_RAID_AT_MIN for why it exists and why it cannot be dodged. The birds are ordinary
 * gull descriptions with `raid` set, which is what gets them the straight line, the flat-out
 * pace and the one long dive - so the client draws the attack with the code it already had.
 */
function scheduleRaid(state) {
  const span = GULL_RAID_AT_MAX - GULL_RAID_AT_MIN;
  state.raidAt = Math.round(state.roundTicks * (GULL_RAID_AT_MIN + span * state.gullNext()));
}

/** Two birds, crossing over one player, arriving together. */
function launchRaid(state, p) {
  const R = GULL_RAID_RUN_TILES * UNITS_PER_TILE;
  const dur = Math.max(2, Math.round((2 * R) / GULL_RAID_SPEED_UNITS));
  // Even, so the crossing lands exactly on a tick rather than between two of them.
  const run = dur + (dur % 2);
  // Perpendicular runs: one along the board, one across it, both centred on the victim. Two
  // birds on the SAME line would arrive nose to nose and read as one bird drawn twice.
  const legs = [[1, 0.35], [-0.35, 1]];
  const dir = state.gullNext() < 0.5 ? 1 : -1;
  for (const [ax, ay] of legs) {
    state.gulls.push({
      id: state.nextGullId++,
      x0: p.x - ax * R * dir, y0: p.y - ay * R * dir,
      x1: p.x + ax * R * dir, y1: p.y + ay * R * dir,
      hi: 0.8,                       // the lowest layer: big, sharp, close
      t0: state.tick,
      dur: run,
      weave: 0,
      dive: 0,
      raid: 1,
    });
  }
  state.raidSeat = p.i;
  state.raidStrike = state.tick + run / 2;
  state.raidAt = -1;
  state.events.push({
    e: 'gullraid', tick: state.tick, seat: p.i, at: state.raidStrike,
    x: Math.round(p.x), y: Math.round(p.y),
  });
}

/** The crossing. Whoever they picked is dead, shields and all, and nobody gets the kill. */
function strikeRaid(state) {
  const p = state.players[state.raidSeat];
  state.raidStrike = 0;
  if (!p) return;

  const alive = !!p.alive;
  p.gulled = true;
  state.gulled = p.i;

  /* The nine coins are for having been CHOSEN, not for being alive at impact.
   *
   * This used to return here without paying when the target had died in the second or two
   * between the launch and the crossing - and the launch is BROADCAST, so the whole room watched
   * the birds commit to them and then saw them get nothing. The consolation is the entire point
   * of a death you are not allowed to dodge; a coin flip on whether it arrives makes it a second
   * piece of bad luck on top of the first.
   */
  p.coins = (p.coins || 0) + GULL_RAID_COINS;
  p.score += SCORE.GOLD * GULL_RAID_COINS;

  // Everything below is a death, and a player who is already dead must not be killed again -
  // in particular `respawnAt` must not be pushed out, which would extend a countdown already
  // running and make dying first strictly worse than being alive for it.
  if (alive) {
    scatterOnDeath(state, p);
    p.alive = false;
    p.deaths++;
    p.hitBy = [];
    p.shieldGrace = 0;
    p.bombs = START_BOMBS;
    p.radius = START_RADIUS;
    p.speed = 0;
    p.shields = 0;                     // a shield is for bombs; this is a bird
    p.status = 0;
    p.statusUntil = {};
    p.respawnAt = state.tick + RESPAWN_DELAY_TICKS;
  }

  state.events.push({
    e: 'gullkill', tick: state.tick, i: p.i, x: Math.round(p.x), y: Math.round(p.y),
    coins: GULL_RAID_COINS,
    // `already` tells the client to pay out without replaying a death on somebody who is lying
    // on the floor watching their respawn counter.
    ...(alive ? null : { already: 1 }),
  });
}

/** The nearest bare floor to a tile, for the coin to land on. Null if there is none close. */
function landing(state, tx, ty) {
  for (let ring = 0; ring <= 3; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const x = tx + dx, y = ty + dy;
        if (tileAt(state.map, x, y) !== BLOCK.FLOOR) continue;
        if (state.perks.some(k => k.tx === x && k.ty === y)) continue;
        return { tx: x, ty: y };
      }
    }
  }
  return null;
}

/* The nearest living person to a point, for a coin that has nowhere to land.
 *
 * People only. Gold is a human prize - `collect` already refuses it to bots, and a salvage route
 * that handed it to one would be the only way a bot could ever end up holding a coin.
 */
function nearestLiving(state, x, y) {
  let best = null, bestD = Infinity;
  for (const p of state.players) {
    if (!p || !p.alive || p.isBot) continue;
    const dx = p.x - x, dy = p.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

/**
 * One tick of gulls: arrivals, departures, and anything caught in a blast.
 *
 * Runs after the fire is laid down for this tick, so a gull diving into a blast on the tick it
 * goes off is hit by it, exactly as a player standing there would be.
 */
export function gulls(state) {
  /* The raid, before the ordinary traffic.
   *
   * Scheduled once the room has told the state how long the round is, launched at that tick
   * against a living person who joined before the late-join cutoff, so it is never a bot or a
   * newcomer caught by the final-70% raid - and landing half a run later.
   */
  if (!state.raidAt && state.roundTicks) scheduleRaid(state);
  if (state.raidAt > 0 && state.tick >= state.raidAt) {
    const joinCutoff = state.roundTicks * GULL_RAID_LATE_JOIN_FRACTION;
    const targets = state.players.filter(p =>
      p && p.alive && !p.isBot && (p.joinedAtTick ?? 0) < joinCutoff);
    if (targets.length) launchRaid(state, targets[randInt(state.gullNext, targets.length)]);
    // Nobody to pick on. Try again shortly, and give up for the round once the window has gone
    // - birds arriving on the whistle would read as a scoring bug.
    else state.raidAt = state.tick + GULL_RAID_RETRY_TICKS > state.roundTicks * GULL_RAID_AT_MAX
      ? -1 : state.tick + GULL_RAID_RETRY_TICKS;
  }
  if (state.raidStrike && state.tick >= state.raidStrike) strikeRaid(state);

  if (state.tick >= state.nextGullAt) {
    if (state.gulls.length < GULL_MAX) spawn(state);
    state.nextGullAt = state.tick + GULL_GAP_MIN_TICKS
      + randInt(state.gullNext, GULL_GAP_MAX_TICKS - GULL_GAP_MIN_TICKS);
  }
  if (!state.gulls.length) return;

  // The same lethal window that kills players: smoke at the end of a blast is not fire.
  const deadline = state.tick + (FIRE_TICKS - FIRE_LETHAL_TICKS);
  const fresh = state.fires.length
    ? state.fires.filter(f => f.until > deadline && (f.startsAt ?? 0) <= state.tick)
    : null;

  for (let i = state.gulls.length - 1; i >= 0; i--) {
    const g = state.gulls[i];
    if (state.tick - g.t0 >= g.dur) { state.gulls.splice(i, 1); continue; }
    if (!fresh || !fresh.length) continue;

    const at = gullAt(g, state.tick);
    /* Any fire it is over, at any height.
     *
     * It used to have to be at the bottom of a dive - GULL_LOW_ALT, about one tick in nine of the
     * flight - and between that and a bird crossing three tiles a second the shot was mostly
     * luck. The altitude rule is gone: if a blast reaches the tile the gull is over, the gull is
     * down. Still only fire inside its lethal window, which is the same window that kills players.
     *
     * Bots' fire does not count. A bot carpets the board, so with bots in the room nearly every
     * gull was downed by one, and the reward is meant to be for a shot somebody took.
     */
    const tx = Math.floor(at.x / UNITS_PER_TILE), ty = Math.floor(at.y / UNITS_PER_TILE);
    const fire = fresh.find(f => f.tx === tx && f.ty === ty
      && !(f.owner >= 0 && state.players[f.owner]?.isBot));
    if (!fire) continue;

    state.gulls.splice(i, 1);
    const x = Math.round(at.x), y = Math.round(at.y);
    /* Paid to the shooter, in the air, the moment it falls.
     *
     * Three coins into the hand of whoever owned the fire - see GULL_COINS for why that is better
     * than a coin on the floor. The XP is still one coin's worth; the coins are the trophy, the
     * score is for the shot.
     *
     * A keg has no owner, so that case leaves a coin on the ground rather than quietly paying
     * nobody - and there is a THIRD case behind it that used to pay nobody after all. `landing`
     * searches rings 0-3 and returns null when every tile in them is wall, sea, or already
     * holding a perk. On a null the old code dropped nothing and paid nothing: the gull died for
     * free, which is the reported "the gold sometimes does not drop".
     *
     * So the fallbacks are now exhaustive. Nearby floor first, because a coin landing where the
     * bird fell is the readable outcome and the one the design wants. Failing that it is salvaged
     * to the nearest living person, which is worth more than the tidiness of refusing. Only a
     * board with no living people on it forfeits, and that is a board with nobody to pay.
     */
    const by = fire.owner ?? -1;
    const killer = by >= 0 ? state.players[by] : null;
    let spot = null;
    let salvaged = null;
    if (killer) {
      killer.coins = (killer.coins || 0) + GULL_COINS;
      killer.score += SCORE.GOLD;
    } else {
      spot = landing(state, tx, ty);
      if (spot) drop(state, spot.tx, spot.ty, PERK.GOLD, false);
      else {
        salvaged = nearestLiving(state, at.x, at.y);
        if (salvaged) {
          salvaged.coins = (salvaged.coins || 0) + GULL_COINS;
          salvaged.score += SCORE.GOLD;
        }
      }
    }
    state.events.push({
      e: 'gullhit', tick: state.tick, id: g.id, x, y, by,
      ...(killer ? { coins: GULL_COINS } : null),
      ...(spot ? { cx: spot.tx, cy: spot.ty } : null),
      // Not `by`: nobody downed this one, so the feed must not credit the shot to the person the
      // coin happened to fall to.
      ...(salvaged ? { salvaged: salvaged.i, coins: GULL_COINS } : null),
    });
  }
}

/** What the snapshot carries per gull: the description, never a position. */
export const gullWire = g => ({
  id: g.id, x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, t0: g.t0, dur: g.dur,
  weave: g.weave, dive: g.dive, hi: g.hi,
  ...(g.raid ? { raid: 1 } : null),
});
