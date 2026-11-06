// The one movement function. Imported unchanged by the server and by the client's prediction,
// which is the whole reason reconciliation is usually a no-op. See docs/NETCODE.md §2.
//
// Integers only. Positions are in units where one tile is 256, so a tile coordinate is `x >> 8`.
//
// ─── RAILS ───────────────────────────────────────────────────────────────────────────────────
//
// A pirate is ALWAYS on the centre line of a row or a column. There is no off-lane position to
// be in - the invariant is that at the end of every tick either `x` or `y` is exactly
// `tileCentre` of its tile, and at a tile centre both are.
//
// WHERE THE STATE LIVES. Position stays in the existing `x`/`y` pair, with that invariant, rather
// than becoming an explicit lane index plus an offset. Two reasons, and the second is the one
// that decided it: every other rule in the game - hitboxes, fire overlap, pickups, bomb
// solidity, the renderer, the wire format - already reads `x`/`y` and does not care how the
// position was reached, and a lane representation would have meant converting at every one of
// those boundaries. The axis you are travelling on is derivable from `dir`, so it needs no
// storage either.
//
// The only genuinely new state is the buffered turn: `turnWant` (a DIR_*, or 0) and `turnAt` (the
// tick it was asked for, for expiry). Both are on the wire - see playerWire in server/room.js -
// because prediction replays pending inputs from a snapshot, and a turn the client is holding
// that the snapshot does not mention is a divergence waiting for the next corner.
//
// WHAT WENT AWAY. Lane centring (`ALIGN_*`) and corner assist (`ASSIST_*`) are gone, and so are
// diagonals. Centring was approaching a line the rails are simply on; assist was a kindness for
// being nearly lined up with a gap, which queued turns do better - they do not require you to be
// lined up at all. The chamfer in `blocked` survives for bots and for the unstick seatbelt, but
// ordinary rail travel never reaches it: a lane-centred hitbox is 160 units inside a 256-unit
// lane, so it only ever touches the tiles its own lane passes through.

import {
  UNITS_PER_TILE, HITBOX_UNITS, HITBOX_REDUCED_UNITS,
  SPEED_UNITS_PER_TICK, SLOWDOWN_NUM, SLOWDOWN_DEN,
  STAMINA_MAX, STAMINA_DRAIN_PER_TICK, STAMINA_REGEN_MOVING, STAMINA_REGEN_IDLE,
  STAMINA_RECOVER_UNITS, STAMINA_TIRED_NUM, STAMINA_TIRED_DEN, staminaMaxFor,
  PUDDLE_SPEED_NUM, PUDDLE_SPEED_DEN, PUDDLE_SLIDE_TICKS,
  SLIDE_PEAK_NUM, SLIDE_PEAK_DEN, SLIDE_DRAG_NUM, SLIDE_DRAG_DEN, SLIDE_EXIT_UNITS,
  SLIDE_SKATE_BONUS_SHAVE_NUM, SLIDE_SKATE_BONUS_SHAVE_DEN,
  SLIDE_MAX_TICKS, SLIDE_STAMINA_COST, SLIDE_COOLDOWN_TICKS,
  CONFUSED_NUM, CONFUSED_DEN, TURN_BUFFER_UNITS, DRUNK_FUMBLE_EVERY, DIR_NONE,
  IN_RIGHT, IN_UP, IN_LEFT, IN_DOWN, IN_SLIDE, DIR_R, DIR_U, DIR_L, DIR_D, STATUS, BLOCK,
  CORNER_CUT_UNITS,
} from '../constants.js';
import { walkable, has, tileCentre, tileAt, toTile } from './state.js';
import { mossValue, mossyTile } from '../moss.js';

const HALF_TILE = UNITS_PER_TILE >> 1;

/* Being shoved out of a solid tile eases rather than running at a constant rate: a fraction of
 * whatever is left each tick, capped far below walking pace and floored so it still terminates.
 *
 * Deliberately much slower than the legs. Walking pace felt like being shoved, because it was the
 * same speed as a deliberate move and the eye read it as the player suddenly sprinting sideways
 * of their own accord. A slow drift reads as the wall easing you aside, which is what it is - and
 * the commonest case by far is a partial overlap from a wall regrowing beside you, which is over
 * in a few ticks either way.
 *
 * Bombs cannot reach this code at all; see the note in `unstick`.
 *
 * EIGHT units a tick, up from four, and the reason is worth recording. The floor was four and the
 * comment here claimed "being entombed costs about a second" - but clearing a 160-unit hitbox out
 * of a 256-unit tile is 208 units of travel, which at four units a tick is 52 ticks, or nearly
 * two seconds. The claim was true only because of a bug: the old flush-to-wall slide, applied
 * from a position already overlapping a wall, computed an edge a whole tile further on and
 * teleported the player 255 units in a single tick. That looked like a fast escape and was
 * actually a visible snap, and test/unstick.test.js was passing on the strength of it.
 *
 * The rails have no such accident - travel is verified against `blocked` before it is taken - so
 * the escape is now uniformly slow, and these two numbers are what make the documented intent
 * true rather than aspirational. Eight units a tick with a floor of six on the easing tail clears
 * those 208 units in 29 ticks: 0.97 seconds, which is the "about a second" this comment has
 * always claimed. Eight is under a third of base walking pace (27), so it still reads as drifting
 * rather than sprinting, and the taper from eight down to six keeps the arrival soft instead of
 * stopping dead.
 */
const UNSTICK_MIN_UNITS = 6;
const UNSTICK_MIN_PACE = 8;
const UNSTICK_EASE_SHIFT = 4;      // move 1/16 of the remaining gap each tick
const UNSTICK_PACE_NUM = 1, UNSTICK_PACE_DEN = 15;

export function speedOf(p) {
  let s = SPEED_UNITS_PER_TICK[Math.min(p.speed, SPEED_UNITS_PER_TICK.length - 1)];
  if (has(p, STATUS.SLOWDOWN)) s = ((s * SLOWDOWN_NUM) / SLOWDOWN_DEN) | 0;
  if (p.tired) s = ((s * STAMINA_TIRED_NUM) / STAMINA_TIRED_DEN) | 0;
  // Seeing stars after somebody slid through you. Applied after the other two, so a tired and
  // confused player is slower than either on its own rather than the worse of the two.
  if (has(p, STATUS.CONFUSED)) s = ((s * CONFUSED_NUM) / CONFUSED_DEN) | 0;
  return Math.max(1, s);
}

