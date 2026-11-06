// Bomb placement, fuses, and stepwise fire-wave chains.

import {
  FUSE_TICKS, FUSE_TICKS_FAST, FIRE_TICKS, CHAIN_CAP_PER_TICK, IN_BOMB, STATUS, MAX_RADIUS,
  BLOCK, POWDER_RADIUS, DIR_R, DIR_U, DIR_L, DIR_D, HITBOX_UNITS, HITBOX_REDUCED_UNITS,
  KICK_TILE_NUM, KICK_TILE_DEN, KICK_MAX_TILES, DIR_NONE,
} from '../constants.js';
import { has, streakActive, toTile, tileAt } from './state.js';
import { endSlide } from './movement.js';
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
  /* And neither is a perk, which is this rule's one genuinely surprising consequence.
   *
   * The facing tile is also the tile you are WALKING ONTO, so aiming at it means a player who
   * walks at a perk and bombs the wall behind it buries the perk under their own bomb. A bomb
   * makes its tile solid, so the perk is then behind a wall for the whole fuse: the pickup
   * visibly does nothing while the HUD shows room to spare. That was reported as the pickup
   * being broken, and `collect()` had nothing to do with it.
   *
   * Only the AIMED tile is protected. Underfoot is not, and must not be: a perk you are standing
   * on is one you would already have collected if you could, so it is either capped or not yours
   * to take, and refusing both tiles would leave you unable to bomb at all. */
  /* NOTE: no rule here about the placer's own hitbox, deliberately.
   *
   * There was one for an afternoon, to fix "I got stuck in a bomb I had just placed", and it was
   * the wrong place to fix it. Making the aim depend on where in the tile you are standing makes
   * the SIGHT flip between the facing tile and underfoot as you walk through a 29-unit window -
   * the bracket jumps back onto you and out again, once per tile, which is far more visible than
   * the bug it was fixing. The aim is a function of the tile you are IN, and nothing else; see
   * the test of that name in test/bombs.test.js.
   *
   * The trap itself is now fixed where it actually lived: bombSolid's grace, in sim/movement.js.
   */
  const free = tileAt(state.map, fx, fy) === BLOCK.FLOOR && bombable(state, fx, fy)
    && !state.perks.some(k => k.tx === fx && k.ty === fy);
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

  // A kicked bomb is still on the board, so it still counts against its owner by the ordinary
  // rule. No special case: that is one of the things the sliding kick is better than the version
  // that removed the bomb, which needed its own bookkeeping to stay fair.
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
 * A bomb a slide reached is kicked skating across the floor.
 *
 * Game of Bombs rules. The bomb is NOT removed: it keeps its fuse, slides in the direction the
 * slide was going, and stops at the first thing it meets - see `slideBombs`. Whoever it stops
 * against can kick it straight back, which is the whole point. A kicked bomb is a thrown weapon
 * with an answer to it, not a save with none.
 *
 * Runs beside `daze` in the tick, for the same reason and at the same moment: while the overlap
 * that proves it still exists, and BEFORE bombs are placed, so "placed and kicked on the same
 * tick" has a definite answer rather than a race.
 *
 * No ownership rule: your own bombs are kickable too, and so is one already skating - catching a
 * moving bomb and sending it back the other way is exactly the trick this mechanic is for.
 */
export function kick(state) {
  if (!state.bombs.length) return;
  const players = state.players;
  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    // Sliding on THIS tick, which includes the tick a slide ended on - see `slideTick` in
    // sim/movement.js. A slide launched from flush against a bomb covers no ground and is over
    // inside the same tick, and that is still a kick.
    if (!p || !p.alive || p.slideTick !== state.tick) continue;
    const step = KICK_STEP[p.slideDir];
    if (!step) continue;

    /* Read off the LEADING EDGE of the hitbox, one unit out.
     *
     * A bomb is solid to a slide, so the slide has already come to rest flush against it: the
     * front face of the box is exactly on the tile boundary and the box overlaps nothing. An
     * overlap test therefore finds nothing, and a test on "the tile ahead of my centre" fires up
     * to 176 units early - most of a tile of daylight between the pirate and a bomb that has
     * started moving. One unit past the front face is the contact itself.
     */
    const half = (has(p, STATUS.REDUCTION) ? HITBOX_REDUCED_UNITS : HITBOX_UNITS) >> 1;
    const reach = half + 1;
    const tx = toTile(p.x + step[0] * reach), ty = toTile(p.y + step[1] * reach);
    // Not the one underfoot. Standing on a bomb and sliding away from it is not kicking it.
    if (tx === toTile(p.x) && ty === toTile(p.y)) continue;

    const b = bombAt(state, tx, ty);
    if (!b) continue;
    // Already going this way: do not restart the step clock, or a slider riding alongside a
    // bomb would hold it at the start of a tile and it would never arrive anywhere.
    if (b.kickDir === p.slideDir) continue;
    /* A bomb with nowhere to go is not kicked at all. Nothing happens to it, and no event.
     *
     * It is wedged against a wall, another bomb, the water or somebody's back, so the only thing
     * a kick could do is restart its step clock and announce a shove that never moves it. The
     * slide still stops - the bomb is solid, and that part is physics - but the bomb is left
     * exactly as it was, fuse and all.
     */
    if (!bombCanSlideInto(state, tx + step[0], ty + step[1])) continue;

    b.kickDir = p.slideDir;
    b.kickLeft = KICK_MAX_TILES;
    b.kickOwe = 0;                 // a fresh kick starts the carry from nothing
    scheduleHop(state, b);
    // The collision costs the slider everything. See `endSlide`.
    endSlide(p);
    state.events.push({
      e: 'kick', tick: state.tick, id: b.id, x: b.tx, y: b.ty, by: p.i, d: p.slideDir,
    });
  }
}

