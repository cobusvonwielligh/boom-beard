// The tick, in order.
//
// This is the only place that decides the order of operations, and the order is part of the
// rules - reordering these changes outcomes, and a new step in the wrong place is the classic
// cause of "it desyncs after about a minute". docs/ARCHITECTURE.md §4.

import {
  IN_BOMB, SCORE, STATUS, HITBOX_UNITS,
  HITBOX_REDUCED_UNITS, START_BOMBS, START_RADIUS, RESPAWN_DELAY_TICKS,
  FIRE_TICKS, FIRE_LETHAL_TICKS, SHIELD_GRACE_TICKS, MAX_HP, STAMINA_MAX,
  HITBOX_FIRE_NUM, HITBOX_FIRE_DEN, FUSE_TICKS, MAX_RADIUS, DEATH_BOMB_ONE_IN,
} from '../constants.js';
import { expireStatuses, has, toTile, recordStreakKill, resetStreak } from './state.js';
import { stepAll } from './movement.js';
import { place, detonate, expireFires, bombable, kick, slideBombs } from './bombs.js';
import { randInt } from '../util/rng.js';
import { collect, scatterOnDeath } from './perks.js';
import { regenerate, expirePuddles } from './blocks.js';
import { burns } from './fire.js';
import { spread as spreadStatuses, daze } from './statuses.js';
import { gulls } from './gulls.js';

export function tick(state, inputs, { onRespawn } = {}) {
  // 1. statuses expire before anything reads them
  for (const p of state.players) if (p) expireStatuses(state, p);

  // 2. movement
  stepAll(state, inputs);

  // 2b. anybody a slide went through, while the overlap that proves it still exists. Before the
  // bombs, so a pirate knocked silly this tick cannot place one on the way down.
  daze(state);

  /* 2c. and anything a slide went THROUGH rather than into: bombs are kicked off the board here.
   *
   * Beside the daze and for the same reason - the overlap that proves it is still true on this
   * tick and gone on the next. Before placement, which is what gives "placed and kicked on the
   * same tick" a definite answer rather than a race: the bomb either is not down yet and is
   * placed normally, or it is down and is kicked. */
  kick(state);

  /* 2d. and bombs already skating carry on, a tile at a time.
   *
   * After the kick, so a bomb kicked this tick starts its clock here rather than moving on the
   * tick it was touched. Before placement and before `detonate`, so a bomb that arrives on a
   * tile this tick is on that tile for every rule that runs afterwards - the blast it makes, the
   * chain it joins, and whether somebody may place a bomb where it now sits. */
  slideBombs(state);

  // 3. bombs placed, ascending seat so a tie on one tile is resolved the same way everywhere
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    if (p) place(state, p, inputs[i] | 0);
  }

  // 4 & 5. resolve due fuses and any fire-wave effects arriving this tick
  detonate(state);

  // 6. fire damage: blocks were already hit inside detonate, players die here
  killInFire(state);

  // 6b. gulls overhead, and any that dived into this tick's fire. After the fire and before the
  // pickups, so a coin knocked out of one lands on a floor everyone is about to check.
  gulls(state);

  // 7. pickups. Perks are fireproof - see the note in perks.js.
  collect(state);

  // 8. statuses spread on contact
  spreadStatuses(state);

  // 9. walls grow back
  regenerate(state);

  // respawn requests, and fire that has burned out
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    if (p && !p.alive && !p.respawnRequested &&
        (inputs[i] & IN_BOMB) && state.tick >= p.respawnAt) onRespawn?.(p);
  }
  expireFires(state);
  expirePuddles(state);

  state.tick++;
}

/**
 * Anyone standing in fire is hurt, unless they are invulnerable or spend a shield - and the
 * second hurt is a death. See MAX_HP.
 *
 * Kill credit goes to the owner of the fire tile, which is why ordering inside `detonate` is
 * deterministic - in a chain, two players' bombs can both be burning the same square.
 */