/** The direction bit a mask is asking for, or null. Diagonals resolve to the facing's axis. */
function askedDir(p, mask) {
  const dx = ((mask & IN_RIGHT) ? 1 : 0) - ((mask & IN_LEFT) ? 1 : 0);
  const dy = ((mask & IN_DOWN) ? 1 : 0) - ((mask & IN_UP) ? 1 : 0);
  if (!dx && !dy) return null;
  if (dx && dy) {
    const facingH = p.dir === DIR_L || p.dir === DIR_R;
    return facingH ? (dx > 0 ? DIR_R : DIR_L) : (dy > 0 ? DIR_D : DIR_U);
  }
  return dx > 0 ? DIR_R : dx < 0 ? DIR_L : dy < 0 ? DIR_U : DIR_D;
}

/**
 * Start a slide, if this player may have one.
 *
 * Deliberately strict, because every refusal here is a refusal somebody can learn: no wind, no
 * slide; already sliding, no slide; still catching your breath from the last one, no slide. The
 * tired latch is in there too - an exhausted pirate limps, and a limping pirate who can still
 * cross three tiles in a third of a second would make the whole stamina system optional.
 *
 * Costs the stamina up front and sets a velocity, not a timer. Everything after this is drag.
 */
function startSlide(state, p, mask) {
  if (p.slideV > 0 || p.slideCool > 0 || p.tired) return false;
  if (p.stamina < SLIDE_STAMINA_COST) return false;
  /* The way you are pointed: the direction held this tick, or the facing if your hands are off.
   *
   * Both halves matter now that the launch is a key of its own. The facing alone is a tick stale -
   * the slide gate runs before this tick's direction keys are read, so standing still facing right
   * and pressing left with Control would have sent you RIGHT, which is a key you cannot aim. The
   * held direction alone is no good either, because Control on its own has to do something, and
   * the only sensible something is "the way I am looking".
   */
  const dir = askedDir(p, mask) ?? p.dir;
  p.stamina -= SLIDE_STAMINA_COST;
  if (p.stamina <= 0) { p.stamina = 0; p.tired = true; }
  p.dir = dir;
  p.slideDir = dir;
  // A slide is a commitment, so it starts with a clean slate: a turn asked for before the launch
  // must not fire out the far end of it.
  clearTurn(p);
  const bootPace = SPEED_UNITS_PER_TICK[Math.min(p.speed, SPEED_UNITS_PER_TICK.length - 1)];
  const bootBonus = Math.max(0, bootPace - SPEED_UNITS_PER_TICK[0]);
  const shave = (bootBonus * SLIDE_SKATE_BONUS_SHAVE_NUM / SLIDE_SKATE_BONUS_SHAVE_DEN) | 0;
  const slidePace = Math.max(1, speedOf(p) - shave);
  // Keep the full base slide, while shaving a tenth of the bonus pace from boots.
  p.slideV = Math.max(SLIDE_EXIT_UNITS + 1, ((slidePace * SLIDE_PEAK_NUM) / SLIDE_PEAK_DEN) | 0);
  p.slideFor = 0;
  state.events?.push({ e: 'slide', tick: state.tick, i: p.i, x: p.x, y: p.y, d: dir });
  return true;
}

/**
 * One tick of a slide in progress. Returns false once it is over.
 *
 * The velocity is integer units a tick and loses a tenth of itself every tick, so the whole thing
 * is a geometric series the client can replay exactly. Hitting a wall ends it immediately - a
 * slide that kept its momentum while pressed against stone would let you hold a slide round a
 * corner, and the one thing this mechanic must not become is a better way to walk.
 */
function stepSlide(state, p) {
  /* Strictly along the lane, and it cannot turn.
   *
   * `dir` is forced to `slideDir` for the duration so `railTravel` runs down the slide's own lane
   * rather than wherever the pirate was last facing, and any buffered turn is dropped at the
   * launch - a slide you could steer round a corner would be a better way to walk, which is the
   * one thing this mechanic must not become.
   */
  p.dir = p.slideDir;
  /* The tick this slide was live on, which is how `kick` knows a slide happened at all.
   *
   * It cannot ask `slideV > 0` after the fact: a slide that launches already flush against a bomb
   * covers no ground, so it is over by the end of this very function and the kick would never
   * fire. Stamped rather than flagged so it clears itself - nothing has to remember to unset it,
   * and it never needs to go on the wire, because the client does not simulate kicks.
   */
  p.slideTick = state.tick;
  // Same rule as walking: a tick spent easing back onto the lane is not a tick of sliding. The
  // drag below still applies, so a slide that starts off-lane simply loses a little of itself.
  const moved = pinToLane(state, p, p.slideV) ? p.slideV : railTravel(state, p, p.slideV);
  p.slideFor++;
  p.slideV = ((p.slideV * SLIDE_DRAG_NUM) / SLIDE_DRAG_DEN) | 0;
  // Stopped dead, out of speed, or the seatbelt: either way, put the brakes on and start the
  // cooldown from here rather than from the launch.
  if (!moved || p.slideV <= SLIDE_EXIT_UNITS || p.slideFor >= SLIDE_MAX_TICKS) {
    endSlide(p);
    return false;
  }
  return true;
}

/**
 * Put the brakes on, here and now. The cooldown starts from the stop, not from the launch.
 *
 * Exported because a kick ends a slide too: sliding into a bomb is a collision, and the whole
 * point of a collision is that you do not come out of it with your momentum. See `kick` in
 * sim/bombs.js - without this the bomb skates away and the slide, still carrying most of its
 * velocity, simply chases it down the corridor it just cleared.
 */
export function endSlide(p) {
  p.slideV = 0;
  p.slideFor = 0;
  p.slideCool = SLIDE_COOLDOWN_TICKS;
}

/**
 * Stamina, once per tick per player.
 *
 * Runs for everyone alive, moving or not, and runs BEFORE the move so the speed used this tick
 * reflects the state this tick. `tired` is a latch with hysteresis: it is set at zero and only
 * cleared once a third of the bar is back. Without the latch the exhausted flag flips every tick
 * at the boundary - the player stutters between full and half pace, and it reads as packet loss
 * rather than as a mechanic.
 */
