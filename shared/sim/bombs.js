// Bomb placement, fuses, and stepwise fire-wave chains.

import {
  FUSE_TICKS, FUSE_TICKS_FAST, FIRE_TICKS, CHAIN_CAP_PER_TICK, IN_BOMB, STATUS, MAX_RADIUS,
  BLOCK, POWDER_RADIUS, DIR_R, DIR_U, DIR_L, DIR_D,
} from '../constants.js';
import { has, streakActive, toTile, tileAt } from './state.js';
import { spread } from './fire.js';
import { damage, melt } from './blocks.js';
import { maybeDrop } from './perks.js';

export const bombAt = (state, tx, ty) => state.bombs.find(b => b.tx === tx && b.ty === ty);

/* Standing water from melted ice. A fuse dropped in it would be put out, so a bomb can never be
 * placed on a puddle - not in front of you, and not underfoot either. See bombTile and place. */
export const puddleAt = (state, tx, ty) => !!state.puddles?.some(q => q.tx === tx && q.ty === ty);

/** Whether a bomb could be put down on this tile right now: no bomb there, and not in water. */
export const bombable = (state, tx, ty) => !bombAt(state, tx, ty) && !puddleAt(state, tx, ty);

/* Which tile a bomb from this player would land on.
 *
 * In FRONT of them, not underneath. You face a direction and the bomb goes there, which turns
 * placing one into an aimed action rather than a thing that happens where you happen to be
 * standing. The tile you are standing in is the guide: the facing tile is the neighbour of
 * `toTile(p.x), toTile(p.y)`, so it changes the instant your centre crosses a tile boundary and
 * never depends on where inside the tile you are.
 *
 * It falls back to the tile underneath when the facing one cannot take a bomb - a wall, the
 * sea, the map edge, or another bomb. That fallback is not a compromise, it is the only way the
 * game still works: the commonest reason to bomb anything is to break the wall you are facing,
 * and a rule that refused would mean walls could never be broken by somebody looking at them.
 *
 * Exported because three other places have to agree with it exactly: the client's local
 * feedback sound, and the bots' "is this worth bombing" and "where would the blast go".
 */
export function bombTile(state, p) {
  const tx = toTile(p.x), ty = toTile(p.y);
  const d = DIR_STEP[p.dir] ?? DIR_STEP[DIR_D];
  const fx = tx + d.dx, fy = ty + d.dy;
  // A puddle in front is not free either: the fallback then tries underfoot, which place()
  // refuses in turn if you are standing in the water yourself.
  const free = tileAt(state.map, fx, fy) === BLOCK.FLOOR && bombable(state, fx, fy);
  return free ? { tx: fx, ty: fy } : { tx, ty };
}

const DIR_STEP = {
  [DIR_R]: { dx: 1, dy: 0 },
  [DIR_U]: { dx: 0, dy: -1 },
  [DIR_L]: { dx: -1, dy: 0 },
  [DIR_D]: { dx: 0, dy: 1 },
};

/**
 * Where a press of the bomb key would put a bomb right now, or null if it would not.
 *
 * Every reason a press is refused lives here and only here, because two things must agree on it
 * exactly: place() below, and the client's instant "place" sound. The sound used to keep its own
 * copy of the rules, which drifted - it knew about walls, other bombs, puddles and the bomb count,
 * but not pacifism, being dazed or being mid-slide - so it clicked for bombs that never appeared.
 */
export function placeable(state, p) {
  if (!p || !p.alive) return null;
  if (has(p, STATUS.PACIFISM)) return null;
  // Seeing stars: somebody slid through you and for the next second and a half you cannot find
  // the fuse. place() has already consumed the key's edge by the time it asks, so holding the key
  // through it does not bank a bomb that fires the moment it wears off - you have to press again.
  if (has(p, STATUS.CONFUSED)) return null;
  // A slide in progress is hands-full. Without this the slide becomes a bomb-delivery vehicle:
  // launch, cross three tiles in a third of a second, and drop one at the far end from safety.
  if (p.slideV > 0) return null;

  const at = bombTile(state, p);
  if (!bombable(state, at.tx, at.ty)) return null;

  const live = state.bombs.reduce((n, b) => n + ((b.owner ?? b.o) === p.i ? 1 : 0), 0);
  if (live >= p.bombs) return null;
  return at;
}