function killInFire(state) {
  if (!state.fires.length) return;
  // Only fire that is still in its lethal window, not merely still on screen. A blast is drawn
  // for FIRE_TICKS and kills for the first two thirds of that; the tail is embers.
  const deadline = state.tick + (FIRE_TICKS - FIRE_LETHAL_TICKS);
  const fresh = state.fires.filter(f => f.until > deadline && (f.startsAt ?? 0) <= state.tick);
  if (!fresh.length) return;
  // Rum: the arms stop hurting, the core still does. Computed once rather than per player.
  const cores = fresh.filter(f => f.kind === 'core');

  for (const p of state.players) {
    if (!p || !p.alive) continue;
    if (has(p, STATUS.INVULN)) continue;

    // The lethal box is smaller than the sprite. See HITBOX_FIRE_NUM.
    const box = has(p, STATUS.REDUCTION) ? HITBOX_REDUCED_UNITS : HITBOX_UNITS;
    const half = ((box * HITBOX_FIRE_NUM / HITBOX_FIRE_DEN) | 0) >> 1;
    // Drunk: only the tile the bomb itself was on. Everything else in the blast is survivable.
    const lethal = has(p, STATUS.DRUNK) ? cores : fresh;
    if (!lethal.length || !burns(lethal, p.x, p.y, half)) continue;

    /* Every blast that catches you costs one - a shield first, then a half of your health.
     *
     * Two mechanisms, and they answer two different questions. `hitBy` is MEMORY: it holds the
     * blasts you have already paid for, so a single explosion cannot charge you once per tick for
     * the ten ticks it burns. `shieldGrace` is a TIMER: once something has cost you, the next six
     * tenths of a second cannot cost you again - so a blast that reaches you a moment AFTER the
     * first is shrugged off, and the explosion that hit you can never come back for more.
     *
     * But blasts that land in the SAME instant are each paid for. Two bombs in a chain whose
     * flames cross on you are two hits: two shields, or a shield and a half, or both halves. It
     * used to be one shield for any number of them, which made standing in a crossfire the safest
     * place on the board - the opposite of what a crossfire is for. Chains resolve in one tick
     * (see detonate), so "the same instant" is exactly "this tick". */
    if (p.shieldGrace && state.tick < p.shieldGrace) continue;
    const live = new Set(fresh.map(f => f.src));
    p.hitBy = (p.hitBy || []).filter(src => live.has(src));
    const inBox = f =>
      f.tx >= (p.x - half) >> 8 && f.tx <= (p.x + half - 1) >> 8 &&
      f.ty >= (p.y - half) >> 8 && f.ty <= (p.y + half - 1) >> 8;
    // One entry per blast reaching you this tick that you have not already paid for - the blast
    // on your centre tile first, because that is who the kill goes to (RULES.md §3).
    const ctx = toTile(p.x), cty = toTile(p.y);
    const ordered = [...lethal.filter(f => f.tx === ctx && f.ty === cty), ...lethal];
    const newHits = [];
    for (const f of ordered) {
      if (!inBox(f) || p.hitBy.includes(f.src) || newHits.some(g => g.src === f.src)) continue;
      newHits.push(f);
    }
    if (!newHits.length) continue;

    /* Pay for them in order: shields, then health, then your life. The blast that takes the last
     * of it is the one that gets the kill. Everything that reached you this tick goes into
     * `hitBy` either way, so none of them can charge you again when the grace runs out. */
    let fatal = null;
    for (const f of newHits) {
      p.hitBy.push(f.src);
      for (let unit = 0; unit < (f.streakPowered ? 2 : 1) && !fatal; unit++) {
        if (p.shields > 0) {
          p.shields--;
          state.events.push({ e: 'shield', tick: state.tick, i: p.i, left: p.shields });
        } else if ((p.hp ?? MAX_HP) > 1) {
          p.hp = (p.hp ?? MAX_HP) - 1;
          state.events.push({ e: 'hurt', tick: state.tick, i: p.i, hp: p.hp, by: f.owner });
        } else {
          fatal = f;
        }
      }
    }
    p.shieldGrace = state.tick + SHIELD_GRACE_TICKS;
    if (!fatal) continue;

    // Who gets the kill.
    //
    // The centre tile is the documented rule (RULES.md §3) and stays the first choice, so every
    // outcome that was already right is unchanged. The fallback used to be `fresh[0]` - the oldest
    // still-burning fire ANYWHERE on the map - which handed the kill score and feed line to a
    // player who was not involved, or scored a suicide when that stray fire happened to be the
    // victim's own. A 160-unit hitbox straddles a tile boundary most of the time, so the centre
    // tile misses often and the wrong fallback fired often.
    //
    // So: fall back to the fire the hitbox actually overlaps, scanning `fresh` in array order,
    // which is `detonate` push order and therefore deterministic. One of them must match, because
    // `burns()` just returned true for the identical box.
    //
    // With shields in play the answer is narrower still: the blast that got past them. Shields
    // spent on earlier blasts this tick do not hand those blasts the kill. `newHits` is already
    // in that order - centre tile first, then the rest as `detonate` pushed them.
    const killer = fatal.owner;
    p.hitBy = [];

    /* A parting shot, one death in ten. See DEATH_BOMB_ONE_IN.
     *
     * BEFORE the loadout is reset below, because the bomb carries the radius they died with - it
     * is their bomb. And before `scatterOnDeath`, so the scatter can see it and skip its tile: a
     * bomb makes its tile solid, so a perk dropped underneath one is unreachable for the whole
     * fuse, which is the same defect `bombTile` was fixed for.
     */
    deathBomb(state, p);

    scatterOnDeath(state, p);

    p.alive = false;
    p.deaths++;
    resetStreak(p);
    p.shieldGrace = 0;
    p.bombs = START_BOMBS;
    p.radius = START_RADIUS;
    p.speed = 0;
    p.shields = 0;
    p.stamina = STAMINA_MAX;
    p.staminaLevel = 0;
    p.tired = false;
    p.hp = 0;
    p.status = 0;
    p.statusUntil = {};
    p.respawnAt = state.tick + RESPAWN_DELAY_TICKS;

    if (killer === p.i) {
      p.score = Math.max(0, p.score + SCORE.SUICIDE);
    } else {
      const k = state.players[killer];
      if (k) {
        k.kills++;
        k.score += SCORE.KILL;
        recordStreakKill(k, state.tick);
      }
    }
    state.events.push({
      e: 'died', tick: state.tick, i: p.i, by: killer, x: p.x, y: p.y,
      streak: state.players[killer]?.streakCount ?? 0,
    });
  }
}