export function stamina(p, moving) {
  if (p.stamina === undefined) { p.stamina = STAMINA_MAX; p.tired = false; }
  const max = staminaMaxFor(p);

  if (moving && !p.tired) {
    p.stamina -= STAMINA_DRAIN_PER_TICK;
    if (p.stamina <= 0) { p.stamina = 0; p.tired = true; }
    return;
  }

  // Standing still is twice as good as limping, which is what makes stopping a decision.
  p.stamina = Math.min(max, p.stamina + (moving ? STAMINA_REGEN_MOVING : STAMINA_REGEN_IDLE));
  if (p.tired && p.stamina >= STAMINA_RECOVER_UNITS) p.tired = false;
}

/**
 * Is this player standing in a puddle? By the tile their centre is in - the same test fire,
 * pickups and every other per-tile rule use. `state` is the server's state or the client's
 * world; both carry the puddle list, which is what lets prediction agree.
 */
export function inPuddle(state, p) {
  const ps = state.puddles;
  if (!ps || !ps.length) return false;
  const tx = p.x >> 8, ty = p.y >> 8;
  for (const q of ps) if (q.tx === tx && q.ty === ty && q.until > state.tick) return true;
  return false;
}

const DIR_VEC = { [DIR_R]: [1, 0], [DIR_U]: [0, -1], [DIR_L]: [-1, 0], [DIR_D]: [0, 1] };

const halfBox = p => (has(p, STATUS.REDUCTION) ? HITBOX_REDUCED_UNITS : HITBOX_UNITS) >> 1;

/**
 * A bomb is solid to anyone whose centre is outside its tile - and to nobody who is already
 * standing on it, whoever placed it.
 *
 * The owner test this used to have made a non-owner's bomb solid the instant it appeared, with
 * no grace for a player whose hitbox was already inside that tile. Every candidate position was
 * then blocked too, so dropping a bomb on someone standing next to you froze them in place for
 * the whole 72-tick fuse: an unavoidable kill with no counterplay. Tile occupancy is observable
 * from the bomb record alone, so both sides agree without the bomb carrying any extra state.
 *
 * Inlined rather than imported from bombs.js: that module imports fire.js and blocks.js, and
 * movement has no business pulling in the whole blast chain.
 */
function bombSolid(state, p, tx, ty) {
  if (!state.bombs) return false;
  /* A bomb is solid to a slide too, and that is the collision the kick is made of.
   *
   * It used to be passable, so a slide ran straight over the bomb and the kick was detected from
   * the overlap. That read as sliding THROUGH a bomb and nudging it along on the way past: you
   * kept your speed, you ended up standing inside it, and nothing about the moment said you had
   * hit something. Solid instead means `railTravel` stops the slide flush against the bomb's tile
   * exactly as it would against a wall, `kick` reads that contact off the leading edge of the
   * hitbox, and the slide is over - see `kick` in sim/bombs.js.
   */
  for (const b of state.bombs) {
    if (b.tx !== tx || b.ty !== ty) continue;
    /* Still touching it? Then it is not solid to you yet.
     *
     * The test used to be whether your CENTRE had left the tile, and that is where the shove
     * came from: the instant the centre crossed the line, eighty units of hitbox were suddenly
     * inside a solid tile, and `unstick` had to push all of it back out. A third of a tile of
     * movement you did not ask for, every single time you walked off a bomb you had just
     * placed - which is the most common thing anybody does in this game.
     *
     * Testing the HITBOX instead means the bomb becomes solid at the exact moment you are
     * clear of it, so there is nothing left to push out and the unstick never fires at all.
     * The rule stays observable from the bomb record alone, so both machines still agree.
     */
    /* The FULL box, not five eighths of it.
     *
     * It was five eighths, to firm a bomb up a few units early so stepping off one had some
     * weight to it. That gap is a trap: between the five-eighths box and the full box there is a
     * 29-unit band where a bomb is solid to you AND you are standing inside it. Place a bomb
     * while clipping the next tile - which walking through it does routinely - and every
     * candidate move is refused, the gentle unstick shoves you sideways off your lane, and the
     * lane correction pulls you straight back in. Reported as "I got stuck in a bomb I had just
     * placed, having clipped a little", and that is exactly it.
     *
     * At the full width the bomb turns solid exactly when you are clear of it, so there is never
     * anything to push out and the trap cannot exist. The cost is the few units of early
     * firmness, which is a feel detail; being stuck is not.
     */
    const half = halfBox(p);
    const overlaps = ((p.x - half) >> 8) <= tx && ((p.x + half - 1) >> 8) >= tx
                  && ((p.y - half) >> 8) <= ty && ((p.y + half - 1) >> 8) >= ty;
    return !overlaps;
  }
  return false;
}

/** Would the hitbox centred on (x, y) overlap anything solid? */
/**
 * @param bombsCount false to ask about terrain only - see `unstick`.
 */
/**
 * @param bombsCount false to ask about terrain only - see `unstick`.
 * @param chamfer false to ask about the SQUARE box - see the note below.
 */