/** Where a kicked bomb would go next, as [tx, ty]. */
const KICK_STEP = {
  [DIR_R]: [1, 0], [DIR_U]: [0, -1], [DIR_L]: [-1, 0], [DIR_D]: [0, 1],
};

/**
 * Book the next hop: `kickAt` is the tick it lands on.
 *
 * A tile takes KICK_TILE_NUM/KICK_TILE_DEN ticks - 2.6 - and a tick is an integer, so each hop
 * takes a whole number of them and the leftover fifths ride along in `kickOwe` to be spent on a
 * later one. Five hops come to exactly thirteen ticks; no hop is ever shorter than one tick.
 *
 * It used to record `kickFrom` as well, for a client that drew the hop by interpolating between
 * its two ends. Nothing reads it any more - the drawing dead-reckons at the kick's own pace and
 * uses the tile only as a leash, which is the only version of it that turned out to be smooth, so
 * the field was weight on every bomb in every snapshot for nothing. See client/render.js.
 */
function scheduleHop(state, b) {
  b.kickOwe = (b.kickOwe ?? 0) + KICK_TILE_NUM;
  const ticks = Math.max(1, (b.kickOwe / KICK_TILE_DEN) | 0);
  b.kickOwe -= ticks * KICK_TILE_DEN;
  b.kickAt = state.tick + ticks;
}

/**
 * Advance every skating bomb by one tile when its step is due, and stop the ones that meet
 * something.
 *
 * A bomb stops at a wall, the sea, the map edge, another bomb, standing water, or a PERSON. The
 * last of those is what makes it a weapon you can return: it comes to rest against whoever it
 * caught, still ticking, and they can kick it back the way it came.
 *
 * A SLIDING player is not an obstacle, deliberately and for the same reason bombs are not solid
 * to them: they are passing through. Without that exception the kicker themselves would usually
 * stop the bomb dead - a slide launches at three times walking pace, so the kicker is ahead of
 * their own kick for the first few tiles of it.
 *
 * Tile by tile rather than in sub-tile units, because every rule that touches a bomb - blast
 * shape, chains, solidity, placement - is written against `tx`/`ty`, and a bomb that is half way
 * between two tiles would need all of them to have an opinion about which one it is in. The
 * client draws the motion smoothly from `kickAt`; the simulation only ever sees it on a tile.
 */
export function slideBombs(state) {
  for (const b of state.bombs) {
    if (b.kickDir === undefined || b.kickDir === DIR_NONE) continue;
    if (state.tick < b.kickAt) continue;

    const step = KICK_STEP[b.kickDir];
    if (!step) { b.kickDir = DIR_NONE; continue; }
    const nx = b.tx + step[0], ny = b.ty + step[1];

    // Out of range, or something in the way: it comes to rest here, still ticking.
    if (!(b.kickLeft > 0) || !bombCanSlideInto(state, nx, ny)) { b.kickDir = DIR_NONE; continue; }

    b.tx = nx; b.ty = ny;
    b.kickLeft--;
    scheduleHop(state, b);
  }
}

/**
 * Is this tile somewhere a skating bomb may come to rest?
 *
 * Exported because the RENDERER has to agree with it exactly. The client draws a hop forward,
 * into the tile the bomb is heading for, which is only honest while the bomb is actually going
 * there - so it asks this, on its own world, rather than keeping a second copy of the rule that
 * could drift. See the kick interpolation in client/render.js.
 *
 * Anybody standing on it stops it - that is what makes a kicked bomb a weapon you can answer. It
 * comes to rest on the tile BEFORE them, still ticking, and they can kick it straight back.
 *
 * No exception for the kicker, and none for a player mid-slide. Both existed while a slide could
 * pass through a bomb: the kicker outran their own kick and would have stopped it dead a few
 * tiles later. A slide now collides with the bomb and ends there, so the kicker is always behind
 * it and never in its path, and the exceptions were only a way for a bomb to pass through people.
 */
export function bombCanSlideInto(state, tx, ty) {
  if (tileAt(state.map, tx, ty) !== BLOCK.FLOOR) return false;
  if (bombAt(state, tx, ty)) return false;
  if (puddleAt(state, tx, ty)) return false;        // a fuse does not survive the water
  for (const p of state.players) {
    if (!p || !p.alive) continue;
    if (toTile(p.x) === tx && toTile(p.y) === ty) return false;
  }
  return true;
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