export function place(state, p, mask) {
  /* One bomb per PRESS, not per tick the key is down.
   *
   * It was per tick, and that was survivable only because the bomb landed underneath you and
   * the second attempt found the tile already taken. Aimed placement broke it: the first bomb
   * goes in front, the next tick finds that tile occupied and falls back to the tile underfoot,
   * and a single tap lays two bombs a third of a second apart.
   *
   * The edge is tracked on the player rather than in the client, so prediction and the server
   * agree without the client having to send anything new - it replays the same masks through
   * the same function and arrives at the same answer.
   */
  const held = (mask & IN_BOMB) !== 0;
  const pressed = held && !p.bombHeld;
  p.bombHeld = held;
  if (!pressed) return;
  const at = placeable(state, p);
  if (!at) return;
  const { tx, ty } = at;

  const fuse = has(p, STATUS.FAST_DET) ? FUSE_TICKS_FAST : FUSE_TICKS;
  const bomb = {
    id: state.nextBombId++,
    tx, ty,
    o: p.i, owner: p.i,
    r: Math.min(p.radius, MAX_RADIUS), radius: Math.min(p.radius, MAX_RADIUS),
    at: state.tick + fuse,
    fuseTicks: fuse,
    streakPowered: streakActive(p, state.tick),
  };
  state.bombs.push(bomb);
  state.events.push({ e: 'bomb', tick: state.tick, id: bomb.id, x: tx, y: ty, o: p.i, r: bomb.radius, at: bomb.at });
}

/**
 * Detonate bombs due this tick and resolve fire-wave effects that arrive this tick.
 *
 * Due bombs resolve in ascending id with a hard cap - a 16-player bomb carpet must not stall the
 * loop. A blast schedules each arm tile at its deterministic wave-arrival tick; bombs and powder
 * kegs are triggered at that tile's arrival instead of instantly.
 */
export function detonate(state) {
  for (const fire of state.fires) {
    if (!fire.hit || fire.hitApplied || (fire.startsAt ?? 0) > state.tick) continue;
    fire.hitApplied = true;
    const res = damage(state, fire.tx, fire.ty, fire.owner);
    if (!res?.destroyed) continue;
    if (res.type === BLOCK.POWDER) {
      state.bombs.push({
        id: state.nextBombId++, tx: fire.tx, ty: fire.ty,
        owner: fire.owner, radius: POWDER_RADIUS, at: state.tick,
        fuseTicks: 0, streakPowered: !!fire.streakPowered,
      });
    } else if (res.type === BLOCK.ICE) {
      melt(state, fire.tx, fire.ty);
    } else {
      maybeDrop(state, fire.tx, fire.ty, res.type);
    }
  }

  const due = state.bombs.filter(b => b.at <= state.tick).sort((a, b) => a.id - b.id);
  if (!due.length) return;

  const queue = [...due];
  const burst = new Set();
  let guard = 0;

  while (queue.length && guard++ < CHAIN_CAP_PER_TICK) {
    const bomb = queue.shift();
    if (burst.has(bomb.id)) continue;
    burst.add(bomb.id);

    // The live bomb list goes in so arms stop at other bombs instead of overshooting them.
    const { cells } = spread(state.map, bomb, state.bombs);

    // The client uses this event to derive the same per-tile fire schedule from its map. Block
    // effects are emitted later, when the scheduled wave reaches their tiles.
    state.events.push({
      e: 'boom', tick: state.tick, id: bomb.id,
      x: bomb.tx, y: bomb.ty, o: bomb.owner, r: bomb.radius,
      ...(bomb.streakPowered ? { streakPowered: true } : null),
    });

    for (const c of cells) {
      // `src` is which blast this is, so a hit can be counted once per blast - see killInFire.
      const startsAt = state.tick + (c.delayTicks ?? 0);
      state.fires.push({
        tx: c.tx, ty: c.ty, kind: c.kind, rot: c.rot,
        startsAt, until: startsAt + FIRE_TICKS, hit: !!c.hit,
        owner: bomb.owner, src: bomb.id, streakPowered: !!bomb.streakPowered,
      });
      const neighbour = bombAt(state, c.tx, c.ty);
      if (neighbour && !burst.has(neighbour.id)) neighbour.at = Math.min(neighbour.at, startsAt);
    }
  }

  state.bombs = state.bombs.filter(b => !burst.has(b.id));
}

export function expireFires(state) {
  if (state.fires.length) state.fires = state.fires.filter(f => f.until > state.tick);
}