export function blocked(state, p, x, y, bombsCount = true, chamfer = true) {
  const h = halfBox(p);
  const reduced = has(p, STATUS.REDUCTION);
  const x0 = (x - h) >> 8, x1 = (x + h - 1) >> 8;
  const y0 = (y - h) >> 8, y1 = (y + h - 1) >> 8;
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      const terrainSolid = !walkable(state.map, tx, ty, reduced);
      const bomb = bombsCount && bombSolid(state, p, tx, ty);
      const solid = terrainSolid || bomb;
      if (!solid) continue;
      // The chamfer is a kindness for rounding a terrain corner. A bomb is an occupied gameplay
      // tile, not geometry to shave past: forgiving its diagonal corner lets the player overlap
      // the bomb even though straight-line movement correctly stops there.
      if (bomb) return true;
      /* The chamfer. See CORNER_CUT_UNITS.
       *
       * A tile the box only touches with a CORNER - it is in the first or last column of the
       * overlap AND the first or last row, with more than one of each - is forgiven while the
       * bite out of it is shallow on both axes. That is exactly the case that makes rounding a
       * block diagonally feel like catching on a nail, and the only case: anything you are
       * properly into fails the depth test and is as solid as it ever was.
       */
      /* The chamfer is a kindness to a person at the controls, not a fact about the world.
       *
       * A bot asking "can I stand here" has to ask about the square box. It is deciding whether a
       * tile is a place to be when a fuse runs out, and twelve pixels of shoulder inside a wall
       * corner is twelve pixels inside the blast on the other side of it - the corner cut lets you
       * ROUND a corner, it does not make the corner cover you. Bots that trusted it cut diagonals
       * into blasts they had correctly worked out they were clear of, and their suicides doubled.
       */
      if (!chamfer) return true;
      if (tx !== x0 && tx !== x1) return true;
      if (ty !== y0 && ty !== y1) return true;
      if (x0 === x1 || y0 === y1) return true;        // flush against a face, not a corner
      /* A LONE corner, or nothing.
       *
       * The chamfer exists so that rounding the corner of a block glances off it. It must not
       * also open a pocket: with a solid tile beside the corner as well, the gap the cut reaches
       * into is a dead end a tile deep, and a player who slid into it had a shoulder inside both
       * walls at once with every way out blocked - wedged, and the unstick cannot help, because
       * the position is legal by the very rule that produced it.
       *
       * So the forgiveness is withdrawn the moment the corner has company: if either tile between
       * it and the one the player is standing in is solid too, this is a wall face or a nook, not
       * a corner, and it is as solid as any other wall.
       */
      const cx = x >> 8, cy = y >> 8;
      if (!walkable(state.map, tx, cy, reduced) || !walkable(state.map, cx, ty, reduced)) return true;
      // How far into the tile the box reaches, on each axis.
      const intoX = tx === x0 ? (tx + 1) * UNITS_PER_TILE - (x - h) : (x + h) - tx * UNITS_PER_TILE;
      const intoY = ty === y0 ? (ty + 1) * UNITS_PER_TILE - (y - h) : (y + h) - ty * UNITS_PER_TILE;
      if (intoX > CORNER_CUT_UNITS || intoY > CORNER_CUT_UNITS) return true;
    }
  return false;
}

/* ─── the rails ───────────────────────────────────────────────────────────────────────────────
 *
 * Four small helpers and one loop. Everything about travel is in here, and all of it is integer
 * arithmetic on a 256-unit grid.
 */

/** Is this coordinate exactly on a lane centre line? */
const onLane = u => (u & (UNITS_PER_TILE - 1)) === HALF_TILE;

/** Is the pirate exactly on a tile centre - i.e. at a junction, where a turn may be spent? */
const atJunction = p => onLane(p.x) && onLane(p.y);

/**
 * Point the pirate at the nearest junction on their current lane - which may be behind them.
 *
 * The travel loop can only spend a turn while standing exactly on a tile centre, so every path
 * that wants a turn taken from mid-segment comes through here first. Nearest rather than
 * next-ahead: from flush against a wall the junction behind is the only one reachable, and from
 * a standstill mid-corridor the nearer one is simply the quicker answer.
 */
function faceNearestJunction(p, horizontal) {
  const along = horizontal ? p.x : p.y;
  const o = along & (UNITS_PER_TILE - 1);
  const forward = o < HALF_TILE;          // the centre of this tile is still ahead of us
  p.dir = horizontal ? (forward ? DIR_R : DIR_L) : (forward ? DIR_D : DIR_U);
}

/**
 * Flush against a wall with a turn waiting: pivot into it, this tick, without walking backwards.
 *
 * This is the "sometimes you jump back at a corner" bug, and it was not a rendering artefact.
 * Running into a dead end stops you FLUSH - 48 units past the centre of your tile, because that
 * is what makes a wall feel solid - and a turn can only be spent standing exactly on a tile
 * centre. So a turn pressed after the stop had to be reached by walking 48 units BACKWARDS, which
 * at boot speed is one whole tick: one tick of travel the wrong way with the sprite facing the
 * wrong way, then the turn. Press the same turn a tick earlier, while still exactly on the
 * junction, and the corner was instant - which is why it only happened sometimes.
 *
 * The 48 units are not optional; the rails put every turn on a tile centre and that is the whole
 * reason corners are reliable. What is optional is spending a visible tick of travel on them. So
 * they are folded INTO the turn: the along-axis goes back to the junction and the facing becomes
 * the one that was asked for, in the same tick, and the rest of the tick's pace is then spent down
 * the new lane. The renderer draws the tick as one line, so it reads as cutting the corner, which
 * is what the player asked for. Nobody gains ground: the distance is one they had already
 * travelled, and the exchange is a tick of latency for none.
 *
 * Refused unless the turn is actually takeable, so it never moves anybody for nothing.
 *
 * @returns true if the pivot happened, in which case the turn is spent and `dir` is the new one.
 */
function cornerPivot(state, p, horizontal) {
  const along = horizontal ? p.x : p.y;
  // Only from the far half of the tile - the flush band. Short of the centre the travel loop
  // already stops on the junction by itself, and exactly on it there is nothing to fix.
  if ((along & (UNITS_PER_TILE - 1)) <= HALF_TILE) return false;
  /* And only with the way ahead genuinely shut, which is what BOUNDS the step back.
   *
   * A blocked tile ahead means the hitbox cannot be inside it, so the furthest past the centre
   * you can be is flush - half a hitbox short of the boundary, 48 units. Without this guard the
   * same code reached from a standstill mid-corridor could snap half a tile, which is a teleport
   * and not a pivot.
   */
  if (canStand(state, p, ...aheadTile(p))) return false;

  if (!turnLands(state, p)) return false;

  const back = tileCentre(toTile(along));
  const nx = horizontal ? back : p.x, ny = horizontal ? p.y : back;
  // It is where we came from, so it is legal - unless a wall grew there or a bomb landed on it
  // while we stood flush. Verified rather than assumed, like every other move on the rails.
  if (blocked(state, p, nx, ny)) return false;

  p.x = nx; p.y = ny;
  p.dir = p.turnWant;
  clearTurn(p);
  return true;
}

/**
 * Could the buffered turn actually be spent at this tile's junction?
 *
 * The nearest junction on your lane is always the centre of the tile you are standing in, so this
 * is the same question `spendTurn` will ask when you get there - asked before setting off, which
 * is what stops the pirate setting off at all for a turn that is going to be refused.
 */