/**
 * One death in ten: a live bomb on the tile where it happened, owned by the player who died.
 *
 * Refused on a tile that cannot take a bomb - one already there, or standing water - exactly as a
 * placed bomb would be, by asking `bombable` rather than by keeping a second copy of the rule.
 * A refused roll is simply no bomb this time; it does not re-roll or look for a neighbouring tile,
 * because "where you died" is the whole idea and anywhere else is just a bomb appearing.
 *
 * Emits the same `bomb` event a placed one does, so every client draws and predicts it with the
 * code it already has and nothing new goes on the wire.
 */
function deathBomb(state, p) {
  if (randInt(state.next, DEATH_BOMB_ONE_IN) !== 0) return;
  const tx = toTile(p.x), ty = toTile(p.y);
  if (!bombable(state, tx, ty)) return;

  const radius = Math.min(p.radius, MAX_RADIUS);
  const bomb = {
    id: state.nextBombId++,
    tx, ty,
    o: p.i, owner: p.i,
    r: radius, radius,
    at: state.tick + FUSE_TICKS,
    fuseTicks: FUSE_TICKS,
    // Never streak-powered: a streak is a run of kills you are on, and this one ended it.
    streakPowered: false,
  };
  state.bombs.push(bomb);
  state.events.push({
    e: 'bomb', tick: state.tick, id: bomb.id, x: tx, y: ty, o: p.i, r: radius, at: bomb.at,
  });
}
