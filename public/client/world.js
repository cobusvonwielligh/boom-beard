// The client's mirror of the simulation, plus prediction and replay.
//
// Your own player is predicted from your keys and corrected by replaying unacknowledged inputs.
// Everyone else is drawn from snapshots, a little in the past. docs/NETCODE.md §2.

import {
  INTERP_DELAY_TICKS, TRACER_SAMPLES, TRACER_EVERY_TICKS, FIRE_TICKS, setSeatColours, MAX_HP,
  DIR_NONE,
} from '/shared/constants.js';
import { createPlayer, tileCentre } from '/shared/sim/state.js';
import { decodeCells, packCell, cellType } from '/shared/maps.js';
import { BLOCK, BLOCK_HP } from '/shared/constants.js';
import { step, blocked } from '/shared/sim/movement.js';
import { spread } from '/shared/sim/fire.js';
import { pickPair } from '/shared/util/interp.js';

export function createWorld() {
  const w = {
    ready: false,
    you: -1,
    // Whose seat wears the crown. Refreshed by the scores broadcast; -1 until one arrives.
    host: -1,
    tick: 0,
    map: null,
    players: [],          // index = seat
    bombs: [],
    perks: [],
    puddles: [],          // melted ice; movement reads these, so prediction needs them too
    gulls: [],            // flight descriptions; drawn with gullAt, see shared/sim/gulls.js
    fires: [],            // derived locally, never sent - see docs/NETCODE.md §1a
    burst: new Set(),     // bomb ids already turned into fire here
    pending: [],          // inputs sent but not yet acknowledged
    lastCorrection: 0,
  };

  w.me = () => w.players[w.you] || null;

  w.applyWelcome = m => {
    if (m.map) {
      w.map = { id: m.map.id, w: m.map.w, h: m.map.h, cells: decodeCells(m.map.cells), spawns: m.map.spawns };
    }
    if (m.mapOnly) return;
    // -1 means spectating: there is no local player, so prediction and reconciliation have
    // nothing to act on and every player in the snapshot is a remote one. Nothing else in here
    // needs to know - `w.players[-1]` is undefined, which is exactly the right answer to
    // "where am I" when the answer is "nowhere".
    w.you = m.you;
    w.observing = !!m.observing;
    w.roundEndsAtTick = m.roundEndsAtTick ?? w.roundEndsAtTick;
    /* The tick the freeze lifts on. Nothing is predicted or sent before it - see the loop in
     * main.js - because the server is zeroing every input until then, and predicting movement
     * the server is refusing is exactly the rubber-band this avoids. Defaults to 0 so a server
     * that does not send it behaves as it always did. */
    w.startsAtTick = m.startsAtTick ?? 0;
    w.tick = m.tick;
    // Who is what colour. Before the players, so nothing is ever drawn in a seat's old colour.
    setSeatColours(m.pal);
    w.players = [];
    for (const p of m.players) w.players[p.i] = hydrate(p);
    w.bombs = m.bombs || [];
    w.perks = m.perks || [];
    w.puddles = m.puddles || [];
    w.gulls = m.gulls || [];
    // Derived state belongs to the old map; a new round must not inherit its fires.
    w.fires.length = 0;
    w.burst.clear();
    w.pending.length = 0;
    w.ready = true;
  };

  function hydrate(wire, existing) {
    const p = existing || createPlayer(wire.i, wire.name || `p${wire.i}`);
    p.x = wire.x; p.y = wire.y; p.dir = wire.d;
    p.alive = wire.st === 1;
    p.bombs = wire.b; p.radius = wire.f; p.speed = wire.sp; p.shields = wire.sh;
    p.score = wire.s; p.kills = wire.k; p.deaths = wire.dd; p.status = wire.stat;
    p.streakCount = wire.sk ?? 0; p.streakLastKillTick = wire.skt ?? -1;
    p.coins = wire.c || 0;
    // Absent means whole; see MAX_HP and playerWire.
    p.hp = wire.hp ?? MAX_HP;
    p.arriving = !!wire.ar;
    p.arriveAt = wire.art ?? 0;
    p.respawnTicks = wire.rr ?? null;
    if (wire.sta !== undefined) { p.stamina = wire.sta; p.staminaLevel = wire.stl; p.tired = !!wire.tr; }
    p.slide = wire.sl ?? 0;
    // The deliberate slide: absent means not sliding, which is almost every tick. See playerWire.
    p.slideV = wire.sv ?? 0;
    p.slideDir = wire.sd ?? p.dir;
    p.slideFor = wire.sf ?? 0;
    p.slideCool = wire.sc ?? 0;
    // The buffered turn. Absent means none; see playerWire and the RAILS note in sim/movement.js.
    p.turnWant = wire.tl > 0 ? wire.tw : DIR_NONE;
    p.turnLeft = wire.tl ?? 0;
    p.gulled = !!wire.gl;
    if (wire.name) p.name = wire.name;
    p.rx ??= p.x; p.ry ??= p.y;        // rendered position, smoothed for remotes
    p.trail ??= [];
    p.buf ??= [];                       // recent snapshots, for interpolation
    return p;
  }

  /** One local tick: predict our own movement immediately, and remember the input for replay. */
  w.predict = (tick, mask) => {
    const me = w.me();
    if (!me) return;
    w.pending.push({ tick, mask });
    if (w.pending.length > 200) w.pending.shift();   // connection is gone; stop growing
    step(w, me, mask);
    // Deliberately does NOT touch rx/ry. The rendered position eases toward the simulated one in
    // interpolate(), which is what absorbs reconciliation corrections instead of showing them.
  };

  /**
   * Turn a bomb into fire, locally, using the same spread function the server runs.
   *
   * This is the whole latency story: the explosion tick is fixed when the bomb is placed, so a
   * client computes the identical blast at the identical tick without being told. Nobody ever
   * dies to a blast that had not appeared on their screen. docs/NETCODE.md §1a.
   */
  w.burstBomb = (bomb, ignitionTick = w.tick) => {
    if (!bomb || w.burst.has(bomb.id) || !w.map) return;
    w.burst.add(bomb.id);
    const waveTick = Math.floor(ignitionTick);
    // Same bomb list the server used, from the same snapshot, so the derived blast matches -
    // including where its arms stop against other bombs.
    const { cells } = spread(
      w.map,
      { id: bomb.id, tx: bomb.tx, ty: bomb.ty, radius: bomb.r ?? bomb.radius },
      w.bombs,
    );
    for (const c of cells) {
      const startsAt = waveTick + (c.delayTicks ?? 0);
      w.fires.push({
        ...c, startsAt, until: startsAt + FIRE_TICKS,
        owner: bomb.o ?? bomb.owner, streakPowered: !!bomb.streakPowered,
      });
      const neighbour = w.bombs.find(b => b.id !== bomb.id && b.tx === c.tx && b.ty === c.ty);
      if (neighbour) neighbour.at = Math.min(neighbour.at, startsAt);
    }
    w.bombs = w.bombs.filter(b => b.id !== bomb.id);
    w.onBoom?.(bomb, cells);
  };

  /** Called every frame: fuses that have run out, and fire that has burned out. */
  w.updateFires = () => {
    for (const b of w.bombs.slice()) if (w.tick >= b.at) w.burstBomb(b);
    if (w.fires.length) w.fires = w.fires.filter(f => f.until > w.tick);
    if (w.burst.size > 256) w.burst.clear();      // ids only ever grow; this is cheap bookkeeping
  };

  /** Keep the local map in step with the server so predicted blasts stop at the right walls. */
  /** Mark a player as having just appeared, so the renderer can make it impossible to miss. */
  w.markSpawn = i => {
    const p = w.players[i];
    if (p) p.spawnAt = w.tick;
  };

  w.applyBlockEvent = e => {
    if (!w.map) return;
    const i = e.y * w.map.w + e.x;
    if (e.e === 'blockhit') w.map.cells[i] = packCell(cellType(w.map.cells[i]), e.hp);
    else if (e.e === 'blockdie') w.map.cells[i] = packCell(BLOCK.FLOOR, 0);
    else if (e.e === 'blocknew') w.map.cells[i] = packCell(e.b, BLOCK_HP[e.b] || 0);
  };

  w.applySnap = snap => {
    // Before the welcome there is no map, no seat and no names: a snapshot applied here would
    // create every player as "p<seat>" and hydrate() keeps the first name it is given.
    if (!w.ready) return;
    // A snapshot older than one already applied is not news. TCP cannot reorder, but the dev lag
    // shim can, and a rewound tick would unburst bombs and walk the interpolation backwards.
    if (snap.tick < w.tick) return;
    w.tick = snap.tick;
    setSeatColours(snap.pal);
    w.perks = snap.perks || [];
    w.puddles = snap.puddles || [];
    // Omitted from the snapshot when the sky is empty, so absent means none.
    w.gulls = snap.gulls || [];

    // Keep any bomb we already know about: the server drops it from the snapshot the moment it
    // explodes, and we may not have reached its fuse tick yet.
    const incoming = new Map((snap.bombs || []).map(b => [b.id, b]));
    for (const b of w.bombs) if (!incoming.has(b.id) && !w.burst.has(b.id)) incoming.set(b.id, b);
    w.bombs = [...incoming.values()].filter(b => !w.burst.has(b.id));

    for (const wire of snap.players) {
      const existing = w.players[wire.i];
      if (wire.i === w.you) {
        const me = existing || (w.players[wire.i] = hydrate(wire));
        reconcile(me, wire, snap.ack);
        continue;
      }
      const respawned = existing && !existing.alive && wire.st === 1;
      const p = existing ? hydrate(wire, existing) : (w.players[wire.i] = hydrate(wire));
      if (respawned) {
        p.rx = wire.x;
        p.ry = wire.y;
        p.moving = false;
        p.trail.length = 0;
        p.buf.length = 0;
      }
      // Snapshots arrive every 2 ticks and remotes are drawn INTERP_DELAY_TICKS behind, so the
      // pair that brackets the render time can be three entries back. Keeping only three meant
      // the right pair had usually already been shifted out.
      p.buf.push({ tick: snap.tick, x: wire.x, y: wire.y });
      if (p.buf.length > 6) p.buf.shift();
    }

    // Anyone absent from the snapshot has left.
    const present = new Set(snap.players.map(p => p.i));
    for (let i = 0; i < w.players.length; i++) if (w.players[i] && !present.has(i)) delete w.players[i];
  };

  /**
   * Drop acknowledged inputs, then replay whatever is left on top of the server's answer.
   * Because movement.step is the same function on both sides, the result is normally identical
   * and nothing visibly moves. Deliberately no tolerance band and no blending - add a 100 ms
   * lerp here only if snapping turns out to be visible in practice.
   */
  // `ack = -1` on purpose: a snapshot without one must drop nothing, rather than compare every
  // pending tick against undefined and then replay the entire queue.
  function reconcile(me, wire, ack = -1) {
    while (w.pending.length && w.pending[0].tick <= ack) w.pending.shift();

    const before = { x: me.x, y: me.y };
    me.x = wire.x; me.y = wire.y;
    me.alive = wire.st === 1;
    me.bombs = wire.b; me.radius = wire.f; me.speed = wire.sp; me.shields = wire.sh;
    me.score = wire.s; me.kills = wire.k; me.deaths = wire.dd; me.status = wire.stat;
    me.coins = wire.c || 0;
    // Health, which only the server decides. Missing from here once, so your own pirate never
    // went to half on your own screen - the heart, the ghosting and the scorch all read this.
    me.hp = wire.hp ?? MAX_HP;
    me.arriving = !!wire.ar;              // joining: off the board for a moment, not dead
    me.respawnTicks = wire.rr ?? null;
    // Stamina is simulated locally too, so it is replayed with the inputs below rather than
    // simply trusted - the server's value is the one the replay starts from.
    if (wire.sta !== undefined) { me.stamina = wire.sta; me.staminaLevel = wire.stl; me.tired = !!wire.tr; }
    // Same for the slide on water: the replay below has to start from the server's count.
    me.slide = wire.sl ?? 0;
    // And the deliberate slide, which is the one that matters most here: the velocity is a
    // geometric decay, so a replay that started from the wrong number would diverge further every
    // tick rather than converging.
    me.slideV = wire.sv ?? 0;
    me.slideDir = wire.sd ?? me.dir;
    me.slideFor = wire.sf ?? 0;
    me.slideCool = wire.sc ?? 0;
    /* And the buffered turn, for the same reason as the slide velocity: the replay below has to
     * start from the server's value. A turn the server is holding that we are not would make the
     * replay turn at a corner the server will not, and vice versa - a divergence that is
     * invisible until a junction and then reads as the pirate steering itself. */
    me.turnWant = wire.tl > 0 ? wire.tw : DIR_NONE;
    me.turnLeft = wire.tl ?? 0;

    for (const inp of w.pending) step(w, me, inp.mask);

    /* Absorb the correction into a decaying offset rather than showing it.
     *
     * The drawn position is now a straight function of the simulated one, so a correction would
     * appear in full on the next frame. Usually there is nothing to show - the client runs the
     * same movement function on the same inputs, which is the entire point of the shared
     * simulation - but packet loss and the server's input narrowing can still produce one. Holding
     * the difference here and bleeding it off over about a tenth of a second (see interpolate)
     * means a correction moves the pirate smoothly rather than cutting them to the new truth.
     */
    me.ex = (me.ex ?? 0) + (before.x - me.x);
    me.ey = (me.ey ?? 0) + (before.y - me.y);

    if (Math.abs(me.x - before.x) > 8 || Math.abs(me.y - before.y) > 8) w.lastCorrection = performance.now();
  }

  /**
   * Draw a pirate `f` of the way from (ax, ay) to (bx, by), along the path they actually took.
   *
   * ONE function for your own pirate and for everybody else, which it had not been - and the
   * local half was the cruder of the two, which is why corners looked worse on your own screen
   * than on anybody else's. The two cases are the same question asked of different samples: your
   * own ends are consecutive simulated ticks, a remote's are two snapshots.
   *
   * A straight line when the straight line is legal, an L when it is not. Travel on both axes in
   * one step is either a genuine diagonal - the tick a corner is taken spends part of its pace
   * down each lane, see railTravel - or a corner TURN, and the two want opposite treatment: a
   * lerp across a turn cuts the corner block, which is the "players walk through walls" everyone
   * notices first, while an L across a real diagonal is the stutter the L exists to prevent.
   *
   * Telling them apart needs no extra state: is the midpoint legal? A real diagonal passes, a
   * corner turn does not. Which arm of the L comes first is unknowable from two samples, so
   * x-first, falling back to y-first when the x-first elbow is solid; one of the two is always
   * the path that was taken.
   *
   * Measured along the PATH, not per axis, so the pace through an elbow is the pace into it -
   * an L walked by lerping each axis independently slows down on the diagonal and speeds up on
   * the way out, which is the corner wobble this is here to remove.
   */
  function pathAt(p, ax, ay, bx, by, f) {
    const dx = bx - ax, dy = by - ay;
    const sx = ax + dx * f, sy = ay + dy * f;
    if (!dx || !dy || !blocked(w, p, sx, sy)) { p.rx = sx; p.ry = sy; return; }
    const along = (Math.abs(dx) + Math.abs(dy)) * f;
    const xFirst = !blocked(w, p, bx, ay);
    const [u, v] = xFirst ? [dx, dy] : [dy, dx];
    const pu = (xFirst ? ax : ay) + Math.sign(u) * Math.min(Math.abs(u), along);
    const pv = (xFirst ? ay : ax) + Math.sign(v) * Math.max(0, Math.min(Math.abs(v), along - Math.abs(u)));
    p.rx = xFirst ? pu : pv;
    p.ry = xFirst ? pv : pu;
  }

  /**
   * Keep a drawn player out of the walls.
   *
   * When smoothing or interpolation puts the drawn point somewhere illegal, ease it back toward
   * the SIMULATED position, which is authoritative and by construction always legal.
   *
   * It used to ease toward the TILE CENTRE instead, on the reasoning that the tile index is the
   * whole truth and the sub-tile offset is presentation. Under free movement that was nearly
   * true, because auto-centring meant a player in a corridor really was within a few units of
   * the centre line. Rails broke it: a pirate pressed against a wall comes to rest FLUSH, 48
   * units past the centre of their tile, so the moment interpolation nudged the drawn point a
   * unit past the limit this hauled it 48 units backwards - and the next frame's interpolation
   * pulled it forward again. That is the jiggle people saw holding a direction into a block.
   *
   * Easing toward `p.x`/`p.y` cannot oscillate, because the target is exactly where the
   * interpolation is already heading.
   */
  function settleToLane(p) {
    if (!w.map || !blocked(w, p, p.rx, p.ry)) return;
    const cx = p.x, cy = p.y;
    // Slide onto the lane rather than jumping onto it. A hard assignment here is a visible
    // flick - the drawn position is usually only a few units inside the wall, and moving a few
    // units a frame hides the correction completely. A floor of 4 units makes it terminate.
    const ease = (from, to) => {
      const d = to - from;
      return from + Math.sign(d) * Math.min(Math.abs(d), Math.max(4, Math.abs(d) * 0.25));
    };
    if (!blocked(w, p, cx, p.ry)) { p.rx = ease(p.rx, cx); return; }
    if (!blocked(w, p, p.rx, cy)) { p.ry = ease(p.ry, cy); return; }
    p.rx = ease(p.rx, cx); p.ry = ease(p.ry, cy);
  }

  /**
   * Hard cut, not a slide. The tracer is sampled from the *rendered* position, so without
   * clearing it a respawn leaves a stripe of coloured dots across the map from where you died.
   */
  function teleport(p) {
    p.rx = p.x; p.ry = p.y;
    p.ex = 0; p.ey = 0;
    p.trail.length = 0;
  }

  /**
   * Called every frame: advance rendered positions and sample tracers.
   *
   * `frac` is how far through the CURRENT local tick this frame is, 0 to 1 - the leftover of the
   * fixed-step accumulator in main.js. `liveMask` is the keys held right now. Your own pirate is
   * drawn by running that fraction of a tick with those keys on a throwaway copy; see below.
   */
  w.interpolate = (serverTickNow, dtMs = 16, frac = 1, liveMask = 0) => {
    const renderTick = serverTickNow - INTERP_DELAY_TICKS;
    /* The fractional clock everything drawn should read.
     *
     * `w.tick` only moves when a snapshot lands, fifteen times a second, so anything drawn from
     * it steps rather than moves. A skating bomb hops a whole tile every few ticks and is the
     * first thing where that is obvious; see the kick interpolation in render.js. */
    w.tickF = renderTick;
    for (const p of w.players) {
      if (!p) continue;
      // The reconciliation error, bleeding away. A tenth of a second: long enough to hide a
      // correction, short enough that the drawn position is never meaningfully a lie.
      if (p.ex || p.ey) {
        const decay = Math.exp(-dtMs / 100);
        p.ex = Math.abs(p.ex * decay) < 1 ? 0 : p.ex * decay;
        p.ey = Math.abs(p.ey * decay) < 1 ? 0 : p.ey * decay;
      }

      if (p.i === w.you) {
        /* Your own pirate is drawn by ASKING THE MOVEMENT FUNCTION where you are part-way through
         * the tick in progress - not by interpolating between two finished ticks.
         *
         * Three versions of this were wrong in three ways, and both of the earlier ones were
         * really the same mistake: guessing a path from its endpoints.
         *
         *   An exponential ease toward the simulated position reproduced the 30 Hz staircase in
         *   the velocity - 59% of the step on the frame a tick landed, 24% on the frame after.
         *   That was "choppy, and worse with boots": the ratio is fixed, so faster legs meant a
         *   bigger wobble in pixels.
         *
         *   A lerp between the last two simulated positions is uniform, but it is a full tick
         *   behind by construction - 33 ms of mush on every key - and the straight line between
         *   two ends of a corner tick is not the path that was taken. It cuts the corner, and
         *   because a chord is shorter than its L the drawn speed DIPS through every corner.
         *   Measured: 24 units a frame down to 18 for two frames, every time.
         *
         * `step` with a fractional pace has neither problem. It turns at the junction if that
         * fraction of the pace reaches the junction and not otherwise, because it is the same code
         * that will shortly do it for real - so the drawn path is the real path, including the
         * diagonal out of a corner. And it runs FORWARD from the current position toward where the
         * live input is taking you, so the picture is never behind the simulation.
         *
         * On a throwaway copy, always. Nothing here may touch the authoritative prediction - this
         * is a question about the future, asked once a frame and thrown away.
         */
        /* A shallow copy plus the one nested field the movement path reads.
         *
         * `step` writes nothing but primitives on the player, so `{...p}` is enough today - but a
         * shallow copy shares every object, and a future line in movement that wrote through
         * `statusUntil` would be the renderer silently editing the authoritative player once a
         * frame. That is a bug nobody would find from the symptom, so it is closed here rather
         * than relied upon. Verified by test: the simulation hashes identically with and without
         * this running.
         */
        const ghost = { ...p, statusUntil: { ...p.statusUntil } };
        step(w, ghost, liveMask, frac);
        // A whole tile in one tick means a respawn or an unstick teleport, not a walk.
        if (Math.abs(ghost.x - p.x) > 256 || Math.abs(ghost.y - p.y) > 256) teleport(p);
        else {
          // The correction offset is cosmetic, so it is not allowed to put the drawn pirate
          // somewhere the simulation never would. Dropped for this frame rather than clamped: it
          // is decaying anyway, and a frame without it is invisible next to a shoulder in a wall.
          const ox = ghost.x + (p.ex ?? 0), oy = ghost.y + (p.ey ?? 0);
          const clear = !(p.ex || p.ey) || !blocked(w, p, ox, oy);
          p.rx = clear ? ox : ghost.x;
          p.ry = clear ? oy : ghost.y;
        }
      } else if (p.buf.length >= 2) {
        // The pair that BRACKETS the time being drawn, not the two newest - see pickPair. Taking
        // the newest two pinned every remote player to one snapshot until the next arrived, which
        // is a teleport fifteen times a second and the single biggest source of "the movement is
        // laggy". It was never the transport.
        const pair = pickPair(p.buf, renderTick);
        const { a, b, f } = pair;
        const dx = b.x - a.x, dy = b.y - a.y;

        // Further than anyone can walk in one snapshot means a respawn, not a walk. Interpolating
        // it would drag the sprite across the whole map, straight through everything in between.
        if (Math.abs(dx) > 512 || Math.abs(dy) > 512) {
          teleport(p);                    // p.x is already b.x - hydrate ran before this
        } else {
          pathAt(p, a.x, a.y, b.x, b.y, f);
          // Walking is whether the drawn position is actually changing. The wire has no `moving`
          // flag, and without this every remote player slid around in their standing frame.
          p.moving = Math.abs(dx) + Math.abs(dy) > 2 && f < 1;
        }
      }

      settleToLane(p);
      if (p.trailAt === undefined) p.trailAt = 0;
      if (w.tick - p.trailAt >= TRACER_EVERY_TICKS) {
        p.trailAt = w.tick;
        p.trail.push([p.rx, p.ry]);
        if (p.trail.length > TRACER_SAMPLES) p.trail.shift();
      }
    }
  };

  return w;
}