function turnLands(state, p) {
  const [vx, vy] = DIR_VEC[p.turnWant] ?? DIR_VEC[DIR_D];
  return canStand(state, p, toTile(p.x) + vx, toTile(p.y) + vy);
}

/** The tile immediately ahead along the current facing, as [tx, ty]. */
function aheadTile(p) {
  const [vx, vy] = DIR_VEC[p.dir] ?? DIR_VEC[DIR_D];
  return [toTile(p.x) + vx, toTile(p.y) + vy];
}

/**
 * Could this pirate stand on this tile?
 *
 * Asked at the TILE'S CENTRE, which is what makes it an exact question about one tile: a
 * lane-centred hitbox is 160 units inside a 256-unit tile, so `blocked` at a tile centre tests
 * that tile and nothing else. Probing a unit or two ahead instead - the obvious thing - tests the
 * tile you are already in, because the box has not reached the boundary yet.
 */
const canStand = (state, p, tx, ty) =>
  !blocked(state, p, tileCentre(tx), tileCentre(ty));

/** The next lane centre strictly ahead of `u` in direction `sign`. */
function nextCentre(u, sign) {
  const here = (u >> 8) * UNITS_PER_TILE + HALF_TILE;
  if (sign > 0) return here > u ? here : here + UNITS_PER_TILE;
  return here < u ? here : here - UNITS_PER_TILE;
}

/**
 * The furthest point along this lane that leaves the hitbox touching, but not inside, the
 * obstacle in the next tile.
 *
 * The far face of the tile we are standing in, pulled back by half a hitbox - 48 units past the
 * tile centre with the standard box, less with Reduction. It is what makes a wall feel solid
 * instead of repellent.
 */
function flushPoint(p, along, sign) {
  const half = halfBox(p);
  const tile = along >> 8;
  return sign > 0
    ? (tile + 1) * UNITS_PER_TILE - half
    : tile * UNITS_PER_TILE + half;
}

/**
 * Travel along the current lane, turning at junctions as the buffer allows.
 *
 * One segment at a time, where a segment ends at the next lane centre. That structure is the
 * whole trick, and it buys three things that a naive "move `speed` units, then see" does not:
 *
 *   - **No overshoot.** A turn is only ever spent standing exactly on a junction, so a corner is
 *     never rounded from half a tile past it and then corrected backwards.
 *   - **No lost pace.** Reaching a junction with movement left over spends the remainder down the
 *     NEW lane in the same tick, so a corner costs exactly nothing. A corner that cost a tick of
 *     pace is precisely what "catching on corners" feels like.
 *   - **A bounded loop.** A segment is at most 256 units and the fastest pace is 44, so at most
 *     two segments are crossed in a tick. The guard is a seatbelt, not the mechanism.
 *
 * @returns the distance actually travelled, in units.
 */
function railTravel(state, p, speed) {
  let left = speed;
  let moved = 0;

  for (let guard = 0; left > 0 && guard < 4; guard++) {
    // At a junction: spend a buffered turn if the tile it points at can be stood on.
    if (atJunction(p) && wantsTurn(p)) spendTurn(state, p);

    const [vx, vy] = DIR_VEC[p.dir] ?? DIR_VEC[DIR_D];
    const horizontal = vx !== 0;
    const sign = horizontal ? vx : vy;
    const along = horizontal ? p.x : p.y;

    /* How far we may travel in this direction right now.
     *
     * Always the NEXT LANE CENTRE ahead - and that is the part worth getting right, because a
     * junction is where a turn can be spent and skipping one loses the turn. Two earlier versions
     * both got this wrong in opposite directions: checking the way ahead only while standing on a
     * junction let a pirate who had stopped flush against a wall walk into it on the next tick,
     * and checking it unconditionally made a pirate approaching a wall jump straight to the flush
     * point - sailing over the junction in between, where their buffered turn was waiting.
     *
     * Asking "can I stand on the tile the next centre is IN" answers both. Before the centre of
     * your own tile that tile is the one you are standing in, so the limit is simply the centre.
     * At or past it, it is the next tile along, so a blocked one stops you flush against it. The
     * loop then comes back round, standing exactly on the junction, and spends the turn.
     */
    const junction = nextCentre(along, sign);
    const jtx = horizontal ? junction >> 8 : toTile(p.x);
    const jty = horizontal ? toTile(p.y) : junction >> 8;

    let limit = junction;
    if (!canStand(state, p, jtx, jty)) {
      /* Blocked - so stop FLUSH against it, not back at the last tile centre.
       *
       * A tile is 256 units and the hitbox is 160, so stopping at the centre leaves 48 units of
       * visible daylight between the pirate and the wall they are walking into: walls stop
       * feeling solid and start feeling repellent, and standing beside your own bomb looks like
       * standing a step away from it.
       *
       * Going flush leaves the pirate mid-segment, where a turn cannot be spent - which is
       * exactly why `step` glides back to the junction when a turn is pending and the way ahead
       * is shut. The two halves are one mechanism: walls that feel solid AND corners that never
       * refuse. Neither works without the other.
       */
      limit = flushPoint(p, along, sign);
    }

    const seg = Math.min(left, Math.max(0, sign * (limit - along)));
    if (seg <= 0) break;

    const to = along + sign * seg;
    const nx = horizontal ? to : p.x;
    const ny = horizontal ? p.y : to;
    // The arithmetic is the authority on the grid; `blocked` is the authority on geometry, and a
    // bomb or a chamfer can still disagree. Verified rather than trusted.
    if (blocked(state, p, nx, ny)) break;

    p.x = nx; p.y = ny;
    left -= seg;
    moved += seg;
  }

  return moved;
}

/**
 * Spend the buffered turn, here, now. Only ever called standing on a junction.
 *
 * Rum fumbles one turn in DRUNK_FUMBLE_EVERY: the request is dropped as though the corner were
 * missed. Deterministic in (tick, seat) so prediction fumbles identically rather than being
 * corrected into it - the same property the old sway had, for the same reason.
 */
function spendTurn(state, p) {
  const want = p.turnWant;
  const [vx, vy] = DIR_VEC[want] ?? DIR_VEC[DIR_D];
  const tx = toTile(p.x), ty = toTile(p.y);
  if (!canStand(state, p, tx + vx, ty + vy)) return false;

  if (has(p, STATUS.DRUNK)) {
    const t = state.tick + p.i * 37;
    if (t % DRUNK_FUMBLE_EVERY === 0) { clearTurn(p); return false; }
  }

  p.dir = want;
  clearTurn(p);
  return true;
}

const clearTurn = p => { p.turnWant = DIR_NONE; p.turnLeft = 0; };

/* Is there a turn waiting? NEVER `if (p.turnWant)`.
 *
 * DIR_R is 0, so truthiness reads a request to turn right as no request at all - which is exactly
 * the bug this helper exists to make impossible to write again. Gated on the BUDGET rather than
 * on the direction, so there is one answer to "is a turn pending" and it cannot disagree with
 * itself. See DIR_NONE in constants.js.
 */
const wantsTurn = p => p.turnLeft > 0 && p.turnWant !== DIR_NONE;

/**
 * Pin the axis we are NOT travelling along to its lane centre. The invariant, enforced.
 *
 * Never while the position is already illegal. `unstick` eases out of a wall along ONE axis over
 * several ticks, and a snap on the other axis undoes it: an entombed pirate was shoved out and
 * pulled straight back in, every tick, which is worse than the problem the seatbelt exists for.
 * Skipping here leaves the pirate briefly off-lane, which is exactly what being stuck in a wall
 * is - and the rails put them back on one as soon as they are standing somewhere legal.
 */
function pinToLane(state, p, speed) {
  if (blocked(state, p, p.x, p.y, false)) return false;
  const horizontal = p.dir === DIR_L || p.dir === DIR_R;
  const perp = horizontal ? p.y : p.x;
  if (onLane(perp)) return false;

  /* Walk onto the lane, never teleport onto it.
   *
   * Capped at one tick of pace. Unclamped, this was a snap of up to half a tile in a single
   * frame - 128 units sideways - and it fired exactly when it was most visible: the tick a pirate
   * eased out of a wall and became legal again, they were yanked onto the nearest lane. The old
   * code had a 255-unit version of the same artefact in its flush-to-wall slide, so this is the
   * second time the same class of bug has been found here; bounding it by the legs is what stops
   * a third.
   *
   * In ordinary play this never runs at all - rail travel keeps the invariant exactly, so there
   * is nothing to correct. It only fires after something external moved the pirate: an unstick,
   * a spawn, a map change.
   *
   * @returns true if it had to correct, in which case the caller must NOT also travel this tick.
   *   Easing and travelling together would move both axes at once, which is the one thing a rail
   *   pirate may never do - it is free 2D movement, briefly, and the invariant the whole design
   *   rests on would be false for those ticks. A tick spent getting back onto the rails is not a
   *   tick of walking, exactly as a tick spent being shoved out of a wall is not.
   */
  const gap = tileCentre(toTile(perp)) - perp;
  const ease = Math.sign(gap) * Math.min(Math.abs(gap), Math.max(1, speed));
  const want = perp + ease;
  const nx = horizontal ? p.x : want;
  const ny = horizontal ? want : p.y;
  // Refuse a move that would put us inside something. That leaves the position illegal, which is
  // exactly the case `unstick` exists for - better than easing into a wall to satisfy a
  // bookkeeping invariant.
  if (blocked(state, p, nx, ny)) return false;
  p.x = nx; p.y = ny;
  return true;
}

/**
 * Nothing may leave a player unable to move. Ever.
 *
 * `moveAxis` assumes you start from a legal position and only ever asks whether the *next* one is
 * legal - so a player who somehow ends up overlapping a solid tile finds every candidate blocked,
 * including the flush-to-wall slide, and is frozen for good. The ways in are all rare and all
 * real: a wall regrowing on top of you, Reduction expiring while you stand inside a column, a map
 * change, a spawn point that is no longer clear.
 *
 * So: if the position we are *already* in is illegal, leave for the nearest legal tile centre.
 * This runs off nothing but the shared state, so the client predicts the identical escape and
 * reconciliation stays a no-op. It never fires in normal play - if it is firing, something else
 * is wrong and this is the seatbelt, not the fix.
 *
 * @returns true if it had to intervene
 */
export function unstick(state, p) {
  /* Terrain only. A bomb never pushes anybody, ever.
   *
   * This is the seatbelt for positions that are illegal and cannot be walked out of: a wall
   * grown on top of you, Reduction expiring while you stand in a column, a map change, a spawn
   * that is no longer clear. Every one of those is genuinely inescapable without help.
   *
   * A bomb is not. `bombSolid` already treats one you are touching as passable, so you can
   * always simply walk off it - and a shove on top of that is the game moving you when you were
   * perfectly capable of moving yourself. Passing `false` here makes that structural rather
   * than a property of the current tuning: even if bomb solidity changes again, the unstick
   * cannot start pushing people off bombs as a side effect.
   */
  const stuckInTerrain = blocked(state, p, p.x, p.y, false);
  if (!stuckInTerrain) {
    /* Not in a wall, but possibly a few units inside a bomb that has just firmed up.
     *
     * Worth a nudge rather than nothing: a bomb you are standing fractionally inside should
     * ease you out so it feels like an object, and the distance involved is a handful of units
     * rather than the eighty the old centre-based rule produced. Half the terrain pace, because
     * this one is cosmetic and a wall is not.
     */
    if (!blocked(state, p, p.x, p.y)) return false;
    const gentle = Math.max(1, UNSTICK_MIN_PACE >> 1);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = p.x + dx * gentle, ny = p.y + dy * gentle;
      if (blocked(state, p, nx, ny)) continue;
      p.x = nx; p.y = ny;
      return true;
    }
    return false;
  }

  const tx = p.x >> 8, ty = p.y >> 8;
  // Nearest first, and in a fixed order so two machines always pick the same way out.
  const ring = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]];
  for (const [dx, dy] of ring) {
    const nx = tileCentre(tx + dx), ny = tileCentre(ty + dy);
    // The destination ignores bombs too: a bomb is somewhere you can stand your way out of,
    // and refusing a tile because of one can leave a genuinely entombed player with nowhere.
    if (blocked(state, p, nx, ny, false)) continue;

    // Slide out, do not teleport out.
    //
    // Snapping straight to the target was correct and felt awful: a wall growing on you threw you
    // a whole tile in one frame, and the rendered position had to be hard-cut to follow. Walking
    // out over a few ticks reads as being shoved, which is what it is. It stays deterministic -
    // same state, same arithmetic, same answer on both machines - so prediction still agrees.
    //
    // One axis at a time, matching the rest of movement, and the larger gap first so the escape
    // always makes progress rather than dithering between two half-steps.
    const gx = nx - p.x, gy = ny - p.y;
    const horizontal = Math.abs(gx) >= Math.abs(gy);
    const gap = horizontal ? gx : gy;
    const left = Math.abs(gap);
    const pace = Math.max(UNSTICK_MIN_PACE, ((speedOf(p) * UNSTICK_PACE_NUM) / UNSTICK_PACE_DEN) | 0);
    const rate = Math.min(Math.max(left >> UNSTICK_EASE_SHIFT, UNSTICK_MIN_UNITS), pace);
    const move = Math.sign(gap) * Math.min(left, rate);
    if (horizontal) p.x += move; else p.y += move;
    return true;
  }
  return false;     // boxed in on all nine tiles; the blast that caused it will resolve it
}

/**
 * Advance one player by one tick. `mask` is the input bitmask from docs/PROTOCOL.md §3.
 * Pure in everything that matters: same player, same map, same mask -> same result, every time.
 */
export function step(state, p, mask) {
  if (!p || !p.alive) return;

  // Before anything reads the position, make sure it is one we could legally be standing in.
  unstick(state, p);

  if (p.slideCool > 0) p.slideCool--;

  /* The slide owns the tick.
   *
   * While one is running the keys do nothing: no steering, no braking, no bomb-key dance to cut it
   * short. That is the trade the stamina paid for - three tiles of commitment, and the decision
   * was made when you double-tapped. It also means the whole thing is a function of (velocity,
   * direction, map), which is why the client can replay it to the unit.
   *
   * No stamina call either way. The cost was taken in full at the launch; draining on top of that
   * would charge twice, and regenerating mid-slide would make a slide the fastest way to rest.
   */
  if (p.slideV > 0) {
    p.moving = true;
    if (stepSlide(state, p)) return;
    // It ended this tick. Fall through on this tick's keys, so landing out of a slide already
    // running keeps running rather than pausing for a tick.
  } else if ((mask & IN_SLIDE) && startSlide(state, p, mask)) {
    p.moving = true;
    stepSlide(state, p);
    return;
  }

  let dx = ((mask & IN_RIGHT) ? 1 : 0) - ((mask & IN_LEFT) ? 1 : 0);
  let dy = ((mask & IN_DOWN) ? 1 : 0) - ((mask & IN_UP) ? 1 : 0);

  if (has(p, STATUS.CHANGELING)) { dx = -dx; dy = -dy; }

  /* Water: half pace, and you slide.
   *
   * Every tick you walk in a puddle tops the slide up; let go and you keep going the way you are
   * facing until it runs out. Facing, not "the keys you last held", because facing is already on
   * the wire and is always the axis you actually travelled - so the client replays the slide
   * from nothing but `slide` and `dir`. Leaving the water ends it at once: the floor is not wet.
   */
  const wet = inPuddle(state, p);
  let coasting = false;
  if (!wet) p.slide = 0;
  else if (dx || dy) p.slide = PUDDLE_SLIDE_TICKS;
  else if (p.slide > 0) {
    p.slide--;
    [dx, dy] = DIR_VEC[p.dir] ?? DIR_VEC[DIR_D];
    coasting = true;
  }

  if (!dx && !dy) { p.moving = false; stamina(p, false); return; }

  let speed = speedOf(p);
  const tx = p.x >> 8, ty = p.y >> 8;
  if (tileAt(state.map, tx, ty) === BLOCK.FLOOR && mossyTile(tx, ty)) {
    // Faint moss is a 5% drag; a fully dense patch is a 25% drag. The same continuous field that
    // paints the patch drives this, so crossing a ragged edge changes pace smoothly and not as a
    // binary tile effect.
    const intensity = mossValue(tx + 0.5, ty + 0.5);
    const slow = 0.1 + 0.25 * Math.min(1, intensity);
    speed = Math.max(1, (speed * (1 - slow)) | 0);
  }
  if (wet) speed = Math.max(1, ((speed * PUDDLE_SPEED_NUM) / PUDDLE_SPEED_DEN) | 0);
  // Sliding is not running: it costs no stamina.
  stamina(p, !coasting);
  p.moving = true;

  /* Resolve the input into travel along this lane, plus at most one turn request.
   *
   * The current lane axis comes from `dir`. Whichever input component lies ALONG it is travel;
   * whichever lies across it is a turn request. With two keys held one of each is guaranteed -
   * there is no such thing as two cross-lane components - so this is also where diagonals go: a
   * diagonal is "keep going, and take the next corner that way", which is what a player holding
   * two keys into a junction is actually asking for.
   */
  const horizontal = p.dir === DIR_L || p.dir === DIR_R;
  const along = horizontal ? dx : dy;
  const across = horizontal ? dy : dx;
  let pivoted = false;

  if (across) {
    const want = horizontal
      ? (across > 0 ? DIR_D : DIR_U)
      : (across > 0 ? DIR_R : DIR_L);
    // Re-stamped every tick the key is held, so a held direction never expires. The buffer is
    // only ever about a press already let go of.
    p.turnWant = want;
    p.turnLeft = TURN_BUFFER_UNITS;
  }

  if (along) {
    // Along the lane, including a straight reversal - which needs no junction, because the tile
    // behind you on your own lane is one you just came from.
    p.dir = horizontal
      ? (along > 0 ? DIR_R : DIR_L)
      : (along > 0 ? DIR_D : DIR_U);

    /* Running into a shut door with a turn waiting: back up to the junction and take it.
     *
     * This is how corners are actually taken under pressure - hold the direction you are going
     * and press the one you want, and let the game sort it out at the corner. The pirate is
     * flush against the wall, which is mid-segment, so the turn cannot be spent where they are
     * standing; without this they sit in the corner with the request expiring, which is the
     * complaint rails were built to answer.
     *
     * Only when the way along the lane is genuinely shut. A pirate with somewhere to go keeps
     * going, and spends the turn at the junction they are already heading for.
     */
    if (wantsTurn(p) && !atJunction(p) && !canStand(state, p, ...aheadTile(p))) {
      /* A turn that cannot land is DROPPED, and this is the flip people saw.
       *
       * Hold two keys into a corner where both ways are shut - down into the floor of the map
       * while also pressing right into a wall - and every tick did this: the cross press became a
       * turn request, the request could not be spent flush, so the pirate was turned round to walk
       * back to the junction; the next tick the along-lane press turned them round again; the
       * tick after that, back. Facing opposite ways at fifteen hertz, and bouncing 48 units up and
       * down with it, for as long as the keys were held. The request was re-stamped every tick, so
       * it could never expire its way out either.
       *
       * Asking whether the turn will land before setting off ends it: if the tile it points at is
       * shut there is nothing at that junction worth walking to, so the request goes and the
       * pirate keeps facing the way they are actually travelling.
       */
      if (!turnLands(state, p)) clearTurn(p);
      // Pivot into the corner if we can, and only walk back to the junction if we cannot.
      else if (cornerPivot(state, p, horizontal)) pivoted = true;
      else faceNearestJunction(p, horizontal);
    }
  } else if (!coasting) {
    /* NOTHING pressed along this lane, so the pirate must not continue down it.
     *
     * This was the ugliest bug of the rail work and it broke the spec's own anti-goal - a press
     * doing something other than what it asked. Standing at a junction facing down with a wall
     * to the right, a press of RIGHT became a turn request, the request was refused by the wall,
     * and travel then carried on along the old lane: you pressed right and walked DOWNWARDS.
     *
     * So when there is no along-lane input, the only two things that may happen are taking the
     * turn and heading for the junction where it can be taken.
     */
    if (atJunction(p) && wantsTurn(p)) {
      /* Take it if it is legal. If it is not, still FACE it and drop the request.
       *
       * Facing what you pressed is what every version of this game has done, and it is not
       * cosmetic: `dir` is what bombs are aimed along. Pressing into a wall should turn you to
       * look at the wall you are about to bomb, and travel then nudges you flush against it.
       *
       * Only ever with no along-lane input, which is what separates "standing here, pressing
       * right into a wall" from "running right down a corridor while holding up" - the second
       * must keep running, not stop and stare at the ceiling.
       */
      /* Read the direction BEFORE asking, because asking can clear it.
       *
       * `spendTurn` drops the request on a drunk fumble, so `p.turnWant` is already DIR_NONE by
       * the time it returns false - and assigning that to `p.dir` left a pirate facing -1, which
       * is not a direction. Nothing crashed; `DIR_VEC[-1]` simply fell back to DIR_D and the
       * pirate quietly walked the wrong way for a tick. Found by the whole-game soak, which is
       * the only test shaped to notice.
       */
      const want = p.turnWant;
      if (!spendTurn(state, p)) {
        if (want !== DIR_NONE) p.dir = want;
        clearTurn(p);
      }
    } else if (wantsTurn(p)) {
      /* Head for the nearest junction, so the waiting turn can actually be spent.
       *
       * Two situations, which look different and are the same: standing still mid-corridor and
       * pressing across the lane, and sitting flush against a wall and pressing across the lane.
       * Flush is mid-segment, so both leave a turn that is unspendable where the pirate is
       * standing - and with no along-lane input they would never reach a junction on their own.
       * The press would do nothing until the buffer expired, which is the exact "stuck on a
       * corner" feeling the rails exist to remove, re-introduced by the flush stop that was
       * supposed to make walls feel solid. The two features only work together.
       *
       * The NEAREST junction, which may be behind them - unless they are flush against a wall,
       * in which case the pivot takes the corner here and now rather than walking back to it.
       */
      /* Same rule as above: a turn with a wall behind it is not worth walking to a junction for.
       * Face what was pressed and drop it, which is exactly what spending it at the junction would
       * have done on arrival - see the refusal a few lines up. */
      if (!turnLands(state, p)) { p.dir = p.turnWant; clearTurn(p); }
      else if (cornerPivot(state, p, horizontal)) pivoted = true;
      else faceNearestJunction(p, horizontal);
    }
  }

  /* A correction owns the tick; see pinToLane. In ordinary play neither of these fires.
   *
   * The pivot owns it for the same reason the lane correction does: it has already moved the
   * pirate along the lane this tick, and travelling on top of that would be two axes of movement
   * bought with one tick of pace - the one thing rail travel may never do. One tick to turn in the
   * corner, facing the way you asked, and the next tick walks out of it. */
  const travelled = (pivoted || pinToLane(state, p, speed)) ? 0 : railTravel(state, p, speed);

  /* `moving` is GROUND COVERED, not keys held.
   *
   * It drives the two-frame walk cycle in the renderer, and it was set from the input - so a
   * pirate holding a direction into a wall walked on the spot forever. The sprite's two frames
   * are a stride, and a stride played against a position that is not changing is a pirate
   * twitching from side to side: reported as "hold down against a wall and you jitter left and
   * right", and that is exactly what it was. Nothing else about the tick changes; the stamina
   * drain above is still charged for pressing, because leaning on a wall is effort.
   */
  p.moving = travelled > 0 || pivoted;

  // One last chance at the turn, so arriving exactly on a junction this tick turns on this tick
  // rather than on the next. Without it every corner costs a tick at the pace that lands square.
  if (atJunction(p) && wantsTurn(p)) spendTurn(state, p);

  /* Spend the buffer's budget on the ground actually covered.
   *
   * Charged AFTER the travel and only for distance travelled, which is the two properties that
   * make the promise hold: a pirate pressed against a wall covers no ground, so their request
   * does not quietly rot while they are stuck, and a fast pirate and a limping one both get the
   * same tile and a half of grace rather than the same number of ticks. */
  if (wantsTurn(p)) {
    p.turnLeft -= travelled;
    if (p.turnLeft <= 0) clearTurn(p);
  }
}

/** Every alive player, in seat order. Order is part of determinism - never iterate a Map here. */
export function stepAll(state, inputs) {
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    if (p && p.alive) step(state, p, inputs[i] | 0);
  }
}
