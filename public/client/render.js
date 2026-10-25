// Canvas 2D renderer: cached map chunks, then entities on top.
//
// The map is split into 8x8-tile chunks, each drawn once into its own offscreen canvas and only
// redrawn when a cell inside it changes. Per frame we blit a dozen chunks and draw a handful of
// sprites. Same approach Game of Bombs uses. docs/ARCHITECTURE.md §6.

import {
  TILE_PX, CHUNK_TILES, UNITS_PER_TILE, TRACER_SAMPLES, FUSE_TICKS, FIRE_TICKS, STATUS,
  BLOCK, BLOCK_HP, SEA_MARGIN_TILES, SEA_FIT_MARGIN_TILES, SPAWN_POP_TICKS, SPAWN_POP_SCALE,
  MIN_ZOOM, MAX_ZOOM,
  PERK_FADE_TICKS, STAMINA_SHOW_AT, STAMINA_LOW_AT, staminaMaxFor,
  PUDDLE_FADE_TICKS, TICK_MS, TICK_HZ,
  BLOCK_WALKABLE, MAX_SHIELDS, seatSlot,
} from '/shared/constants.js';
import { cellType, cellHp } from '/shared/maps.js';
import {
  drawTile, drawFire, drawPerk, drawRock, drawShip, playerShades, PALETTE, bake, bakeSea,
  PERK_GLOWS, drawBombLive, CASTS_SHADOW, drawGull, drawFeather, fireTones,
  COAST_CORNERS, COAST_Q, carveRockCorners, drawCoastFillets, cornerCells, STONE_RADIUS,
} from '/assets/art.js';
import { bombTile, bombable } from '/shared/sim/bombs.js';
import { gullAt } from '/shared/sim/gulls.js';

const CHUNK_PX = TILE_PX * CHUNK_TILES;

export function createRenderer(canvas, world) {
  let ctx = canvas.getContext('2d', { alpha: false });
  let chunks = new Map();          // "cx,cy" -> {canvas, dirty}
  let baked = null;
  const cam = { x: 0, y: 0 };
  let redrawsThisSecond = 0, redrawWindow = 0;
  // Screen shake and a full-screen flash. Both are presentation only and both decay toward zero,
  // so a frame drop can never leave the camera stuck off-centre or the screen stuck red.
  let shake = 0;
  let flash = 0, flashColour = '255,255,255';
  let sea = null, seaNear = null, seaFar = null;
  // Everything about the drawing surface, measured on resize and never from the frame loop.
  const view = { dpr: 1, w: 0, h: 0, zoom: 1, smooth: false };
  const splashes = [];         // shoreline foam, capped - see spawnSplash
  const floaters = [];         // "+1 BOMB" rising off a player - see addFloater
  let seaT = 0;

  /* The sea, set to music - quietly.
   *
   * Two things carry it, and both are meant to be felt from the corner of your eye rather than
   * watched:
   *
   *   the coastal equaliser  the island is the speaker: each stretch of coast is a band, and its
   *                          level lifts a faint bar of light out of the shallows. See
   *                          drawCoastEq.
   *   bioluminescence        cold points of light that drift on the current, twinkle and fade,
   *                          more of them when the top end is busy and a small bloom on every hat
   *                          or snare. On a beat the ones already lit brighten together. See
   *                          drawGlow.
   *
   * Everything that used to PULSE OUTWARD across the surface is gone: bands of swell walking
   * out from the coast, sonar rings sweeping the sea, a tempo wave pushing the current streaks
   * in rings, foam bursting off the rocks on every beat. In a real round, with the equaliser
   * running underneath them, they turned the whole sea into a light show - the wrong thing to
   * be looking at while somebody is trying to blow you up.
   *
   * The rest of the sea barely moves with the music: the surface texture drifts a little faster
   * when the music is busy (flowT) and the water lifts a shade toward the light on the bass. The
   * white flow lines do not listen at all - see drawDrops. `sound` is the listener's analysis, refreshed once a
   * frame and delayed by the output latency so what is drawn lands when it is heard. Music off,
   * every multiplier is 1.
   */
  const CALM = {
    bass: 0, mid: 0, high: 0, level: 0, beat: 0, beats: 0,
    bpm: 0, phase: 0, lock: 0, spark: 0, sparks: 0, tone: 0.5, accent: 0, accents: 0,
    // How loud the music is set, 0..1, and 0 when it is off or muted. Not a measurement - the
    // analyser sits before the fader, so it cannot tell a muted track from a silent one, and the
    // coast has to know the difference. Supplied by the caller of setSound.
    vol: 0,
    eq: new Float32Array(24),
  };
  let soundOf = null, sound = CALM, lastSparks = 0;
  /* The music as the open sea feels it: the listener's bands and beat, eased again - a fifth of
   * a second to rise, most of a second to fall. The raw beat snaps up and decays in a fifth of a
   * second, and read directly it made everything it touched jump. */
  const mood = { bass: 0, mid: 0, high: 0, level: 0, beat: 0 };
  let eqFor = null, eqCoast = [];            // shoreline tiles with their band, per map
  let eqLen = new Float32Array(24);          // bar lengths per band, in tiles, eased
  // The coastal glow's own clock. Nothing to do with the music any more - see drawCoastEq.
  let eqT = 0;
  let eqBlur = new Float32Array(24);         // the same, blurred across neighbours; what is drawn
  let flowT = 0;                             // the surface texture's clock; see drawSea
  // The vignette, cached against the view size it was built for.
  let vignette = null, vignetteFor = null;
  const glow = [];                           // bioluminescent points; see drawGlow
  let glowSprites = null;                    // pre-drawn soft points, one per tint
  const bombClock = { tick: -1, at: 0 };    // when world.tick last changed; see the bomb loop
  /* How far above quiet a band is, 0..1, LINEARLY.
   *
   * This used to be curved (x^1.5 from 0.35) so the music's usual level barely moved the water.
   * Measured in a real round, that was the whole problem: the in-game music is the ambient beds,
   * whose bands swing between 0.1 and 0.9 - plenty of signal - and the curve turned a 0.5 into
   * 0.11. The sea looked dead. Linear from 0.25 keeps the motion that is actually there. */
  const lifted = v => Math.max(0, Math.min(1, (v - 0.25) / 0.75));
  let drunk = 0;                       // 0..1, eased, so it fades in and out rather than snapping

  /* Where the aim bracket is DRAWN, in tiles, as a float.
   *
   * The tile it is drawn on is not the tile it means. What it means is `bombTile`, which is
   * exact and changes the instant your centre crosses a boundary - and must, because it is
   * where the bomb actually goes. What it looks like is this, which chases that.
   *
   * Keeping them separate is the whole point: the glide is a lie told to the eye only, and the
   * game never consults it. Nothing about aiming gets slower, less precise, or dependent on a
   * frame rate - press the key mid-glide and the bomb lands on the tile the bracket is heading
   * to, not the one it is passing over. */
  let aimTx = 0, aimTy = 0, aimSeen = false;
  // 0..1, the fade-in when the bracket returns after your last bomb detonates.
  let aimIn = 0;

  /* What people are saying, above their heads.
   *
   * Seat index -> { text, until }. Short chat only: a bubble is a glance, and anything you have
   * to read is a thing you read in the chat panel where it will still be there in ten seconds.
   */
  const says = new Map();
  const SAY_MS = 3400;
  let depth = null, depthFor = '';     // the depth gradient, rebuilt only when the view changes

  // Sun glints on the open water. Cheap, stateless, and most of what makes a surface read wet.
/* More of them, now that the flow streaks are gone.
 *
 * The streaks were most of what made the open water look alive, and taking them out left a lot of
 * quiet sea. Glints are the right thing to fill it with: they are points rather than shapes, so
 * the eye reads them as light on a surface and never as an object - which is exactly why the
 * streaks had to go and these can multiply. */
  const GLINTS = 78;
  const TIPSY_BUBBLES = 7;
  const TIPSY_LIFE_S = 1.3;
  const GLINT_LIFE_S = 1.6;
  /** Deterministic 0..1 from one integer, so a glint stays put for its whole life. */
  const hash01 = n => {
    let x = (n * 374761393) ^ 0x5bf03635;
    x = (x ^ (x >>> 13)) * 1274126177;
    return ((x ^ (x >>> 16)) >>> 0) / 4294967295;
  };

  function ensureBaked() {
    if (baked) return;
    baked = bake({ playerCount: 16 });
    sea = bakeSea();
    seaNear = ctx.createPattern(sea.near, 'repeat');
    seaFar = ctx.createPattern(sea.far, 'repeat');
  }


  /**
   * Measure, and work out the scale. Called when the box changes, never from the frame loop.
   *
   * Reading clientWidth forces the browser to flush layout. Doing that once per frame - which is
   * what the first version did - makes every frame wait on a layout pass, and because the number
   * it returns settles over several frames while the panels lay out, the zoom crept and the
   * whole board visibly shimmered. Measuring on resize only is both faster and stable.
   */
  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    const { clientWidth: w, clientHeight: h } = canvas;
    if (!w || !h) return;                   // laid out but not measured yet
    // Bail when nothing actually changed. Writing canvas.width resets the drawing surface and
    // can itself be observed as a resize, so an unguarded ResizeObserver callback that always
    // writes is a loop that clears the canvas every frame.
    if (w === view.w && h === view.h && dpr === view.dpr) return;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    view.dpr = dpr;
    view.w = w;
    view.h = h;
    recomputeZoom();
  }

  /**
   * Fill the box with the island, keeping a strip of sea all the way round.
   *
   * The fit is computed against the map plus SEA_MARGIN_TILES on every side, so there is always
   * visible ocean and the island reads as an island rather than as a diagram that ran out of
   * paper. Beyond that the board is as large as it can possibly be.
   */
  /**
   * The bounding box of the LAND, in tiles, as [x0, y0, w, h].
   *
   * Not the map rectangle. Every map but Arena is a shape inside its rectangle - Cove is a blob,
   * Twins is two circles - and the rest of the grid is WATER. Fitting the rectangle therefore
   * fitted a frame of ocean that was already several tiles thick before the margin was added,
   * which is why Cove rendered a small island in a sea of empty blue.
   *
   * Cached per map object: this is a full w*h scan and the map identity only changes on a round.
   */
  let landBoxFor = null, landBox = null;
  function landBounds() {
    if (landBoxFor === world.map && landBox) return landBox;
    const { w, h, cells } = world.map;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let ty = 0; ty < h; ty++) {
      for (let tx = 0; tx < w; tx++) {
        if (cellType(cells[ty * w + tx]) === BLOCK.WATER) continue;
        if (tx < x0) x0 = tx;
        if (tx > x1) x1 = tx;
        if (ty < y0) y0 = ty;
        if (ty > y1) y1 = ty;
      }
    }
    // A map that is somehow all water still has to render something.
    if (x1 < x0) { x0 = 0; y0 = 0; x1 = w - 1; y1 = h - 1; }
    landBoxFor = world.map;
    landBox = [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
    return landBox;
  }

  function recomputeZoom() {
    if (!world.map || !view.w) return;
    const m = SEA_FIT_MARGIN_TILES * 2;
    const [, , lw, lh] = landBounds();
    // Fit the ISLAND plus two tiles of ocean, not the three the scenery reaches into: see
    // SEA_FIT_MARGIN_TILES. The far edge of the sand shelf is the faintest thing on the board and
    // it is not worth a tile of scale on every side to keep it in frame.
    const fit = Math.min(view.w / ((lw + m) * TILE_PX),
                         view.h / ((lh + m) * TILE_PX));

    // Quantised. An unrounded scale changes by a hair on every layout settle and on every DPR
    // report, and a board that resizes by one part in a thousand reads as jitter. Fortieths are
    // fine enough that nobody sees the step and coarse enough that nothing wobbles.
    //
    // Rounded DOWN, not to nearest: rounding up eats into the two tiles of ocean that are the
    // one rule this function has.
    let q = Math.floor(fit * 40) / 40;

    // Floored. Below MIN_ZOOM a tile is about twenty pixels and a player is a smudge, so the
    // board stops shrinking and the camera starts following instead - which frame() already does
    // whenever the map does not fit. A map you cannot read is worse than a map you cannot see
    // all of.
    q = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, q));

    // No half-step snapping. It was there so pixel art upscaled by a non-integer factor would
    // not get rows of visibly different widths - but flooring to the nearest half THREW AWAY UP
    // TO A THIRD OF THE SCALE: a window that could take 1.45 was rendered at 1.0, and the
    // difference went into the sea. Forty-five percent more ocean than asked for is a far worse
    // artefact than a row of pixels one unit wider than its neighbour, which at these sizes
    // nobody has ever noticed. Smoothing is switched on above 1 as well, which hides it anyway.
    const z = q;
    if (!Number.isFinite(z) || z <= 0) return;      // never let a bad measurement blank the board
    if (z === view.zoom) return;
    view.zoom = z;
    // Smooth at any non-integer scale, in both directions, for the reason above.
    view.smooth = Math.abs(q - Math.round(q)) > 1e-6;
    invalidateAll();
  }

  addEventListener('resize', resize);
  // The panels change the box without the window changing at all - a narrow viewport dropping
  // the side panel, or the HUD appearing when a round starts. Deferred to the next frame so the
  // canvas.width write inside resize() can never re-enter the observer that triggered it.
  if (typeof ResizeObserver === 'function') {
    let queued = false;
    new ResizeObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; resize(); });
    }).observe(canvas);
  }

  const invalidateAll = () => {
    chunks = new Map(); shore = null; splashes.length = 0;
    pools.clear(); ripples.length = 0; wisps.length = 0; shards.length = 0; pops.length = 0; poolFor = null;
    glow.length = 0; eqFor = null; eqLen.fill(0); smokes.length = 0;
    rockSprites = null;
    rockSpritesFor = null;
    perkSeen.clear();
    perkGone.clear();
    perkLive.clear();
    bombSeen.clear();
    blastLights.clear();
    lightLayer = null;
    lightCtx = null;
    lampLayer = null;
    lampCtx = null;
    rollCurrent();          // a new island sits in a different sea
  };
  const mapChanged = () => { recomputeZoom(); };

  /** Mark the chunk holding a tile dirty, plus neighbours when it sits on a border. */
  function invalidateTile(tx, ty) {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const key = `${(tx + dx) >> 3},${(ty + dy) >> 3}`;
      const c = chunks.get(key);
      if (c) c.dirty = true;
    }
  }

/* The sun, which you never see.
 *
 * An actual sun in the corner of a top-down board is a bright thing competing with the fire for
 * the brightest-thing-on-screen slot, and it would have to be somewhere - which on a square
 * board means one of four corners, which means it stops being a choice. What you get instead is
 * everything it implies: one light direction, and every solid thing on the island throwing a
 * shadow the same way.
 *
 * ANGLE 0 to 180 degrees, deterministic in the map name, so a given map always has the same
 * light and nothing has to travel on the wire. Only the upper half: the sun is somewhere
 * overhead and ahead, never behind the camera, so shadows always fall DOWN the screen - a board
 * lit from below reads as though you are looking at it upside down.
 *
 * The length is deliberately short, about two thirds of a tile. Long shadows are prettier and
 * they obscure the floor, and the floor is where you walk.
 */
  /* Rock is rounded harder than a crate: six pixels against three.
   *
   * A crate is a made object with real edges, so a hint is right. Rock is worn, and at the
   * crate's radius it simply read as a square with the corners filed - the change was there in
   * the pixels and not in the picture. Six is a fifth of a tile: visibly a boulder, and still
   * nowhere near a circle. Only exposed corners get it (see the chunk pass), so a wall of rock is
   * still one unbroken mass. STONE_RADIUS stays the crates' number. */
  const ROCK_RADIUS = Math.max(STONE_RADIUS, 8);
  const SHADOW_LEN = TILE_PX * 0.72;
  /* The light a blast throws onto everything near it.
   *
   * A bomb going off is the brightest thing that ever happens on this board and until now it lit
   * nothing: the flames were drawn and the sand, the crates and the rock beside them stayed
   * exactly as dim as they were a frame earlier. One warm additive pool per burning tile fixes
   * that for one gradient fill each - the floor under it warms, the faces of the blocks around
   * it catch it, and a corridor two tiles away is briefly visible.
   *
   * Short. The light is the FLASH, not the fire: up in a couple of frames, most of the way gone
   * by the time the flames are at their biggest, and over well before the embers. A glow that
   * lasted as long as the fire would read as a coloured filter laid over the board, and worse,
   * it would make the lethal window look longer than it is - the one thing the fire's own
   * drawing is responsible for saying. */
  // Four and a half tiles. A blast lighting less than its own reach is a blast that looks like it
  // is lighting a decal of itself; past four it starts carrying down a corridor, which is where
  // the light stops being decoration and starts being information.
  const BLAST_LIGHT_PX = TILE_PX * 4.6;
  // How much of the finished light layer reaches the board. One number for a whole blast now,
  // not per tile, because the pools are merged before they get here.
  const BLAST_LIGHT_ALPHA = 0.55;
  /* Perks fading in and out. `perkSeen` is when this renderer first saw an id, `perkGone` is the
   * last thing known about one, and `perkLive` is this frame's ids. See the note in the perk
   * loop; a sixth of a second each way. */
  /* The pool of light a blast throws, per owner.
   *
   * Same shape for everybody - white-hot middle, warm body, nothing at the rim, which is what
   * "adds no light" has to look like under both blends - and the hue is the owner's own fire
   * (see fireTones in art.js), so the wall two tiles away warms in the colour of whoever lit it.
   * One gradient per seat, built once: a gradient is an object, and seventeen of them beats one
   * per burning tile per frame.
   */
  const blastLights = new Map();
  function blastLightFor(owner) {
    // Per colour rather than per seat, so a seat that changes colour between rounds is lit right.
    const key = owner >= 0 ? seatSlot(owner) : -1;
    const hit = blastLights.get(key);
    if (hit) return hit;
    const tones = key >= 0 ? fireTones(owner) : { hue: 33, sat: 70 };
    const h = tones.hue, sat = k => Math.round(tones.sat * k);
    const g = ctx.createRadialGradient(0, 0, TILE_PX * 0.1, 0, 0, BLAST_LIGHT_PX);
    /* Softer than the flame: light that has crossed a room has lost its colour on the way, and
     * the pool is three times the size of the fire that threw it - the same saturation over that
     * area reads as a coloured lamp rather than as firelight with a hint of whose it is. Scaled
     * from the owner's own saturation, like the flame, so a white player's light is white. */
    g.addColorStop(0, `hsla(${h} ${sat(0.58)}% 86% / 0.95)`);
    g.addColorStop(0.28, `hsla(${h} ${sat(0.7)}% 64% / 0.52)`);
    g.addColorStop(0.62, `hsla(${h} ${sat(0.62)}% 44% / 0.24)`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    blastLights.set(key, g);
    return g;
  }

  const PERK_POP_MS = 170;
  // A bomb arrives faster than a perk does: it is an action somebody just took rather than
  // something uncovered, and anything slower than this reads as lag on their input.
  const BOMB_POP_MS = 110;
  const bombSeen = new Map();
  const perkSeen = new Map();
  const perkGone = new Map();
  const perkLive = new Set();
  let lightLayer = null, lightCtx = null;
  let lampLayer = null, lampCtx = null;
  /* Darker, and SOFT.
   *
   * 0.3 was a shadow you had to be told about. The thing that makes a stronger one look better
   * rather than merely heavier is the edge: a hard-edged black rectangle at 45% reads as a hole
   * cut in the floor, and the same shape through a three-pixel blur reads as light not reaching
   * the sand. Baked into the chunk cache with everything else, so the blur is paid once per chunk
   * and never per frame - which is the only reason a canvas filter is affordable here at all.
   */
  // A third lighter than the 0.46 it was, on request: at 0.46 a board full of blocks spent more
  // of its area in shade than in sun, and the shade is scenery - it was competing with fire,
  // which is information. The blur and the length are unchanged, so it still reads as light not
  // reaching the sand rather than as a flat grey mat.
  const SHADOW_ALPHA = 0.31;
  const SHADOW_BLUR_PX = 3;
  let sunFor = null, sun = { dx: 0, dy: 0 };

  /* Everything a shadow is allowed to fall on: the floor, and never the blocks standing on it.
   *
   * A shadow lying across the top of a crate is the one thing that tells the eye the board is
   * flat - the crate is drawn as a solid object with a lit top, and a person's shadow sliding
   * over that top says there is nothing there. On a real board the shadow stops at the foot of
   * the block and climbs it, and since we have no way to climb it, stopping is the honest half.
   *
   * One even-odd path: the whole world, minus a rect per solid tile. Rebuilt when the tick
   * changes, because a crate that just blew up has to stop blocking immediately - and shared by
   * every shadow pass in the frame, which is why it is not rebuilt per pass.
   */
  let floorClip = null, floorClipAt = -1, floorClipMap = null;
  function floorClipPath() {
    const map = world.map;
    if (!map) return null;
    if (floorClip && floorClipAt === world.tick && floorClipMap === map) return floorClip;
    const p = new Path2D();
    // Bigger than any board, so the subtraction below is the only thing that shapes it.
    p.rect(-1e5, -1e5, 2e5, 2e5);
    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) {
        if (!CASTS_SHADOW.has(cellType(map.cells[ty * map.w + tx]))) continue;
        p.rect(tx * TILE_PX, ty * TILE_PX, TILE_PX, TILE_PX);
      }
    }
    floorClip = p; floorClipAt = world.tick; floorClipMap = map;
    return p;
  }

  /** Clip the caller - which must already have saved - to the floor. Board transform in. */
  function clipToFloor(ox, oy) {
    const p = floorClipPath();
    if (!p) return;
    ctx.translate(ox, oy);
    ctx.clip(p, 'evenodd');
    ctx.translate(-ox, -oy);
  }

  function sunVec() {
    const map = world.map;
    if (!map) return sun;
    if (sunFor === map) return sun;
    sunFor = map;
    // Hash the map's identity rather than Math.random(): the sun is part of what a map LOOKS
    // like, and a light that moved every time you loaded the same island would read as a bug.
    let h = 2166136261;
    for (const ch of String(map.id ?? map.name ?? 'map')) {
      h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    }
    const angle = ((h >>> 0) / 4294967295) * Math.PI;   // 0..180 degrees
    sun = { dx: Math.cos(angle) * SHADOW_LEN, dy: Math.sin(angle) * SHADOW_LEN };
    return sun;
  }

  function chunkAt(cx, cy) {
    const key = `${cx},${cy}`;
    let c = chunks.get(key);
    if (!c) {
      const el = document.createElement('canvas');
      el.width = el.height = CHUNK_PX;
      c = { canvas: el, dirty: true };
      chunks.set(key, c);
    }
    if (c.dirty) {
      const cc = c.canvas.getContext('2d');
      cc.imageSmoothingEnabled = false;
      // Cleared, not filled: water tiles and everything off the edge of the map stay transparent
      // so the animated sea drawn underneath shows through. The sea is the background now.
      cc.clearRect(0, 0, CHUNK_PX, CHUNK_PX);
      const map = world.map;
      const { dx: sdx, dy: sdy } = sunVec();

      /* The shadow pass, first, so every tile paints over its neighbours' shadows.
       *
       * Baked into the chunk rather than drawn per frame: the sun does not move, so a block's
       * shadow is as static as the block is, and a thousand offset rects a frame for something
       * that never changes would be the most expensive thing on screen.
       *
       * It overruns the chunk edge by design. A shadow near the boundary spills into the next
       * chunk and is simply clipped - the neighbouring chunk draws its own, so the only thing
       * lost is the sliver one block casts across the seam. At 0.62 of a tile against an
       * eight-tile chunk, that is a few pixels every sixty-four.
       */
      cc.save();
      cc.globalAlpha = SHADOW_ALPHA;
      cc.fillStyle = '#000';
      // One blur for the whole pass rather than per shape, and skipped entirely where the browser
      // does not have it - a hard shadow is the old look, not a broken one.
      const canBlur = 'filter' in cc;
      if (canBlur) cc.filter = `blur(${SHADOW_BLUR_PX}px)`;
      for (let j = 0; j < CHUNK_TILES; j++) {
        for (let i = 0; i < CHUNK_TILES; i++) {
          const tx = cx * CHUNK_TILES + i, ty = cy * CHUNK_TILES + j;
          if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) continue;
          const t = cellType(map.cells[ty * map.w + tx]);
          if (!CASTS_SHADOW.has(t)) continue;
          cc.beginPath();
          cc.roundRect(i * TILE_PX + sdx, j * TILE_PX + sdy, TILE_PX, TILE_PX, 4);
          cc.fill();
        }
      }
      if (canBlur) cc.filter = 'none';
      cc.restore();

      for (let j = 0; j < CHUNK_TILES; j++) {
        for (let i = 0; i < CHUNK_TILES; i++) {
          const tx = cx * CHUNK_TILES + i, ty = cy * CHUNK_TILES + j;
          if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) continue;
          const byte = map.cells[ty * map.w + tx];
          const type = cellType(byte);
          if (type === BLOCK.WATER) continue;              // the sea draws itself
          const maxHp = BLOCK_HP[type] || 0;
          const dmg = maxHp ? 1 - cellHp(byte) / maxHp : 0;
          cc.save();
          cc.translate(i * TILE_PX, j * TILE_PX);
          if (type === BLOCK.IRON) {
            /* Rock, clipped - and the shape of the clip depends on where the rock is.
             *
             * Two problems share one answer here. The first is SPILL: a rock tile is three hashed
             * lumps and the hash can put one up to nine pixels past the tile edge. Inland that
             * never showed, because the next tile is drawn after it and paints the overhang out -
             * but a water tile is never drawn at all (the sea is the background), so on the outer
             * border the overhang survived, and the rounded coast made it obvious: the carve
             * clears the corner back to the sea and the lump that used to hide under the square
             * outline is left sitting on open water.
             *
             * The second is CORNERS: a boulder inside the playing area is a lump of stone, and a
             * lump of stone does not have four right angles. The breakable blocks are rounded by
             * the same radius (see STONE_RADIUS in art.js) and a square rock standing in a row of
             * rounded crates is the one thing left on the board reading as a grid cell.
             *
             * So an INLAND rock gets sand laid under it and a rounded clip, exactly like a crate.
             * A COAST rock - anything with a side facing the sea - keeps the square clip and no
             * sand: its corners are already shaped, in quarter-tile steps, by the coast pass
             * below, and a rounded clip there would notch sea into the island or sand into the
             * sea depending on which side it was on.
             */
            const sea = seaEdges(tx, ty);
            cc.beginPath();
            if (sea) cc.rect(0, 0, TILE_PX, TILE_PX);
            else {
              /* Rounded only where the corner is actually a corner.
               *
               * A flat radius on every tile turns a solid rock wall into a row of lozenges with
               * sand showing through every join - four notches per shared corner, which is both
               * ugly and a lie about what you can walk between. So each corner asks whether
               * either of the two sides meeting there continues into more rock: if it does, the
               * corner is interior and stays square, and the two tiles meet with no seam. Only
               * the corners on the OUTSIDE of a mass of rock are rounded, which is exactly where
               * a boulder would be worn round.
               */
              // Off the board counts as rock: the map's border ring is rock, so a tile on the
              // edge of the grid has more of the same beyond it rather than open sand.
              const rock = (x, y) => (x < 0 || y < 0 || x >= map.w || y >= map.h
                ? true : cellType(map.cells[y * map.w + x]) === BLOCK.IRON);
              const up = rock(tx, ty - 1), down = rock(tx, ty + 1);
              const west = rock(tx - 1, ty), east = rock(tx + 1, ty);
              const r = ROCK_RADIUS;
              drawTile(cc, BLOCK.FLOOR, tx, ty, 0);
              cc.roundRect(0, 0, TILE_PX, TILE_PX, [
                up || west ? 0 : r,
                up || east ? 0 : r,
                down || east ? 0 : r,
                down || west ? 0 : r,
              ]);
            }
            cc.clip();
            drawRock(cc, tx, ty, sea);
          } else drawTile(cc, type, tx, ty, dmg);
          cc.restore();
        }
      }
      /* The sun, on the blocks themselves.
       *
       * Up to here the only lighting a block had was `bevel` in art.js: a two-pixel white line on
       * the top-left and a dark one on the bottom-right, the same on every tile and in the same
       * place whatever the map's light is doing. That is an outline pretending to be shading, and
       * it is why a wall of crates read as a flat pattern.
       *
       * This is the real thing, and it is three passes over one tile:
       *
       *   the ramp    a linear gradient ACROSS the tile along the sun's own direction - bright on
       *               the face the light comes from, dark on the face it cannot reach. The map's
       *               light points anywhere in a half-circle (see sunVec), so this is the first
       *               thing on the board that actually answers to it.
       *   the rim     a short bright line on the two sunward edges, which is what makes a block
       *               read as having a TOP: a lit edge is a corner catching the light.
       *   the shade   a hashed tint per tile, a few percent either way, so sixteen identical
       *               crates in a row are sixteen crates rather than one texture tiled sixteen
       *               times. Deterministic in (tx, ty) like everything else in the terrain, or a
       *               wall would reshuffle itself every time a neighbour broke.
       *
       * All of it lands in the chunk cache, so the cost is a few gradients when a chunk is built
       * and nothing at all per frame.
       */
      lightPass(cc, cx, cy, map, sdx, sdy);

      // Moss over the blocks and the sand, under the occlusion so a crease is dark whether there
      // is moss in it or not. See the long note on mossAt.
      mossPass(cc, cx, cy, map);

      /* Ambient occlusion, baked.
       *
       * The sun shadow says where the light comes FROM. This says where it cannot reach: the
       * inside of every join between the floor and something standing on it. Real surfaces go
       * darker in their creases because less of the sky can see them, and it is the single
       * cheapest thing that stops a flat top-down board looking like a diagram - walls gain a
       * foot, corridors gain depth, and a crate reads as sitting ON the sand rather than being a
       * differently-coloured square of it.
       *
       * Deliberately light. Two soft stamps per floor tile per solid neighbour at a few percent
       * alpha: enough that the board looks softer, far short of the smudged look that gives a
       * cheap "AO slider" away. It is also honest about what it darkens - the floor only, never
       * the block, because darkening the block's own top would flatten the thing it is shading.
       *
       * FREE in the frame loop. It lands in the chunk cache with everything else, so the cost is
       * a few hundred drawImages when a chunk is first built or a wall changes, and nothing at
       * all per frame. That is the whole reason it can afford to exist at this quality.
       */
      aoPass(cc, cx, cy, map);

      // The rounded coast, after every tile: a fillet paints over its neighbours' old outline.
      for (let j = 0; j < CHUNK_TILES; j++) {
        for (let i = 0; i < CHUNK_TILES; i++) {
          const tx = cx * CHUNK_TILES + i, ty = cy * CHUNK_TILES + j;
          if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) continue;
          const { carve, fill } = coastCorners(tx, ty);
          if (!carve.length && !fill.length) continue;
          cc.save();
          cc.translate(i * TILE_PX, j * TILE_PX);
          if (carve.length) carveRockCorners(cc, carve);
          if (fill.length) drawCoastFillets(cc, fill);
          cc.restore();
        }
      }
      c.dirty = false;
      redrawsThisSecond++;
    }
    return c.canvas;
  }

  /* Which tiles the light pass treats as objects standing on the sand.
   *
   * Everything solid, plus the two that are objects in their own right - a column and a keg are
   * shaped things on a floor, and they want the same ramp across them. Not FLOOR (it IS the
   * sand, and the floor already has its own tonal drift) and not WATER (the sea is lit by its own
   * depth gradient and its glints). */
  const LIT_BLOCKS = new Set([
    BLOCK.SOFT, BLOCK.REINFORCED, BLOCK.MONOLITH, BLOCK.IRON,
    BLOCK.COLUMN, BLOCK.POWDER, BLOCK.SHRUB_SOLID,
  ]);

  // How hard the light and the dark side of the ramp are driven, and how much a tile's own hashed
  // shade can vary. All three are deliberately modest: the ramp is doing the work, and anything
  // past this starts to read as a vignette on each tile rather than as a lit object.
  const LIGHT_FACE = 0.3, DARK_FACE = 0.34, SHADE_SPREAD = 0.075;

  /** The sun, across every block in one chunk. See the long note at the call site. */
  function lightPass(cc, cx, cy, map, sdx, sdy) {
    // The light's direction as a unit vector, pointing AWAY from the sun (that is what `sunVec`
    // gives: the direction a shadow is thrown).
    const len = Math.hypot(sdx, sdy) || 1;
    const ux = sdx / len, uy = sdy / len;
    const S = TILE_PX, H = S / 2;

    for (let j = 0; j < CHUNK_TILES; j++) {
      for (let i = 0; i < CHUNK_TILES; i++) {
        const tx = cx * CHUNK_TILES + i, ty = cy * CHUNK_TILES + j;
        if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) continue;
        const type = cellType(map.cells[ty * map.w + tx]);
        if (!LIT_BLOCKS.has(type)) continue;

        const x = i * S, y = j * S;
        cc.save();
        cc.beginPath();
        /* Clipped to the tile's own rounded shape, so the ramp does not paint over the sand in
         * the corners the rounding opened up. ICE is deliberately not in the set above: it is
         * translucent and lit from inside by its own frost and sheen, and a ramp across it would
         * put an opaque gradient over the one block you are supposed to see through. */
        cc.roundRect(x, y, S, S, type === BLOCK.IRON ? ROCK_RADIUS : STONE_RADIUS);
        cc.clip();

        /* The ramp. From the sunward edge to the far one, through the tile's centre, so the
         * gradient's axis is the light's axis whatever direction it points. */
        const g = cc.createLinearGradient(
          x + H - ux * H, y + H - uy * H,
          x + H + ux * H, y + H + uy * H,
        );
        g.addColorStop(0, `rgba(255,246,214,${LIGHT_FACE})`);        // warm light, not white
        g.addColorStop(0.45, 'rgba(255,255,255,0)');
        g.addColorStop(1, `rgba(6,10,18,${DARK_FACE})`);             // cool shadow, not black
        cc.fillStyle = g;
        cc.fillRect(x, y, S, S);

        /* The rim: a short bright line along the two sunward edges. This is the part that says
         * "this has a top" - a block with a lit edge is a solid standing in light, and a block
         * without one is a coloured square. */
        cc.globalAlpha = 0.5;
        cc.fillStyle = 'rgba(255,249,228,0.7)';
        if (uy > 0.25) cc.fillRect(x, y, S, 2);                      // light from above
        if (uy < -0.25) cc.fillRect(x, y + S - 2, S, 2);
        if (ux > 0.25) cc.fillRect(x, y, 2, S);                      // light from the left
        if (ux < -0.25) cc.fillRect(x + S - 2, y, 2, S);

        /* And this tile's own shade. A hash, so it never changes and no two neighbours agree -
         * the thing that turns a wall of crates back into a stack of individual crates. */
        const h = hash01(tx * 73856093 ^ ty * 19349663);
        const shade = (h - 0.5) * 2 * SHADE_SPREAD;
        cc.globalAlpha = Math.abs(shade);
        cc.fillStyle = shade > 0 ? '#fff6dc' : '#060a12';
        cc.fillRect(x, y, S, S);
        cc.restore();
      }
    }
  }

  /* ─── moss ───────────────────────────────────────────────────────────────────
   *
   * Growth on old stone, in patches that span several tiles and belong to the island rather than
   * to any one block of it.
   *
   * This replaces the green shrub blocks (see MAPS in shared/maps.js). Those were a block type -
   * a thing you could walk into, or not, depending on which of two nearly identical green squares
   * it was - and they were the one colour on the board that answered to nothing. Moss is the
   * opposite in every way that matters: it is paint, it has no rules, it never changes what you
   * can walk through, and it is drawn ACROSS tiles so it reads as something that grew there
   * rather than as something that was placed.
   *
   * The pattern is value noise at two frequencies. The low one - a cell every five tiles -
   * decides where a patch is; the high one breaks its edge up so the boundary is ragged rather
   * than a smooth blob. Bilinear interpolation between hashed lattice points, which is the
   * cheapest noise that does not look like static, and deterministic in (tx, ty) so a patch is
   * the same patch forever and does not reshuffle when a wall beside it breaks.
   *
   * Baked into the chunk cache, so all of it costs nothing per frame.
   */
  /* The pattern, and the shape of it.
   *
   * Three frequencies, and each one is answering a different question:
   *
   *   MOSS_PATCH  where a patch IS. A cell every six tiles, so a patch is a feature of the
   *               island rather than of a tile - it runs along a wall, fills the inside of a
   *               bay, climbs over the corner of a block and carries on.
   *   MOSS_BREAK  whether its edge is ragged. Just over a tile, which is the scale at which the
   *               eye reads "irregular" rather than "noisy".
   *   MOSS_GRAIN  the density WITHIN a patch, at a third of a tile. This is what stops the
   *               middle of a patch being a flat field of green: moss grows in clumps, with the
   *               stone showing through between them.
   *
   * All three are the same bilinear value noise sampled in WORLD coordinates, which is the whole
   * reason it does not look like a tile effect: a tile asks the field what is at its position and
   * gets an answer that continues into its neighbours.
   */
  const MOSS_PATCH = 6;
  const MOSS_BREAK = 1.3;
  const MOSS_GRAIN = 0.34;
  const MOSS_AT = 0.54;          // above this there is moss; the margin above it is its density
  /* Alpha at the heart of a patch, and it is deliberately low.
   *
   * The first pass at this was 0.3 of a saturated green painted over the whole tile, and the
   * report was the honest one: it stood out. Moss on old stone is not a colour, it is a slight
   * shift in one - darker, duller, a little cooler than the stone under it - and the thing that
   * makes it read as moss is the SHAPE, not the saturation. So the alpha came down by nearly
   * half and everything that was spent on colour is spent on edges instead.
   */
  const MOSS_MAX = 0.17;

  const smooth = t => t * t * (3 - 2 * t);

  /** Value noise at `freq` tiles per cell, 0..1, smooth and seedable. */
  function noiseAt(x, y, freq, seed) {
    const fx = x / freq, fy = y / freq;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = smooth(fx - x0), ty = smooth(fy - y0);
    const at = (i, j) => hash01((i * 73856093) ^ (j * 19349663) ^ seed);
    const a = at(x0, y0), b = at(x0 + 1, y0), c = at(x0, y0 + 1), d = at(x0 + 1, y0 + 1);
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  }

  /**
   * How mossy a point is, 0..1, in TILE coordinates with a fraction.
   *
   * Sampled per blob rather than per tile, which is the difference between moss and green
   * squares: the patch term decides the area, the break term ruins its outline, and the grain
   * term thins it out from the inside so a patch has holes in it.
   */
  function mossAt(x, y) {
    const patch = noiseAt(x, y, MOSS_PATCH, 0x6d055);
    const edge = noiseAt(x, y, MOSS_BREAK, 0x9e3779);
    const v = patch * 0.76 + edge * 0.24;
    if (v <= MOSS_AT) return 0;
    const strength = Math.min(1, (v - MOSS_AT) / 0.3);
    // The grain bites hardest at the thin edges of a patch and barely at all in its heart, so a
    // patch fades out through clumps rather than through transparency.
    const grain = noiseAt(x, y, MOSS_GRAIN, 0x5eed9);
    return Math.max(0, strength - (1 - strength) * 0.8 - (0.5 - grain) * 0.55);
  }

  /* What moss grows on: the sand and every kind of stone. Not a crate - wood on a beach for a few
   * minutes does not grow anything, and more practically the crates are the one tile type that
   * has to stay instantly readable as breakable. Not ice, not water, not a keg. */
  const MOSSY = new Set([BLOCK.FLOOR, BLOCK.REINFORCED, BLOCK.MONOLITH, BLOCK.IRON, BLOCK.COLUMN]);

  /* Two greens, both pulled a long way toward the island's own palette.
   *
   * Picked by sampling an olive and a sage against the sand and the rock rather than by being
   * chosen as greens: anything with real saturation in it reads as a sprite laid on top, because
   * nothing else on this island is green. The darker one is the body of a clump and the lighter
   * one is the few millimetres of it that catch the light.
   */
  const MOSS_DARK = '58,74,45';
  const MOSS_LIT = '122,140,86';
  /* And a third, for the creeping edge.
   *
   * Two tones made a patch that was dark in the middle and dark at the rim, which reads as a
   * stain. Real growth is YOUNGEST at its edge - thinner, yellower, a little brighter than the
   * mass behind it - so the frontier gets a tone of its own and the patch suddenly has a
   * direction to it. It is the single cheapest thing that turns a blob into something growing. */
  const MOSS_EDGE = '146,154,84';

  /* One blob per third of a tile, which is the resolution the pattern is actually drawn at.
   *
   * Nine samples per tile, each a soft radial gradient about two thirds of a tile across. They
   * overlap heavily, so a patch is built out of a few dozen overlapping circles with no edge of
   * their own - and because the field is continuous, the blobs on either side of a tile boundary
   * are part of the same shape. That is the entire trick: there is no rectangle anywhere in it.
   */
  const MOSS_STEP = 1 / 3;

  function mossSprite(tone) {
    const el = document.createElement('canvas');
    const R = Math.ceil(TILE_PX * 0.62);
    el.width = el.height = R * 2;
    const c = el.getContext('2d');
    const g = c.createRadialGradient(R, R, 0, R, R, R);
    // No hard stop anywhere in it: a blob with an edge is a dot, and a hundred dots is a texture.
    g.addColorStop(0, `rgba(${tone},0.85)`);
    g.addColorStop(0.45, `rgba(${tone},0.4)`);
    g.addColorStop(0.78, `rgba(${tone},0.1)`);
    g.addColorStop(1, `rgba(${tone},0)`);
    c.fillStyle = g;
    c.fillRect(0, 0, R * 2, R * 2);
    return el;
  }
  let mossDark = null, mossLit = null, mossEdge = null;

  /**
   * Moss over one chunk, after the blocks and their lighting, before the occlusion.
   *
   * Clipped to the union of the chunk's mossy tiles - built as one path, so a patch spreads
   * across tile boundaries freely and stops dead at the edge of a crate or a puddle, which is
   * exactly how growth behaves: it covers what it can grow on and nothing else.
   */
  function mossPass(cc, cx, cy, map) {
    const S = TILE_PX;
    mossDark ??= mossSprite(MOSS_DARK);
    mossLit ??= mossSprite(MOSS_LIT);
    mossEdge ??= mossSprite(MOSS_EDGE);

    // The clip. One path for the whole chunk rather than a save/clip/restore per tile: it is the
    // thing that lets a blob straddle two tiles.
    const area = new Path2D();
    let any = false;
    for (let j = 0; j < CHUNK_TILES; j++) {
      for (let i = 0; i < CHUNK_TILES; i++) {
        const tx = cx * CHUNK_TILES + i, ty = cy * CHUNK_TILES + j;
        if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) continue;
        const type = cellType(map.cells[ty * map.w + tx]);
        if (!MOSSY.has(type)) continue;
        any = true;
        const r = type === BLOCK.FLOOR ? 0 : type === BLOCK.IRON ? ROCK_RADIUS : STONE_RADIUS;
        area.roundRect(i * S, j * S, S, S, r);
      }
    }
    if (!any) return;

    cc.save();
    cc.clip(area);

    /* Sampled one tile WIDER than the chunk on every side.
     *
     * A blob is two thirds of a tile across, so one centred just outside the chunk still reaches
     * into it. Skipping those would leave a faint seam along every chunk boundary - visible
     * exactly where the pattern is supposed to prove it does not know about the grid.
     */
    const x0 = cx * CHUNK_TILES - 1, y0 = cy * CHUNK_TILES - 1;
    const x1 = x0 + CHUNK_TILES + 2, y1 = y0 + CHUNK_TILES + 2;
    const R = mossDark.width / 2;

    for (let ty = y0; ty <= y1; ty += MOSS_STEP) {
      for (let tx = x0; tx <= x1; tx += MOSS_STEP) {
        const m = mossAt(tx, ty);
        if (m <= 0.04) continue;

        /* Jittered off the sampling grid, by the field itself.
         *
         * Without this the blob centres sit on a lattice a third of a tile apart, and at the
         * thin end of a patch - where only a few blobs survive the threshold - that lattice is
         * visible as a dotted texture. The offset is deterministic in the sample position, so it
         * is the same jitter forever.
         */
        const jx = (noiseAt(tx * 7 + 3, ty * 7 + 11, 0.5, 0x3a7c1) - 0.5) * S * 0.42;
        const jy = (noiseAt(tx * 7 + 17, ty * 7 + 5, 0.5, 0x8b115) - 0.5) * S * 0.42;
        const px = (tx - cx * CHUNK_TILES) * S + S / 2 + jx;
        const py = (ty - cy * CHUNK_TILES) * S + S / 2 + jy;

        /* Size varies with density AND with a field of its own.
         *
         * Density alone made every clump at a given thickness the same size, which at the heart
         * of a patch is a field of identical circles - the eye finds that repetition long before
         * it finds the colour. A second noise at half a tile breaks the sizes up, so a patch is
         * built from clumps that differ from their neighbours the way real ones do.
         */
        const lump = noiseAt(tx * 3 + 31, ty * 3 + 7, 0.5, 0x1f5a3);
        const scale = (0.5 + m * 0.6) * (0.72 + lump * 0.62);
        const w = R * 2 * scale;
        cc.globalAlpha = m * MOSS_MAX;
        cc.drawImage(mossDark, px - w / 2, py - w / 2, w, w);

        /* The frontier, where the moss is thin: younger, yellower, brighter.
         *
         * Between 0.12 and 0.4 of thickness - the band a patch fades out through - and brightest
         * in the middle of that band, so it reads as a rim following the outline rather than as
         * a second patch inside the first. */
        if (m > 0.12 && m < 0.42) {
          const rim = 1 - Math.abs((m - 0.27) / 0.15);
          if (rim > 0) {
            cc.globalAlpha = rim * MOSS_MAX * 0.85;
            const ew = w * 0.72;
            cc.drawImage(mossEdge, px - ew / 2, py - ew / 2, ew, ew);
          }
        }

        // And the lit half, offset a little toward the light and only where the moss is thick.
        if (m > 0.45) {
          cc.globalAlpha = (m - 0.45) * MOSS_MAX * 1.1;
          const lw = w * (0.45 + lump * 0.3);
          cc.drawImage(mossLit, px - lw / 2 - 1.5, py - lw / 2 - 2, lw, lw);
        }
      }
    }
    cc.restore();
    cc.globalAlpha = 1;
  }

  /* The two AO stamps, baked once: an edge and an inside corner.
   *
   * Gradients rather than flat rects, because a hard-edged band of shadow along a wall reads as a
   * second wall. Both are drawn at tile scale and rotated into place, so one edge sprite serves
   * all four sides and one corner sprite all four corners.
   */
  const AO_REACH = Math.round(TILE_PX * 0.46);      // how far into the floor the dark reaches
  /* 0.72, up from 0.3.
   *
   * The first pass was tuned to be deniable - "the board looks softer" - and the honest report
   * was that you could not see it. Occlusion in a crease is not subtle in life: the inside of a
   * join between a wall and the floor is genuinely dark, and at nearly half a tile of reach and
   * this alpha the corridors finally have depth instead of a hint of one. The falloff below is
   * what keeps it from reading as paint: dense in the first few pixels, almost gone by the end.
   */
  const AO_ALPHA = 0.72;
  let aoEdge = null, aoCorner = null;

  function aoSprites() {
    if (aoEdge) return;
    aoEdge = document.createElement('canvas');
    aoEdge.width = TILE_PX; aoEdge.height = AO_REACH;
    const e = aoEdge.getContext('2d');
    const g = e.createLinearGradient(0, 0, 0, AO_REACH);
    // Squared falloff: dense in the first few pixels and almost gone by the end, which is how a
    // crease actually darkens. A linear ramp looks like a painted stripe.
    g.addColorStop(0, 'rgba(0,0,0,0.95)');
    g.addColorStop(0.3, 'rgba(0,0,0,0.46)');
    g.addColorStop(0.62, 'rgba(0,0,0,0.16)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    e.fillStyle = g;
    e.fillRect(0, 0, TILE_PX, AO_REACH);

    aoCorner = document.createElement('canvas');
    aoCorner.width = aoCorner.height = AO_REACH;
    const c = aoCorner.getContext('2d');
    const r = c.createRadialGradient(0, 0, 0, 0, 0, AO_REACH);
    r.addColorStop(0, 'rgba(0,0,0,0.92)');
    r.addColorStop(0.38, 'rgba(0,0,0,0.42)');
    r.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = r;
    c.fillRect(0, 0, AO_REACH, AO_REACH);
  }

  /**
   * Darken the floor where it meets anything solid, for one chunk.
   *
   * Edges first and corners second, each stamped once per solid neighbour, so a floor tile in an
   * alcove gets dark on three sides and a tile in the open gets nothing. Diagonal neighbours only
   * contribute where BOTH their shared sides are open - otherwise the corner is already covered
   * by two edges meeting and a third stamp just makes a blob.
   */
  function aoPass(cc, cx, cy, map) {
    aoSprites();
    const solid = (x, y) => {
      if (x < 0 || y < 0 || x >= map.w || y >= map.h) return false;      // off the board: sky
      const t = cellType(map.cells[y * map.w + x]);
      // Water is not an occluder: the sea is lower than the sand, not higher, and the shallows
      // and the coast outline are already doing that job.
      return t !== BLOCK.WATER && !BLOCK_WALKABLE(t, false);
    };
    cc.save();
    cc.globalAlpha = AO_ALPHA;
    for (let j = 0; j < CHUNK_TILES; j++) {
      for (let i = 0; i < CHUNK_TILES; i++) {
        const tx = cx * CHUNK_TILES + i, ty = cy * CHUNK_TILES + j;
        if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) continue;
        const here = cellType(map.cells[ty * map.w + tx]);
        /* Walkable ground only, and water is not ground.
         *
         * A water tile is never painted into the chunk at all - it is left transparent so the
         * animated sea shows through (see the clearRect above) - so a stamp there would be a dark
         * smear floating on the sea rather than a crease in anything. The coast gets its depth
         * from the shallows and the island's own shadow instead.
         */
        if (!BLOCK_WALKABLE(here, false) || here === BLOCK.WATER) continue;
        const x = i * TILE_PX, y = j * TILE_PX;
        const up = solid(tx, ty - 1), down = solid(tx, ty + 1);
        const left = solid(tx - 1, ty), right = solid(tx + 1, ty);

        // One rotation per side, drawing the same strip each time.
        if (up) cc.drawImage(aoEdge, x, y);
        if (down) {
          cc.save();
          cc.translate(x + TILE_PX, y + TILE_PX);
          cc.rotate(Math.PI);
          cc.drawImage(aoEdge, 0, 0);
          cc.restore();
        }
        if (left) {
          cc.save();
          cc.translate(x, y + TILE_PX);
          cc.rotate(-Math.PI / 2);
          cc.drawImage(aoEdge, 0, 0);
          cc.restore();
        }
        if (right) {
          cc.save();
          cc.translate(x + TILE_PX, y);
          cc.rotate(Math.PI / 2);
          cc.drawImage(aoEdge, 0, 0);
          cc.restore();
        }

        // Inside corners, from the diagonals, and only where neither shared side is already dark.
        const corners = [
          [-1, -1, !up && !left, x, y, 0],
          [1, -1, !up && !right, x + TILE_PX, y, Math.PI / 2],
          [1, 1, !down && !right, x + TILE_PX, y + TILE_PX, Math.PI],
          [-1, 1, !down && !left, x, y + TILE_PX, -Math.PI / 2],
        ];
        for (const [dx, dy, open, ax, ay, rot] of corners) {
          if (!open || !solid(tx + dx, ty + dy)) continue;
          cc.save();
          cc.translate(ax, ay);
          cc.rotate(rot);
          cc.drawImage(aoCorner, 0, 0);
          cc.restore();
        }
      }
    }
    cc.restore();
  }

  /** Which sides of this tile face open water, as a DIR_* bitmask. */
  function seaEdges(tx, ty) {
    const map = world.map;
    const sea = (x, y) =>
      x < 0 || y < 0 || x >= map.w || y >= map.h || cellType(map.cells[y * map.w + x]) === BLOCK.WATER;
    return (sea(tx + 1, ty) ? 1 : 0) | (sea(tx, ty - 1) ? 2 : 0)
         | (sea(tx - 1, ty) ? 4 : 0) | (sea(tx, ty + 1) ? 8 : 0);
  }

  /**
   * Which corners of this tile the rounded coast changes: `carve` for a rock tile's outside
   * corners (both sides facing the sea), `fill` for a water tile's inside corners (rock on both
   * sides and diagonally). See COAST_STEPS in art.js.
   */
  const NONE = Object.freeze({ carve: [], fill: [] });
  function coastCorners(tx, ty) {
    const map = world.map;
    const type = (x, y) => (x < 0 || y < 0 || x >= map.w || y >= map.h
      ? BLOCK.WATER : cellType(map.cells[y * map.w + x]));
    const here = type(tx, ty);
    if (here === BLOCK.IRON) {
      const e = seaEdges(tx, ty);
      const carve = e ? COAST_CORNERS.filter(k => (e & k.bits) === k.bits) : [];
      return carve.length ? { carve, fill: [] } : NONE;
    }
    if (here !== BLOCK.WATER) return NONE;
    const fill = COAST_CORNERS.filter(k => type(tx - k.sx, ty) === BLOCK.IRON
      && type(tx, ty - k.sy) === BLOCK.IRON && type(tx - k.sx, ty - k.sy) === BLOCK.IRON);
    return fill.length ? { carve: [], fill } : NONE;
  }

  /**
   * The land, at a quarter of a tile: 1 for rock or island, 0 for sea, with the rounded corners
   * applied. Cached per map; the shallows are measured from this so the water follows the
   * stepped coast rather than the square tiles under it.
   */
  let coastMaskFor = null, coastMaskCells = null;
  function coastMask() {
    const map = world.map;
    if (coastMaskFor === map) return coastMaskCells;
    const W = map.w * 4, m = new Uint8Array(W * map.h * 4);
    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) {
        const land = cellType(map.cells[ty * map.w + tx]) !== BLOCK.WATER;
        const { carve, fill } = coastCorners(tx, ty);
        const cut = carve.length ? cornerCells(carve) : null;
        const add = fill.length ? cornerCells(fill) : null;
        for (let i = 0; i < 16; i++) {
          const on = land ? !(cut && cut[i]) : !!(add && add[i]);
          if (on) m[(ty * 4 + (i >> 2)) * W + tx * 4 + (i & 3)] = 1;
        }
      }
    }
    coastMaskFor = map; coastMaskCells = m;
    return m;
  }

  /**
   * The shoreline, cached once per map.
   *
   * Scanning every tile for a coast every frame would be the single most expensive thing the
   * renderer does. The coast never changes - rock is indestructible and water never becomes
   * anything else - so it is computed on the first frame after a map arrives and then reused.
   */
  let shore = null;
  function shoreline() {
    if (shore) return shore;
    const map = world.map;
    shore = [];
    for (let ty = 0; ty < map.h; ty++) {
      for (let tx = 0; tx < map.w; tx++) {
        if (cellType(map.cells[ty * map.w + tx]) !== BLOCK.IRON) continue;
        const e = seaEdges(tx, ty);
        if (e) shore.push({ tx, ty, e });
      }
    }
    return shore;
  }

  /**
   * Foam breaking on a rock. Spawned at a trickle from random shoreline tiles, capped hard.
   *
   * A real particle system would be the obvious thing and the wrong one: the sea is scenery and
   * is not allowed to compete with sixteen players and a chain reaction for the frame budget.
   * Thirty short-lived circles, spawned a couple a second, reads as a coast.
   */
  // ─── the sea, as particles ──────────────────────────────────────────────────
  //
  // A real simulation, not a scrolling texture: a fixed pool of drifting particles advected by a
  // flow field, recycled when they leave the visible water. Fixed pool and no allocation per
  // frame - a particle system that grows is a particle system that eventually drops frames, and
  // the sea is scenery that may never compete with sixteen players and a chain reaction.
  //
  // The flow field is two crossed sine waves sampled at the particle's position. It costs two
  // sin() per particle per frame and produces swirls, eddies and a slow prevailing drift, which
  // is everything the eye needs to read it as water.
  /* Doubled twice, from the original 220.
   *
   * The field was readable but sparse - at any one moment most of the open water had nothing
   * moving in it, so the current was something you inferred rather than saw. At 880 the whole
   * surface is in motion and the eddies round the island and the boulders are visible as
   * shapes rather than as individual streaks.
   *
   * Cost is linear and still small: four sin() per particle per frame, no allocation, no
   * collision, and all of it against a budget that is actually spent on sixteen players and a
   * chain reaction. If this ever needs to come back down, it is one number.
   */
  /* The particle current is gone - see the note where it used to be drawn.
   *
   * What is left of it is the FIELD, `flowAt` below, which is now a service rather than a
   * picture: the dust off a slide, the bioluminescence and the drying puddles all drift on it, so
   * everything in the world that floats agrees about which way the water is going.
   */
  /**
   * The current: a prevailing drift with two wave trains riding on it, all rolled per map.
   *
   * The drift used to run straight down the screen at a fixed speed, which reads as a conveyor
   * belt rather than as water. What was still fixed after that was the WAVES: both sine terms
   * were axis-aligned, one travelling along y and one along x, so whatever the drift was doing
   * underneath, the surface corrugation always ran square to the screen. The current angle only
   * scaled their amplitude, which is not the same as turning them.
   *
   * So each train now has its own direction, wavelength, speed and amplitude. The sine is taken
   * along a PROJECTION onto that direction - `x*cos(a) + y*sin(a)` is distance measured along
   * the heading - which is what actually makes a plane wave travel that way.
   *
   * The two headings straddle the drift by a random 20-45 degrees rather than a fixed 30. Wind
   * waves and the current beneath them are never quite aligned, and two trains crossing at a
   * slight angle is what produces the wandering interference a real surface has. Identical
   * headings would just sum into one bigger wave.
   */
  const current = { angle: 0, speed: 0, trains: [], surface: [] };

  // The ranges. A drift is a drift, not a river, and a wavelength shorter than ~60px turns into
  // visual noise once the whole map is zoomed to fit.
  const DRIFT_SPEED = [9, 22];            // world px/s
  const TRAIN_SPREAD = [Math.PI / 9, Math.PI / 4];   // 20-45 degrees off the drift
  const TRAIN_WAVELENGTH = [88, 275];     // px between crests (a quarter wider than the first pass)
  const TRAIN_SPEED = [16, 52];           // px/s the crests travel
  const TRAIN_AMPLITUDE = [7, 16];        // px/s of sideways push at the crest

  /* The envelope: a wave within the wave.
   *
   * Real water is not evenly rough. Wind lanes, fetch and shelter leave bands of chop sitting
   * next to bands of near-glass, and those bands drift. A uniformly agitated surface is the
   * thing that reads as "simulation" rather than as sea, however good the individual waves are.
   *
   * So each train's amplitude is multiplied by a second, much longer, much slower wave running
   * at its own heading. Where the envelope peaks the train is at full strength; in its troughs
   * it drops to ENVELOPE_FLOOR of it. The envelope's heading is rolled independently of the
   * train's, so the calm patches travel ACROSS the waves rather than with them - which is what
   * makes them read as areas of water rather than as part of the wave pattern.
   */
  const ENVELOPE_WAVELENGTH = [400, 1125];  // px across a band of chop
  const ENVELOPE_SPEED = [4, 14];           // px/s the bands drift
  const ENVELOPE_FLOOR = 0.3;               // how calm the calm patches get

  /* The two tiled surface layers get the same treatment as the particles.
   *
   * These are the squiggles you actually see - the particle field is the motion, this is the
   * texture. They used to drift at a hard-coded (11, 5) and (-7, 9) and were drawn axis-aligned,
   * so every map had the same sea running the same way down the screen whatever the current
   * underneath it was doing. Now the whole pattern is rotated to the map's heading and each
   * layer drifts at its own angle off it, which is what produces parallax that looks like water
   * rather than like two sheets sliding.
   */
  const SURFACE_DRIFT = [5, 15];                   // px/s each layer travels
  const SURFACE_SPREAD = [-Math.PI / 5, Math.PI / 5];

  /* Scenery is part of the MAP, not part of this window.
   *
   * The sea's heading, the boulders out in the water and where the ship is moored were all rolled
   * off Math.random(), which made them three different things at once: different for every player
   * in the room, different for the same player after a resize, and different on the same map from
   * one round to the next. All three are wrong for the same reason - two people talking about
   * "the rock by the wreck" have to be looking at the same rock.
   *
   * So they come off a stream seeded from the map itself. Every client builds the identical sea,
   * nothing reshuffles when the window changes, and a given map always looks like itself. Only
   * the transient things - foam, splashes, dust, sparks - still use Math.random(), which is right:
   * nobody can compare a splash.
   *
   * Mulberry32, the same shape as the simulation's own rng, because determinism from a seed is
   * the entire requirement and thirty-two bits of it is plenty for where to put a rock.
   */
  function seededRng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** A stream for one aspect of one map. `salt` keeps the aspects independent of each other. */
  function mapRng(salt) {
    const map = world.map || {};
    let h = (map.seed ?? 0) ^ ((map.w | 0) * 73856093) ^ ((map.h | 0) * 19349663);
    for (const ch of String(map.id ?? '')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return seededRng((h ^ salt) >>> 0);
  }

  // Set by whoever is rolling: `between` reads it, so the thirty-odd calls below did not each
  // have to be threaded with a generator.
  let roll = Math.random;
  const between = ([lo, hi]) => lo + roll() * (hi - lo);

  function rollSurface() {
    roll = mapRng(0x5ea50);
    current.surface = [0, 1].map(() => {
      const a = between(SURFACE_SPREAD);
      const sp = between(SURFACE_DRIFT);
      return { sx: Math.cos(a) * sp, sy: Math.sin(a) * sp };
    });
  }

  function rollCurrent() {
    /* Seeded from the map, so the sea is the same sea for everybody in the room and the same sea
     * every time that map comes round. See mapRng. */
    roll = mapRng(0x0cea4);
    // The heading everything is rolled around: a full turn, so no two maps share an orientation.
    current.angle = roll() * Math.PI * 2;
    current.speed = between(DRIFT_SPEED);
    rollSurface();
    current.trains = [-1, 1].map(side => {
      // Each train is rotated off the drift by its own random angle, on its own side of it.
      const heading = current.angle + side * between(TRAIN_SPREAD);
      const wavelength = between(TRAIN_WAVELENGTH);
      // The envelope gets a heading of its own, anywhere on the circle.
      const envHeading = roll() * Math.PI * 2;
      const envWavelength = between(ENVELOPE_WAVELENGTH);
      return {
        // Precomputed because this runs per particle per frame.
        dx: Math.cos(heading), dy: Math.sin(heading),
        k: (Math.PI * 2) / wavelength,          // radians of phase per pixel
        w: ((Math.PI * 2) / wavelength) * between(TRAIN_SPEED),   // and per second
        amp: between(TRAIN_AMPLITUDE),
        phase: roll() * Math.PI * 2,
        edx: Math.cos(envHeading), edy: Math.sin(envHeading),
        ek: (Math.PI * 2) / envWavelength,
        ew: ((Math.PI * 2) / envWavelength) * between(ENVELOPE_SPEED),
        ephase: roll() * Math.PI * 2,
      };
    });
    // Back to the real thing: everything transient below this - foam, splashes, dust - wants it.
    roll = Math.random;
  }

  /**
   * How strong this train is at this point, right now. Between ENVELOPE_FLOOR and 1.
   *
   * Kept as its own function so both flow axes use the identical value: computing it twice from
   * the same inputs would be correct, but a single call site is one fewer place for the two
   * components of one vector to drift apart.
   */
  const envelopeAt = (s, x, y, t) => {
    const e = Math.sin((x * s.edx + y * s.edy) * s.ek - t * s.ew + s.ephase);
    return ENVELOPE_FLOOR + (1 - ENVELOPE_FLOOR) * (0.5 + 0.5 * e);
  };
  rollCurrent();

  /**
   * Flow at a point, as a vector.
   *
   * Each train pushes ACROSS its own direction of travel, not along it: water in a passing swell
   * moves side to side while the crest moves forward. Pushing along the heading would make the
   * particles race the wave and the whole field would shear apart.
   */
  /* How much the boulders push the water aside at a point.
   *
   * A simple radial repulsion that dies off with distance: close in it is strong enough to steer
   * particles round the rock, and past a few radii it is nothing. Not fluid dynamics - the eye
   * is not checking for conservation of mass, it is checking that the water does not sail
   * straight through a rock.
   */
  const ROCK_PUSH = 46;
  function rockFlow(x, y, out) {
    out.x = 0; out.y = 0;
    for (const k of (rocksFor === world.map ? seaRocks : waterRocks())) {
      const dx = x - k.x, dy = y - k.y;
      const d2 = dx * dx + dy * dy;
      const reach = k.r * 3.2;
      if (d2 > reach * reach || d2 < 1) continue;
      const d = Math.sqrt(d2);
      const f = (1 - d / reach) ** 2 * ROCK_PUSH;
      out.x += (dx / d) * f;
      out.y += (dy / d) * f;
    }
  }
  const rockPush = { x: 0, y: 0 };

  /* The flow at a point, both components at once, into `out`.
   *
   * It used to be two functions, flowX and flowY, and each one evaluated the envelope and the
   * wave for every train - the same two sines computed twice for every particle, every frame,
   * just to take a different component of one vector. One pass, half the trigonometry. */
  const flow = { x: 0, y: 0 };
  function flowAt(x, y, t, out) {
    rockFlow(x, y, rockPush);
    let vx = Math.cos(current.angle) * current.speed + rockPush.x;
    let vy = Math.sin(current.angle) * current.speed + rockPush.y;
    for (const s of current.trains) {
      const push = Math.sin((x * s.dx + y * s.dy) * s.k - t * s.w + s.phase)
        * s.amp * envelopeAt(s, x, y, t);
      vx -= push * s.dy;
      vy += push * s.dx;
    }
    out.x = vx; out.y = vy;
    return out;
  }

  // Fewer, bigger, slower. Small frequent splashes read as static along the whole coast; a
  // handful of large slow swells read as a sea. Roughly one every two seconds, each living about
  // three times as long as the old ones and spreading to several tiles across.
  const MAX_SPLASHES = 4;
  const SPLASH_EVERY_MS = 8000;

  function spawnSplash() {
    if (splashes.length >= MAX_SPLASHES) return;

    // One in three breaks on a boulder rather than on the island. They are small and far out,
    // so without their own share of the foam they would be the only still thing in the water.
    const rocks = waterRocks();
    if (rocks.length && Math.random() < 0.34) {
      const k = rocks[(Math.random() * rocks.length) | 0];
      const a = Math.random() * Math.PI * 2;
      splashes.push({
        x: k.x + Math.cos(a) * k.r * 0.95,
        y: k.y + Math.sin(a) * k.r * 0.8,
        life: 1,
        r: 8 + Math.random() * 8,
        rate: 0.18 + Math.random() * 0.14,
      });
      return;
    }

    const edges = shoreline();
    if (!edges.length) return;
    const s = edges[(Math.random() * edges.length) | 0];
    // Push the swell out onto the water side, so it breaks against the rock rather than on it.
    const dx = (s.e & 1 ? 1 : 0) - (s.e & 4 ? 1 : 0);
    const dy = (s.e & 8 ? 1 : 0) - (s.e & 2 ? 1 : 0);
    if (!dx && !dy) return;
    splashes.push({
      x: (s.tx + 0.5 + dx * 0.7) * TILE_PX,
      y: (s.ty + 0.5 + dy * 0.7) * TILE_PX,
      life: 1,
      r: 9 + Math.random() * 9,
      rate: 0.16 + Math.random() * 0.12,       // five to six seconds to fade
    });
  }

  /* The ship, anchored out in open water.
   *
   * Scenery, and deliberately in the background: half the size she was, well off the coast, and
   * painted down into the colour of the sea so she never competes with a bomb or a player for
   * attention. The test for a piece of set dressing is whether you notice it when you are NOT
   * looking for it - if you do, it is too loud.
   *
   * Deterministic in the map, never random. Scenery that moves when you respawn is a bug as far
   * as the eye is concerned.
   */
  // Sized by eye, in rounds: two thirds larger, half again, then halved back and nudged up a
  // quarter. Left as the arithmetic rather than the product so the next round is one more
  // factor, not a number nobody can place.
  const SHIP_SCALE = 2 * 1.66 * 1.5 * 0.5 * 1.25 * 1.25;
  /* Solid enough to be a boat, and a fifth more so than that.
   *
   * At 0.42 she was a ghost of one: you could read the sea through her hull, which is the one
   * thing a hull must not do. 0.72 fixed the hull and still left the sea faintly showing through
   * her rigging and her sails; 0.86 is a boat with weather on it rather than a boat you can see
   * through. What keeps her in the background is being small, far out, and painted down into the
   * sea's own colour - never being see-through. */
  const SHIP_ALPHA = 0.86;
  // The rings and the shadow under her were sized for a scale of 2; they grow with her.
  const SHIP_GROW = SHIP_SCALE / 2;
  // drawShip's own extent, in its units: the wake rings reach ±80 along and ±41 across.
  const SHIP_BOX_W = 180, SHIP_BOX_H = 100;
  // Nearly solid. A boulder is a real object sitting in the water, not a shadow under it -
  // what keeps it in the background is its COLOUR, which is mixed well down toward the deep
  // sea, not its transparency. Fading it out just made it look like a rendering fault.
  const ROCK_ALPHA = 0.88;
  /* The shoal: the much wider mass each boulder is the tip of, lying under the surface.
   *
   * Twice the boulder's radius, darker than the deep sea and far fainter than the rock itself,
   * and - the part that matters - drawn UNDER the two scrolling surface layers, so the ripples
   * run across it. A submerged shape with the ripples on top of it is below the water; the same
   * shape over them is a stain on the water. That layering is the only thing doing the work
   * here, which is why this is its own pass inside drawSea rather than another lump in the
   * rock's own sprite. */
  const SHOAL_SPREAD = 2.1, SHOAL_ALPHA = 0.5;
  // Her centre sits this far outside the island's bounding box: half her beam plus the same
  // clearance from the coast she had at her old size, so growing her pushed her out to sea
  // rather than into the island. Still half past the edge of the board - present, cut off, and
  // obviously not something you can interact with.
  const SHIP_OFFSHORE_TILES = (57 / 2) * SHIP_SCALE / TILE_PX + 0.7;

  /* She is baked, not drawn.
   *
   * drawShip is a hundred and fifty-odd path operations, every frame, for something that never
   * changes shape - the single most expensive piece of scenery on the board. Drawn once into a
   * canvas at the exact device scale she is shown at, then blitted, she looks identical and costs
   * one drawImage. Re-baked only when the zoom or the pixel ratio changes. */
  let shipSprite = null, shipSpriteKey = '', shipShade = null;
  function bakedShip() {
    const k = SHIP_SCALE * view.zoom * view.dpr;
    const key = k.toFixed(4);
    if (shipSprite && shipSpriteKey === key) return shipSprite;
    const el = document.createElement('canvas');
    el.width = Math.ceil(SHIP_BOX_W * k);
    el.height = Math.ceil(SHIP_BOX_H * k);
    const c = el.getContext('2d');
    c.scale(k, k);
    c.translate(SHIP_BOX_W / 2, SHIP_BOX_H / 2);
    drawShip(c);

    /* Her silhouette, baked beside her, for the shadow she throws on the water.
     *
     * `source-in` over the finished sprite keeps her alpha and replaces every colour with
     * black: masts, rigging, the gap under the bowsprit and all. An ellipse under the hull -
     * which is what was there - is a shadow for a barge, and it is the one cast shadow on the
     * board big enough for the eye to check against the thing casting it.
     */
    const sh = document.createElement('canvas');
    sh.width = el.width; sh.height = el.height;
    const sc = sh.getContext('2d');
    sc.drawImage(el, 0, 0);
    sc.globalCompositeOperation = 'source-in';
    sc.fillStyle = '#000';
    sc.fillRect(0, 0, sh.width, sh.height);

    shipSprite = el; shipShade = sh; shipSpriteKey = key;
    return el;
  }

  let mooredFor = null, moored = null;
  function mooring() {
    if (mooredFor === world.map) return moored;
    mooredFor = world.map;
    const [lx, ly, lw, lh] = landBounds();
    /* Where she lies, how far out, how far along and how big - all off the map's own stream.
     *
     * The side and the drift used to come out of `w * 31 + h * 17` and `w % 7`, which is stable
     * and almost constant: two maps of similar size moored her in the same place at the same
     * size, and she was dead level with the island's middle on half of them. A seeded stream
     * gives every map its own answer to all four questions while keeping every client's answer
     * identical - see mapRng.
     */
    const rnd = mapRng(0x5417);
    const side = (rnd() * 4) | 0;                                // 0 right, 1 up, 2 left, 3 down
    const cx = (lx + lw / 2) * TILE_PX, cy = (ly + lh / 2) * TILE_PX;
    // How far offshore, give or take a third of a ship: close in off one island, standing well
    // out off the next.
    const off = SHIP_OFFSHORE_TILES * (0.82 + rnd() * 0.45);
    const outX = (lw / 2 + off) * TILE_PX;
    const outY = (lh / 2 + off) * TILE_PX;
    // Along the shore as well as away from it, so she is never level with the middle of the
    // island - which looks placed rather than anchored. Up to four tiles either way.
    const drift = (rnd() - 0.5) * 8 * TILE_PX;
    // And she is not the same ship every time: a fifth either side of her nominal size, which at
    // this distance reads as a different vessel rather than as a scaling error.
    const scale = 0.82 + rnd() * 0.4;

    const spots = [
      { x: cx + outX, y: cy + drift, angle: Math.PI / 2 },
      { x: cx + drift, y: cy - outY, angle: 0 },
      { x: cx - outX, y: cy + drift, angle: Math.PI / 2 },
      { x: cx + drift, y: cy + outY, angle: 0 },
    ];
    moored = { ...spots[side], side, scale };
    return moored;
  }

  function drawMoored(ox, oy) {
    const m = mooring();
    if (!m) return;
    ctx.save();
    ctx.globalAlpha = SHIP_ALPHA;
    ctx.translate(ox + m.x, oy + m.y);
    ctx.rotate(m.angle);
    // A slow roll at anchor. Tiny - a degree and a half - but a ship perfectly still on water
    // that is not reads as a sprite rather than as a boat.
    const roll = Math.sin(seaT * 0.45) * 0.026;
    ctx.rotate(roll);
    /* Her size for this map, applied to the whole rig at once.
     *
     * Inside the transform rather than baked into SHIP_SCALE, so the hull, the wake rings, the
     * collar of displaced water and the shadow all grow together - a ship whose wake did not
     * scale with her would read as the wrong ship in somebody else's water. See mooring. */
    if (m.scale !== 1) ctx.scale(m.scale, m.scale);
    // Her total heading, for anything below that has to work in world axes rather than hers.
    const heading = m.angle + roll;

    /* The water round the hull, which the ship did not have and the rocks did - so the rocks
     * were sitting IN the sea and the ship was sitting ON it. Wider than tall and offset down,
     * because a hull displaces water along its length: a circular collar round a boat reads as a
     * buoy. Breathes with the music exactly as much as the rocks' collars do, which is barely:
     * see the note there. */
    // The hull's shadow, cast the same way as everything on the island. Drawn before the wake,
    // so the foam rings sit on top of it rather than under.
    const sv = sunVec();
    const G = SHIP_GROW;

    /* Her own shape on the water, thrown away from the sun - not an ellipse under the hull.
     *
     * The offset and the flattening are both done in WORLD axes, which is why the rotations
     * either side are there: she is moored across the board as often as along it, and a shadow
     * that leaned with her heading instead of with the light would be a second sun.
     *
     * Nine times the island's offset, because she floats high out of the water and the shadow
     * of a thing is cast from its height. Far enough to read as light coming from somewhere,
     * close enough to stay attached to her.
     */
    ctx.save();
    ctx.globalAlpha = SHADOW_ALPHA * 0.5;
    ctx.rotate(-heading);                      // out of her frame, into the world's
    ctx.translate(sv.dx * 9, sv.dy * 9);
    ctx.scale(1, 0.5);                         // flat on the water, as a cast shadow is
    ctx.rotate(heading);                       // and back into hers, to draw her shape
    bakedShip();                               // keeps shipShade in step with the zoom
    if (shipShade) {
      ctx.drawImage(shipShade, -SHIP_BOX_W / 2 * SHIP_SCALE, -SHIP_BOX_H / 2 * SHIP_SCALE,
        SHIP_BOX_W * SHIP_SCALE, SHIP_BOX_H * SHIP_SCALE);
    }
    ctx.restore();

    const lap = mood.beat * 0.55 + mood.bass * 0.3;
    ctx.save();
    ctx.strokeStyle = PALETTE.foam;
    ctx.globalAlpha = 0.09 + 0.04 * lap;
    ctx.lineWidth = (2.6 + lap * 1.1) * G;
    ctx.beginPath(); ctx.ellipse(0, 7 * G, 30 * G * (1 + lap * 0.04), 11 * G * (1 + lap * 0.06), 0, 0, 7); ctx.stroke();
    ctx.globalAlpha = 0.045 + 0.025 * lap;
    ctx.lineWidth = (8 + lap * 3) * G;
    ctx.beginPath(); ctx.ellipse(0, 8 * G, 40 * G, 15 * G, 0, 0, 7); ctx.stroke();
    ctx.restore();
    ctx.drawImage(bakedShip(), -SHIP_BOX_W / 2 * SHIP_SCALE, -SHIP_BOX_H / 2 * SHIP_SCALE,
      SHIP_BOX_W * SHIP_SCALE, SHIP_BOX_H * SHIP_SCALE);
    ctx.restore();
  }

  /* Two boulders out in the water, per map.
   *
   * Deterministic in the map like everything else out here, placed outside the island's bounding
   * box so they never touch the playfield, and allowed to sit half off the edge of the board -
   * a rock that is politely fully visible looks placed, one that runs off the edge looks like
   * the island carried on under the water.
   *
   * They are not just paint: the flow field is deflected round them (see flowAt) and the
   * shoreline foam spawns off them, so the water acknowledges they are there. A static rock in a
   * moving current is the one thing that would make the sea look fake.
   */
  /* Boulders out in the water: two or three, rolled fresh every time a map loads.
   *
   * Random rather than derived from the map, because they are weather rather than terrain -
   * nothing in the game interacts with them, so a different arrangement each round is free
   * variety. They are placed outside the island's bounding box and allowed to sit half off the
   * edge of the board: a rock that is politely fully visible looks placed, one that runs off the
   * edge looks like the island carried on under the water.
   *
   * Not just paint. The flow field is deflected round them (see rockFlow) and a share of the
   * foam breaks on them, so the water acknowledges they are there. A static rock in a moving
   * current is the one thing that would make the sea look fake.
   *
   * COLOUR IS THE WHOLE PROBLEM with these. At the shoreline palette they read as pieces of
   * island that have come adrift and pull the eye straight off the board. They are drawn in a
   * much darker, sea-tinted version of the same stone and at reduced opacity, so they sit at
   * about the brightness of the deep water around them: you see shapes, not objects.
   */
  const SEA_ROCKS = 3;
  let rocksFor = null, seaRocks = [];
  let rockSprites = null, rockSpritesFor = null;

  /* Placed against the VIEW, not just against the island.
   *
   * Dropping them a fixed distance beyond the land was simple and wrong: on a wide window they
   * fell outside the frame entirely and nobody ever saw one, and on a narrow one they sat on
   * top of the coast. The sea you can actually see is a band between the edge of the island and
   * the edge of the board, and its width depends on the window and the zoom.
   *
   * So the band is measured and the rocks are placed inside it, with a guarantee rather than a
   * hope: the first is positioned to be **entirely** on screen, and the other two to be **at
   * least a fifth** on screen - those two are allowed to run off the edge, which is what stops
   * the set looking arranged.
   *
   * Re-rolled when the map changes or when the window resizes enough to move the band, because
   * a rock that was fully visible before you resized should still be.
   */
  const ROCK_FULLY_VISIBLE = 1;
  const ROCK_MIN_VISIBLE = 0.2;
  // How much bigger than its band the set is drawn, in rounds of the user asking: the largest
  // doubled, then +75%, then halved back; the others +70% and then +50% and left there. The
  // small ones staying put is the point - the set reads as a set because they differ.
  const ROCK_GROW_LARGEST = 2 * 1.75 * 0.5;
  const ROCK_GROW_OTHERS = 1.7 * 1.5;
  // The smallest a rock may be sized before that growth, in tiles. Tripled on request.
  const ROCK_MIN_FULL = 0.35 * 3, ROCK_MIN_OTHERS = 0.9 * 3;

  function waterRocks() {
    if (rocksFor === world.map) return seaRocks;
    rocksFor = world.map;

    const [lx, ly, lw, lh] = landBounds();
    const cx = (lx + lw / 2) * TILE_PX, cy = (ly + lh / 2) * TILE_PX;
    /* Measured against the BOARD, not the window.
     *
     * Against the window every player in the room had the boulders somewhere different, and your
     * own moved every time you resized - the cache key literally contained the window size. The
     * sea between the island and the edge of the map is the same sea for everybody, so that is
     * what the band is measured in now, and the whole set is identical on every screen. The board
     * is scaled to fit the map plus SEA_MARGIN_TILES, so anything inside this band is on screen.
     */
    const halfBoard = [
      Math.min(cx, world.map.w * TILE_PX - cx),
      Math.min(cy, world.map.h * TILE_PX - cy),
    ];
    const halfView = halfBoard;
    const halfLand = [(lw * TILE_PX) / 2, (lh * TILE_PX) / 2];
    // Every number below comes off the map's own stream: same rocks for everyone, every round.
    const rnd = mapRng(0x0c1a7);

    const bandOn = axis => halfView[axis] - (halfLand[axis] + TILE_PX * 1.2);
    // The fully-visible one goes on whichever axis has the most spare sea, because it is the
    // only one that has to fit the band twice over. The others take what is left.
    const widest = bandOn(0) >= bandOn(1) ? 0 : 1;

    seaRocks = [];
    const spin = (rnd() * 4) | 0;

    /* Sized first, placed second, because the sizes depend on each other.
     *
     * Each rock gets the radius its band allows, as before, and then the whole set is scaled up:
     * the biggest by ROCK_GROW_LARGEST and the rest by ROCK_GROW_OTHERS. Grown that much they no
     * longer fit the band they were sized for, and that is the point - they are meant to loom.
     * So the guarantees relax with them: the "fully visible" rock is now kept clear of the coast
     * and allowed to run off the board, and the others stay clear of the coast too. */
    // The side the ship is moored off, in this function's numbering (mooring() counts 1 as up,
    // here 1 is down). Grown this large, a rock and the ship on one side would sit on each other.
    const shipSide = [0, 3, 2, 1][(world.map.w * 31 + world.map.h * 17) % 4];
    const plans = [];
    for (let i = 0; i < SEA_ROCKS; i++) {
      let side = i === 0
        ? widest + (rnd() < 0.5 ? 0 : 2)        // same axis, either end
        : (spin + i) % 4;
      if (side === shipSide) side = (side + 2) % 4;
      const horizontal = side % 2 === 0;
      const axis = horizontal ? 0 : 1;
      const inner = halfLand[axis] + TILE_PX * 1.2;     // just clear of the coast
      const outer = halfView[axis];                      // the edge of the board
      const band = outer - inner;
      const full = i < ROCK_FULLY_VISIBLE;
      // A thin band still gets a rock; it is simply a smaller one.
      const want = TILE_PX * (2.1 + rnd() * 1.9);
      // The floors are three times what they were (0.35 and 0.9 tiles): on a narrow band of sea
      // they clamped the smaller rocks down to pebbles, which read as noise rather than as rock.
      const r = full
        ? Math.max(TILE_PX * ROCK_MIN_FULL, Math.min(want, band / 2))
        : Math.max(TILE_PX * ROCK_MIN_OTHERS, Math.min(want, band * 0.8));
      plans.push({ side, horizontal, axis, inner, outer, full, r });
    }
    const largest = plans.reduce((a, b) => (b.r > a.r ? b : a), plans[0]);
    for (const p of plans) p.r *= p === largest ? ROCK_GROW_LARGEST : ROCK_GROW_OTHERS;

    for (const { side, horizontal, axis, inner, outer, full, r } of plans) {
      const sign = side % 4 < 2 ? 1 : -1;

      // Distance from the island's centre, along the chosen axis - never so close that the rock
      // would sit under the coast.
      const dist = Math.max(inner + r * 0.9, full
        // As far inside as it fits: clear of the coast, and of the board edge if it can be.
        ? (inner + r + Math.max(inner + r, outer - r)) / 2
        // Partly outside: `visible` is how much of its width is left on screen, so the centre
        // sits that far short of the edge plus the rest of its radius beyond it.
        : outer + r * (1 - 2 * (ROCK_MIN_VISIBLE + rnd() * 0.3)));

      // And a slide along the shore, so they are not all on the centre line of their side. The
      // fully-visible one is clamped so the slide cannot push it off the OTHER edge, which is
      // the easy way to lose a guarantee you only checked on one axis.
      const spread = halfView[1 - axis];
      const along = full
        ? (rnd() - 0.5) * 2 * Math.max(0, spread - r)
        : (rnd() - 0.5) * spread * 1.2;

      seaRocks.push({
        x: cx + (horizontal ? sign * dist : along),
        y: cy + (horizontal ? along : sign * dist),
        r,
        lumps: Array.from({ length: 4 }, () => ({
          dx: (rnd() - 0.5) * r * 0.9,
          dy: (rnd() - 0.5) * r * 0.7,
          r: r * (0.42 + rnd() * 0.46),
          squash: 0.72 + rnd() * 0.3,
          turn: rnd() * Math.PI,
        })),
        /* The mass of it under the water: bigger than what breaks the surface, and barely there.
         *
         * A boulder in the sea is the top of something, and the thing it is the top of is wider
         * than it is. Drawn first, at a tenth of the alpha, in the sea's own deep colour, it
         * reads as the bottom seen through a few metres of water - which is the one cue that
         * tells you the water around a rock is SHALLOW, and the reason the rock stops looking
         * like a sticker on a flat surface.
         *
         * Its own set of lumps, bigger and flatter than the ones above the surface and offset
         * further, so the base is not a scaled copy of the boulder - a silhouette that echoes
         * the shape on top of it reads as a shadow rather than as rock.
         */
        base: Array.from({ length: 5 }, () => ({
          dx: (rnd() - 0.5) * r * 1.9,
          dy: (rnd() - 0.5) * r * 1.5,
          r: r * (0.75 + rnd() * 0.85),
          squash: 0.55 + rnd() * 0.4,
          turn: rnd() * Math.PI,
        })),
        phase: rnd() * Math.PI * 2,
      });
    }
    return seaRocks;
  }

  /**
   * The shoal under every boulder: one soft dark mass, wider than the rock, below the surface.
   *
   * One radial fill per rock and the gradient is cached on the rock itself - `waterRocks()`
   * rebuilds its objects whenever the view changes, so the cache is thrown away exactly when it
   * would otherwise be stale. Squashed vertically because it is a shape seen through water from
   * slightly above, the same foreshortening everything else on this board gets.
   */
  function drawRockShoals(ox, oy) {
    for (const k of waterRocks()) {
      if (!k.shoal) {
        const g = ctx.createRadialGradient(0, 0, k.r * 0.25, 0, 0, k.r * SHOAL_SPREAD);
        // Darker than the deep sea at the middle and gone by the edge: a submerged rock has no
        // outline, it just stops being visible.
        g.addColorStop(0, 'rgba(3,14,26,0.62)');
        g.addColorStop(0.45, 'rgba(5,18,31,0.34)');
        g.addColorStop(0.75, 'rgba(6,22,36,0.14)');
        g.addColorStop(1, 'rgba(7,24,38,0)');
        k.shoal = g;
      }
      ctx.save();
      ctx.globalAlpha = SHOAL_ALPHA;
      ctx.translate(ox + k.x, oy + k.y);
      ctx.scale(1, 0.8);
      ctx.fillStyle = k.shoal;
      ctx.beginPath();
      ctx.arc(0, 0, k.r * SHOAL_SPREAD, 0, 7);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /* The island's shelf, round every boulder too.
   *
   * A rock standing in open water with deep blue right up to its face looks dropped onto the sea;
   * the island stopped looking like that when its sand carried on under the water (see
   * SHELF_TILES). The same bands in the same colours and alphas, so the two read as the same
   * seabed: three tiles of sand fading out, the mid shallows inside a tile and a half, and the
   * pale shallows hard against the rock. Breathes with the bass exactly as the island's does.
   *
   * Each band is the union of the rock's own lumps grown by that band's distance, filled as ONE
   * path - nonzero winding makes overlapping ellipses a single shape at a single alpha - so the
   * shelf follows the rock's silhouette and never stacks where two lumps meet. Fifteen fills a
   * frame for three rocks; cheaper than the cache it would need. The bands are ROCK_SHELF_BANDS,
   * declared beside SHELF_TONE.
   */
  function drawRockShelves(breathe) {
    for (const k of waterRocks()) {
      for (const [tiles, alpha, colour] of ROCK_SHELF_BANDS) {
        // Measured from the rock's edge, which sits a little inside its outermost lumps.
        const grow = tiles * TILE_PX * 0.85;
        ctx.globalAlpha = Math.min(1, alpha * breathe);
        ctx.fillStyle = colour;
        ctx.beginPath();
        for (const l of k.lumps) {
          const rx = l.r + grow, ry = l.r * l.squash + grow;
          ctx.moveTo(k.x + l.dx + rx * Math.cos(l.turn), k.y + l.dy + rx * Math.sin(l.turn));
          ctx.ellipse(k.x + l.dx, k.y + l.dy, rx, ry, l.turn, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  function paintWaterRocks(ox, oy, only = null) {
    for (const k of waterRocks()) {
      if (only && k !== only) continue;
      const x = ox + k.x, y = oy + k.y;
      ctx.save();
      // Everything below is drawn inside this one alpha, so the rock sits at the same distance
      // from the eye as the ship does.
      ctx.globalAlpha = ROCK_ALPHA;

      /* What it is the top of, under the water, before anything else.
       *
       * Two layers of the same lumps - a wide faint one and a tighter slightly darker one - in
       * the deep sea's colour rather than in stone's, because that is what a rock looks like
       * through water: not a grey rock dimmed, but the water above it going darker. Blurred where
       * the browser has a filter, since the one thing that would give it away is an edge: a
       * crisp outline reads as something floating ON the surface, and the whole point of this is
       * that it is beneath one.
       *
       * Drawn before the shadow and the boulder, so both land on top of it.
       */
      const canBlurRock = 'filter' in ctx;
      ctx.save();
      if (canBlurRock) ctx.filter = 'blur(4px)';
      for (const l of k.base) {
        ctx.globalAlpha = ROCK_ALPHA * 0.1;
        ctx.fillStyle = '#143247';
        ctx.beginPath();
        ctx.ellipse(x + l.dx, y + l.dy, l.r * 1.25, l.r * l.squash * 1.25, l.turn, 0, 7);
        ctx.fill();
      }
      for (const l of k.base) {
        ctx.globalAlpha = ROCK_ALPHA * 0.09;
        ctx.fillStyle = '#0d2335';
        ctx.beginPath();
        ctx.ellipse(x + l.dx * 0.7, y + l.dy * 0.7, l.r * 0.85, l.r * l.squash * 0.85, l.turn, 0, 7);
        ctx.fill();
      }
      if (canBlurRock) ctx.filter = 'none';
      ctx.restore();

      /* The rock's own shadow, on the water, before anything else it draws.
       *
       * Out here it reads less as shade and more as the dark of deep water beside something
       * solid - which is right either way, and it is the thing that stops the boulders looking
       * like decals laid on the surface.
       *
       * A soft gradient blob rather than a stack of hard ellipses. The old version threw one
       * black ellipse per lump at 62% of the land shadow alpha, and four overlapping hard-edged
       * ellipses on water is the one thing that reads as a hole in the sea rather than as shade
       * in it: real light on water scatters, so the edge of a shadow out here has no edge. One
       * radial fill, stretched along the light and thrown clear of the rock, does the whole job
       * for a quarter of the draws.
       */
      const sv = sunVec();
      // The light's direction as a unit vector. `sunVec` is an offset in pixels; what the
      // shading below wants is which way is away from the sun, at whatever distance it likes.
      const ux = sv.dx / SHADOW_LEN, uy = sv.dy / SHADOW_LEN;
      const shx = x + ux * (k.r * 0.55 + SHADOW_LEN), shy = y + uy * (k.r * 0.45 + SHADOW_LEN * 0.8);
      ctx.save();
      ctx.globalAlpha = SHADOW_ALPHA * 0.8;
      ctx.translate(shx, shy);
      ctx.rotate(Math.atan2(uy, ux));
      ctx.scale(1.25, 0.66);                       // long in the light's direction, flat across it
      const shade = ctx.createRadialGradient(0, 0, k.r * 0.18, 0, 0, k.r * 1.08);
      shade.addColorStop(0, 'rgba(0,0,0,0.9)');
      shade.addColorStop(0.55, 'rgba(0,0,0,0.5)');
      shade.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = shade;
      ctx.beginPath(); ctx.arc(0, 0, k.r * 1.08, 0, 7); ctx.fill();
      ctx.restore();

      // The mass itself. Every tone is mixed well down toward the deep sea, so the rock is a
      // shape you notice rather than an object that announces itself.
      const lump = (l, grow, fill, alpha) => {
        ctx.globalAlpha = ROCK_ALPHA * alpha;
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.ellipse(x + l.dx, y + l.dy, l.r * grow, l.r * l.squash * grow, l.turn, 0, 7);
        ctx.fill();
      };
      /* Under the water, then above it.
       *
       * The waterline is the ellipse the wet line below traces. Everything outside it is stone
       * under the sea: drawn first, faint and pulled toward the water's colour, so the rock's
       * full bulk is there if you look and gone if you do not. Then the same stone again, at
       * full strength but clipped to the waterline, which is the part that breaks the surface. */
      const wlx = x, wly = y + k.r * 0.16, wrx = k.r * 0.9, wry = k.r * 0.64;
      for (const l of k.lumps) lump(l, 1.04, '#1c3a4c', 0.11);        // submerged stone, sea-tinted
      for (const l of k.lumps) lump(l, 0.9, '#21323f', 0.07);         // its darker heart
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(wlx, wly, wrx, wry, 0, 0, 7);
      ctx.clip();
      // The dark side first, pushed AWAY from the sun, then the stone over most of it.
      for (const l of k.lumps) lump({ ...l, dx: l.dx + ux * l.r * 0.2, dy: l.dy + uy * l.r * 0.2 },
        1.06, '#071320', 0.6);                                        // the shaded side
      for (const l of k.lumps) lump(l, 1, '#2b3038', 0.92);           // the stone
      /* The lit layers, offset TOWARD the sun instead of always up and to the left.
       *
       * The light on a map is a hash of its name and points anywhere in a half-circle, so a
       * rock lit from the top left on a board whose shadows fall to the right was the only
       * thing out there disagreeing with the sun. Still at half strength: they were once the
       * brightest thing on open water, which is the opposite of what background is for. */
      for (const l of k.lumps) lump({ ...l, dx: l.dx - ux * l.r * 0.32, dy: l.dy - uy * l.r * 0.32 },
        0.6, '#3c424c', 0.78);                                        // the lit shoulder
      for (const l of k.lumps) lump({ ...l, dx: l.dx - ux * l.r * 0.46, dy: l.dy - uy * l.r * 0.46 },
        0.26, '#565d6a', 0.55);                                       // the dry cap, sunward

      /* Stone, not pebbles: facets, grain and a rim of light along the sunward edge.
       *
       * Four smooth ellipses with a highlight read as a heap of eggs, and no amount of tone work
       * fixes that - what makes stone look like stone is STRAIGHT lines in it. So each lump gets
       * a couple of facet creases, struck across it at a fixed angle from the lump's own hash,
       * and a scatter of grain. All of it is deterministic in the lump, so a rock is the same
       * rock every frame; none of it listens to anything.
       */
      ctx.globalAlpha = ROCK_ALPHA * 0.5;
      ctx.lineCap = 'round';
      for (let n = 0; n < k.lumps.length; n++) {
        const l = k.lumps[n];
        const lx = x + l.dx, ly = y + l.dy;
        for (let f = 0; f < 2; f++) {
          const a = l.turn + f * 1.9 + n * 0.7;
          const len = l.r * (0.5 + 0.3 * hash01(n * 31 + f));
          const off = (hash01(n * 17 + f * 5) - 0.5) * l.r * 0.5;
          const px0 = lx + Math.cos(a + 1.57) * off, py0 = ly + Math.sin(a + 1.57) * off;
          const ex = Math.cos(a) * len, ey = Math.sin(a) * len;
          /* A crease is two strokes, and that is what makes it a crease rather than a scratch:
           * the dark of the groove, and the lit lip on the sunward side of it. One line alone
           * reads as a crack drawn ON the rock; two read as the rock having a shape. */
          ctx.strokeStyle = '#141a22';
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          ctx.moveTo(px0 - ex, py0 - ey);
          ctx.lineTo(px0 + ex, py0 + ey);
          ctx.stroke();
          ctx.strokeStyle = '#5a616e';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px0 - ex - ux * 1.3, py0 - ey - uy * 1.3);
          ctx.lineTo(px0 + ex - ux * 1.3, py0 + ey - uy * 1.3);
          ctx.stroke();
        }
        // Grain: a few specks of lit stone, so the surface is not glass.
        ctx.fillStyle = '#6a717f';
        for (let s = 0; s < 3; s++) {
          const a = hash01(n * 97 + s * 13) * 6.28, d = hash01(n * 53 + s) * l.r * 0.7;
          ctx.beginPath();
          ctx.arc(lx + Math.cos(a) * d, ly + Math.sin(a) * d, 0.8, 0, 7);
          ctx.fill();
        }
      }
      ctx.restore();

      /* Where it meets the water: ONE layer, and not a line among them.
       *
       * There were four - a dashed foam collar, a second fainter collar, a bright arc on the
       * upstream face and two wake smears trailing downstream - and every one of them was a
       * STROKE. On open water a stroke is the one thing the eye will not forgive: however it is
       * dashed, phased or faded, a curve following the outline of a rock reads as a line drawn
       * round the rock. Removed completely, on request, and the sea is quieter for it.
       *
       * What is left is the wet band, which is a FILL and therefore not an outline: the stone just
       * above the waterline is dark and shiny because it is wet, and that single tone is what
       * plants the boulder IN the water rather than on top of it.
       */
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(wlx, wly, wrx, wry, 0, 0, 7);
      ctx.clip();
      ctx.globalAlpha = ROCK_ALPHA * 0.5;
      ctx.fillStyle = '#0d1a22';
      ctx.beginPath();
      ctx.ellipse(wlx, wly + wry * 0.42, wrx * 0.98, wry * 0.7, 0, 0, 7);
      ctx.fill();
      ctx.restore();

      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  /* Water rocks are scenery, not animation. Their old implementation rebuilt every gradient,
   * clip and facet on every frame, even though only the camera offset changed. Bake each rock
   * once for the current viewport and blit the small sprites during gameplay. */
  function drawWaterRocks(ox, oy) {
    const rocks = waterRocks();
    if (rockSpritesFor !== rocks) {
      rockSprites = rocks.map(k => {
        const margin = Math.ceil(k.r * 2 + SHADOW_LEN + 12);
        const sprite = document.createElement('canvas');
        sprite.width = sprite.height = margin * 2;
        const previous = ctx;
        ctx = sprite.getContext('2d');
        ctx.translate(margin - k.x, margin - k.y);
        paintWaterRocks(0, 0, k);
        ctx = previous;
        return { sprite, x: k.x - margin, y: k.y - margin };
      });
      rockSpritesFor = rocks;
    }
    for (const rock of rockSprites) ctx.drawImage(rock.sprite, ox + rock.x, oy + rock.y);
  }

  /* The island is the speaker.
   *
   * An equaliser built out of the sea itself: the coast is the spectrum, by angle round the
   * island - bass at the bottom, treble at the top, mirrored left and right - and the level
   * there lifts a soft bar of light out of the shallows.
   *
   * Three things make it read as water rather than as a meter, and all three came from it being
   * too jumpy in a real round:
   *
   *   SLOW     the listener eases each band over a quarter of a second up and most of one down,
   *            and the bars ease again here on top of that.
   *   STILL    the coast is cut into short straight runs, each run one band, and a whole run
   *            rises and falls together straight out from its wall. Nothing ever moves ALONG the
   *            coast - an earlier version interpolated between bands and the peaks slid sideways,
   *            which read as the whole shoreline flowing.
   *   FINE     each tile is split into a grid: EQ_SUB blocks outward and two across, small
   *            inset blocks rather than whole-tile slabs. More resolution, far less weight.
   *
   * Additive, dim, with a faint brighter block at the tip, and drawn under the island so a bar
   * reaching into a bay is simply covered by the land. */
  // Twice the blocks of the last pass, spread over twice the reach, each at half the light: the
  // same glow over a larger area, so it reads as a tint on the water rather than as a bar.
  /* Seven tiles of reach rather than five, at four blocks a tile.
   *
   * The whole visualiser moved outward and got stronger when the flow streaks were removed: the
   * sea around the island is now the only place anything is happening, so the thing that is
   * SUPPOSED to be happening there can afford to spread. Seven tiles puts the tip of a loud band
   * out past the shallows and into open water, which is also where there is room for it. */
  const EQ_MAX = 7;                                     // tiles of reach, at full scale
  const EQ_SUB = 4;                                     // blocks per tile, outward
  // Half of what it was again - 0.15 and a 0.3 cap - at the user's request after a real round.
  // Half again on both, with the reach: at the old alpha a bar seven tiles long faded to nothing
  // before it got there, which is a longer bar that reads as a shorter one.
  const EQ_ALPHA = 0.058, EQ_CAP_ALPHA = 0.105;
  // One band per shade, so a colour never spans two bands.
  const EQ_BANDS = 24;
  const EQ_SHADES = 24;
  const EQ_COLOURS = Array.from({ length: EQ_SHADES }, (_, k) =>
    `hsl(${(205 - k * 2.3) | 0} 55% ${(54 + k * 0.7) | 0}%)`);  // deep blue bass to aqua treble
  /* Well over half again what the standing wave asks for, at every volume. See paintCoastEq.
   *
   * This started at 1.33 - "a third more intense" - and went up with the rest of the sea when the
   * flow streaks came out. The coast is now the loudest thing in the water, which is the right
   * thing for it to be: it is the only part of the sea that is actually listening. */
  const EQ_VU_BOOST = 1.75;
  // Below this the coast is dark. Five percent on the slider is "effectively off", and a coast
  // glowing for music nobody can hear reads as a fault rather than as atmosphere.
  const EQ_MIN_VOL = 0.05;

  /* Bioluminescence.
   *
   * Cold points of light in the water, and the one place the music shows on the open sea. Each
   * is a soft pre-drawn glow (two tints, sea-green and a colder blue), drifting slowly with the
   * real current, fading in, twinkling at its own rate and fading out over two to three and a
   * half seconds. How many there are is the music: a sparse trickle that follows the top and
   * middle of the mix, and on every hat or snare a small bloom of three, staggered, in one spot
   * rather than a scatter. On a beat the ones already lit brighten together, a little.
   *
   * Subtle on purpose. The first version was bright dots that flared and vanished in under a
   * second, a dozen at a time; it read as sparks, and it fought the game for attention. */
  const GLOW_MAX = 130;
  function glowSprite(core, mid, edge) {
    const el = document.createElement('canvas');
    el.width = el.height = 32;
    const g = el.getContext('2d');
    const r = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    r.addColorStop(0, core); r.addColorStop(0.16, mid); r.addColorStop(0.48, edge);
    r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r; g.fillRect(0, 0, 32, 32);
    return el;
  }

  function spawnGlow(x, y, delay = 0) {
    if (glow.length >= GLOW_MAX) return;
    glow.push({
      x, y, age: -delay,
      span: 2 + Math.random() * 1.5,
      /* Half again the size and twice the brightness they had, and both earn it.
       *
       * At 7-13 px and a tenth of alpha these were points you noticed only once you went looking
       * - and with the flow streaks gone there is a lot of open water for them to carry. The
       * smart part is WHERE the extra brightness comes from: `peak` is scaled by how busy the top
       * end is at the moment the mote is spawned, so a quiet passage still gets the old faint
       * scatter and a loud one lights the shallows. The ceiling is deliberately below a third of
       * full - these are specks of light on dark water, and the moment they read as a particle
       * effect they stop reading as the sea. */
      size: 10 + Math.random() * 9,
      peak: 0.17 + Math.random() * 0.1 + mood.high * 0.09,
      tw: 1.4 + Math.random() * 2.2, ph: Math.random() * Math.PI * 2,     // a slow shimmer, not a flicker
      tint: Math.random() < 0.65 ? 0 : 1,
    });
  }

  /** A point of open water near the coast: one to three and a half tiles out, jittered. */
  function shallowsPoint() {
    const shore = shoreline();
    if (!shore.length) return null;
    const s = shore[(Math.random() * shore.length) | 0];
    const dx = (s.e & 1 ? 1 : 0) - (s.e & 4 ? 1 : 0), dy = (s.e & 8 ? 1 : 0) - (s.e & 2 ? 1 : 0);
    if (!dx && !dy) return null;
    const out = 1 + Math.random() * 2.5;
    return [
      (s.tx + 0.5 + dx * out + (Math.random() - 0.5) * 0.9) * TILE_PX,
      (s.ty + 0.5 + dy * out + (Math.random() - 0.5) * 0.9) * TILE_PX,
    ];
  }

  function feedGlow(dtMs) {
    if (!world.map || !soundOf) return;
    const dt = dtMs / 1000;
    // Twice the spawn rate it had, and a floor under it so there is always something lighting the
    // shallows. The bioluminescence is now carrying the part of "the sea is alive" that six
    // hundred white streaks used to carry.
    const rate = 0.8 + mood.high * 4 + mood.mid * 1.3;                         // per second
    const n = Math.floor(rate * dt) + (Math.random() < (rate * dt) % 1 ? 1 : 0);
    for (let i = 0; i < n; i++) { const p = shallowsPoint(); if (p) spawnGlow(p[0], p[1]); }
    if (sound.sparks !== lastSparks) {
      lastSparks = sound.sparks;
      const p = shallowsPoint();
      if (p) for (let i = 0; i < 2; i++) {
        spawnGlow(p[0] + (Math.random() - 0.5) * 12, p[1] + (Math.random() - 0.5) * 12, i * 0.12);
      }
    }
  }

  /* ─── jellyfish ──────────────────────────────────────────────────────────────
   *
   * One at a time, drifting across the open water, mostly too deep to make out.
   *
   * The idea is DEPTH, which is the one thing a top-down sea cannot show you. A shape that is
   * always visible is a sprite on the water; a shape you half-see, lose, and then watch rise into
   * focus is something that was down there the whole time. So almost everything about this is
   * driven by one number, `d` - how close to the surface it is - and the whole animal fades,
   * sharpens, grows and slows with it:
   *
   *   deep    four percent alpha, blurred to a smudge, a hint of blue-green and no detail at all
   *   mid     the bell resolves, the tentacles appear behind it
   *   up      full colour, a bright rim on the bell, a glow that spills onto the surface
   *
   * The motion is the other half, and it is not a sine on a line. A real jellyfish PULSES: it
   * squeezes its bell, shoots forward on the squeeze, then coasts and sinks slightly while it
   * relaxes. So the bell's squash and its speed come from the same phase - thrust on the
   * contraction, drift on the recovery - which is what makes it read as swimming rather than as
   * being dragged. On top of that it rides the real current (`flowAt`, the same field the dust
   * and the bioluminescence use), so it goes where the water goes.
   *
   * Depth itself wanders on two slow sines that do not divide into each other, so a rise is never
   * on a schedule: it comes up, hangs near the surface for a few seconds, and sinks away again.
   *
   * ─── and it listens, but only in the ways a jellyfish could ───
   *
   * Clearly reactive, never a meter. Every listener is something the animal already does on its
   * own, made legible:
   *
   *   the beat    pulls one squeeze forward, and every kick fires a ring of light off the bell's
   *               margin that spreads and fades over half a second. The squeeze alone was too
   *               subtle to read as "in time" from across the board; a ring leaving the animal
   *               on the kick is unmistakable, and it is still what a bioluminescent bell does
   *               when it is disturbed.
   *   the bass    lifts it, swells the bell a little, and lets the tentacles out. A swell brings
   *               it up out of the dark and trailing longer, so a loud passage looks like the
   *               animal opening up rather than like it being turned up.
   *   the top end runs a chase of light round the beads on the bell's margin. The hats are
   *               already lighting the bioluminescence it drifts among, so this is the same light
   *               reaching the same animal - and a chase reads as rhythm where a flat brighten
   *               read as nothing.
   *   the level   warms the four gonads in the middle of the bell, slowly. Quiet passages leave
   *               it a pale ghost; a full mix has a lit heart.
   *
   * What the music may NOT touch: its heading, its speed, or its depth DIRECTLY. Steering it on a
   * beat would make it dart about like a cursor, and a depth driven by the mix would have it
   * bobbing at the surface for a whole loud passage, which is the annoying version of this - a
   * thing that will not settle. Every term below is small, and all of them are eased: the
   * difference between an animal that is listening and a visualiser shaped like an animal.
   *
   * Three at most. It was one, on the grounds that two would be a feature; at one the sea was
   * usually empty, and three spread over different sides and depths still reads as a few animals
   * passing rather than as an aquarium. Each is independent - own clocks, own depth, own side.
   */
  const JELLY_SPAN_S = 54;            // how long one crossing takes, roughly
  const JELLY_MAX = 3;
  const JELLY_RING_S = 0.55;          // how long a beat ring takes to spread and fade
  const JELLY_BEADS = 12;             // lights round the bell's margin, for the top end
  const jellies = [];
  let jellyBeatWas = 0;

  function spawnJelly() {
    const [lx, ly, lw, lh] = landBounds();
    const pad = SEA_MARGIN_TILES * TILE_PX * 1.5;
    // Across the long axis of the board, entering and leaving off-screen, well clear of the
    // island - it is an open-water animal and it must never appear to swim over the sand.
    const horizontal = lw >= lh;
    const from = Math.random() < 0.5 ? -1 : 1;
    // The side of the island with fewer jellyfish on it, so three do not queue up in one lane.
    const above = jellies.filter(q => q.side < 0).length, below = jellies.length - above;
    const side = above === below ? (Math.random() < 0.5 ? -1 : 1) : above < below ? -1 : 1;
    const span = (horizontal ? (lw + 4) * TILE_PX : (lh + 4) * TILE_PX) + pad * 2;
    // Closer to the coast than it was (0.7-1.3 of the margin): far enough out that it never
    // appears to swim over the sand, near enough that its path is inside the visible sea rather
    // than hugging the edge of the board where half of it is off screen.
    const offset = side * ((horizontal ? lh : lw) * TILE_PX * 0.5 + pad * (0.45 + Math.random() * 0.45));
    const midx = (lx + lw / 2) * TILE_PX, midy = (ly + lh / 2) * TILE_PX;
    jellies.push({
      side,
      // Position and heading in world pixels.
      x: horizontal ? midx - from * span / 2 : midx + offset,
      y: horizontal ? midy + offset : midy - from * span / 2,
      vx: 0, vy: 0,
      dir: horizontal ? (from > 0 ? 0 : Math.PI) : (from > 0 ? Math.PI / 2 : -Math.PI / 2),
      age: 0,
      span: JELLY_SPAN_S * (0.8 + Math.random() * 0.5),
      // The pulse clock and the two depth clocks, each with their own phase so successive
      // jellyfish are not the same animal again.
      pulse: Math.random() * Math.PI * 2,
      ph1: Math.random() * Math.PI * 2,
      ph2: Math.random() * Math.PI * 2,
      // The eased music terms. See jellyDepth and the beat nudge in drawJelly.
      lift: 0,
      beat: 0,
      ring: 0,                        // 1 on a kick, falling to 0 over JELLY_RING_S
      heart: 0,                       // the level, eased slowly; lights the gonads
      size: 11 + Math.random() * 7,
      tint: Math.random() < 0.6 ? 0 : 1,
    });
  }

  /** 0 deep, 1 at the surface. Two slow sines, so a rise is never on a schedule. */
  function jellyDepth(j) {
    const a = Math.sin(j.age * 0.19 + j.ph1);
    const b = Math.sin(j.age * 0.071 + j.ph2);
    /* Biased SHALLOW now, where it used to be biased deep.
     *
     * 0.34 of bias meant the two sines spent most of their swing below the threshold where
     * anything is drawn at all, so even a jellyfish that was present was usually invisible -
     * three hundred percent more of them would have been three hundred percent more of nothing.
     * At 0.62 it is in sight for most of a crossing and still spends real time sinking away,
     * which is the part that makes it read as an animal with somewhere else to be.
     */
    const raw = (a * 0.6 + b * 0.4) * 0.42 + 0.62;
    /* The bass lifts it, gently and with a long memory.
     *
     * `j.lift` chases the bass rather than following it - a quarter of a second up and most of
     * two seconds down - so a kick does not yank the animal upward and a loud passage raises it
     * smoothly and lets it settle just as smoothly. A fifth of the depth range at the very most,
     * which is enough to see and not enough to override where it was going.
     */
    return Math.max(0, Math.min(1, raw + j.lift * 0.2));
  }

  function drawJelly(ox, oy, dtMs) {
    const dt = dtMs / 1000;
    /* Three times the arrivals as well as three times the room: a mean gap of just over a second
     * while there is space, so the sea fills to three soon after a round starts and a departure
     * is replaced within a couple of seconds rather than leaving a hole for most of a minute. */
    if (jellies.length < JELLY_MAX && Math.random() < dt / (3.5 / 3)) spawnJelly();
    /* A kick is a RISE in the beat envelope, not a level of it - a level would fire every frame
     * the envelope sat above the line. One onset, shared, so every jellyfish rings on the same
     * kick and the sea answers the music as one thing. */
    const kick = mood.beat - jellyBeatWas > 0.22 && mood.beat > 0.4;
    jellyBeatWas = mood.beat;
    for (let i = jellies.length - 1; i >= 0; i--) {
      const j = jellies[i];
      j.age += dt;
      if (j.age > j.span) { jellies.splice(i, 1); continue; }
      drawOneJelly(j, ox, oy, dtMs, kick);
    }
  }

  function drawOneJelly(j, ox, oy, dtMs, kick) {
    const dt = dtMs / 1000;
    // The eased listeners. Fast up, slow down, like everything else in the sea.
    const rise = 1 - Math.exp(-dtMs / 250), fall = 1 - Math.exp(-dtMs / 1800);
    const bass = mood.bass;
    j.lift += (bass - j.lift) * (bass > j.lift ? rise : fall);
    j.beat += (mood.beat - j.beat) * (mood.beat > j.beat ? (1 - Math.exp(-dtMs / 60)) : fall);
    j.heart += (mood.level - j.heart) * (1 - Math.exp(-dtMs / 900));
    j.ring = kick ? 1 : Math.max(0, j.ring - dt / JELLY_RING_S);

    /* The pulse. One cycle is a squeeze and a recovery, and the recovery is the longer half.
     *
     * `squeeze` is 0..1 over the contraction and 0 while it coasts, which is what both the thrust
     * and the bell's shape are taken from - one number, so they cannot disagree. The period
     * lengthens as it rises, because a jellyfish near the surface is not working as hard.
     */
    const d = jellyDepth(j);
    const period = 1.5 + d * 0.5;
    /* The beat pulls the squeeze forward rather than setting the rate.
     *
     * Adding a fraction of a cycle on each kick means the bell lands its contraction with the
     * music while its own rhythm still governs how often it contracts - so it swims in time
     * through a four-on-the-floor and keeps swimming, at its own pace, through a quiet passage.
     * Capped at a third of a cycle a second, or a busy mix would spin it.
     */
    j.pulse += dt / period + Math.min(0.33, j.beat * 0.5) * dt;
    const phase = j.pulse % 1;
    const squeeze = phase < 0.32 ? Math.sin((phase / 0.32) * Math.PI) : 0;

    // Thrust on the squeeze, drag always, and the current underneath all of it.
    flowAt(j.x, j.y, seaT, flow);
    const thrust = squeeze * (26 + d * 16);
    j.vx += (Math.cos(j.dir) * thrust + flow.x * 0.5 - j.vx * 2.4) * dt;
    j.vy += (Math.sin(j.dir) * thrust + flow.y * 0.5 - j.vy * 2.4) * dt;
    j.x += j.vx * dt;
    j.y += j.vy * dt;

    /* Brightness: depth, and then the top end on top of it.
     *
     * The hats are already lighting the bioluminescence this thing drifts among, so the same
     * light reaching the same animal is the one visual link that needs no explaining. Added
     * rather than multiplied, so a deep jellyfish in a bright passage glows faintly instead of
     * staying invisible - which is exactly the moment you want to notice there is something
     * down there.
     */
    // A kick lends it light too, so even a deep one flickers into view on the beat.
    const alpha = 0.05 + d * d * 0.5 + mood.high * 0.1 * (0.3 + d) + j.ring * 0.1 * (0.4 + d);
    if (alpha < 0.055) return;

    // And it swells with the bass, which is the bell doing what a bell does - a tenth at most,
    // enough to see the animal breathe with the room.
    const r = j.size * (0.82 + d * 0.3) * (1 + j.lift * 0.1);
    // The bell: squashed on the squeeze, taller as it relaxes. Real pulsing, from `squeeze`.
    const bell = 1 - squeeze * 0.32;
    const x = ox + j.x, y = oy + j.y;

    const warm = j.tint === 0;
    const core = warm ? '226,255,246' : '214,236,255';
    const edge = warm ? '90,235,205' : '110,190,255';

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.translate(x, y);
    ctx.rotate(j.dir + Math.PI / 2);          // the bell faces the way it is going

    /* The halo first, and it is most of the illusion when the animal is deep: a wide soft
     * gradient with no edge to it, because an edge is what tells you how far away something is
     * and the whole point of a deep one is that you cannot tell. The bass widens it. */
    const reach = r * (3.4 - d * 1.2) * (1 + j.lift * 0.25);
    const halo = ctx.createRadialGradient(0, 0, 0, 0, 0, reach);
    halo.addColorStop(0, `rgba(${edge},${(alpha * 0.5).toFixed(3)})`);
    halo.addColorStop(0.45, `rgba(${edge},${(alpha * 0.16).toFixed(3)})`);
    halo.addColorStop(1, `rgba(${edge},0)`);
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, reach, 0, 7);
    ctx.fill();

    /* The beat ring: light leaving the margin on the kick, spreading to two and a half bells
     * and fading as it goes. Eased out, so it leaves fast and lingers - a ring that grows at a
     * constant rate reads as a radar sweep, not as something the animal did. */
    if (j.ring > 0) {
      const t = 1 - j.ring, out = 1 - (1 - t) * (1 - t);
      const k = 1.05 + out * 1.5;
      ctx.strokeStyle = `rgba(${core},${Math.min(1, alpha * 1.6 * j.ring * j.ring).toFixed(3)})`;
      ctx.lineWidth = 0.8 + 2.2 * j.ring;
      ctx.beginPath();
      ctx.ellipse(0, 0, r * k, r * bell * k, 0, 0, 7);
      ctx.stroke();
    }

    /* The tentacles, behind the bell, and they LAG it - each one trails by a little more than the
     * one in front, so the whole train whips a beat after the squeeze. A jellyfish whose
     * tentacles move with its bell looks like a drawing of one.
     *
     * Eight fine ones from the margin, each a two-bend wave rather than one arc, so the train
     * ripples along its length; and they let out with the bass. */
    if (d > 0.18) {
      ctx.globalAlpha = Math.min(1, (d - 0.18) * 1.6);
      ctx.strokeStyle = `rgba(${core},${(alpha * 0.5).toFixed(3)})`;
      ctx.lineCap = 'round';
      ctx.lineWidth = 0.9;
      const tau = Math.PI * 2;
      for (let i = 0; i < 8; i++) {
        const u = i / 7 - 0.5;                                  // -0.5..0.5 across the margin
        const sx = u * r * 1.8, sy = Math.sqrt(Math.max(0, 1 - u * u * 4)) * r * 0.55 * bell;
        const len = r * (1.9 + 0.5 * Math.sin(j.pulse * 1.7 + i)) * (1 + j.lift * 0.45);
        const w1 = Math.sin((j.pulse - 0.1 - i * 0.04) * tau) * r * 0.32;
        const w2 = Math.sin((j.pulse - 0.32 - i * 0.04) * tau) * r * 0.5;
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.bezierCurveTo(sx + w1 * 0.5, sy + len * 0.35, sx * 0.8 + w2, sy + len * 0.7,
          sx * 0.7 + w2 * 1.3, sy + len);
        ctx.stroke();
      }
      // Four thicker, frilled oral arms inside them, which is what makes the silhouette read as
      // an animal rather than as a jellyfish emoji: a broad translucent stroke with a brighter
      // thread down its middle.
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0
          ? `rgba(${edge},${(alpha * 0.45).toFixed(3)})`
          : `rgba(${core},${(alpha * 0.3).toFixed(3)})`;
        ctx.lineWidth = pass === 0 ? 3.2 : 1;
        for (let i = 0; i < 4; i++) {
          const off = (i - 1.5) * r * 0.2;
          const wob = Math.sin(j.pulse * tau - 0.5 + i) * r * 0.18;
          const reachArm = r * (1.2 + j.lift * 0.25);
          ctx.beginPath();
          ctx.moveTo(off * 0.6, r * 0.2 * bell);
          ctx.quadraticCurveTo(off + wob, r * 0.8, off + wob * 1.6, reachArm);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }

    // The bell itself: a filled dome, lit off-centre toward the front, scaled by the squeeze.
    const body = ctx.createRadialGradient(0, -r * 0.25 * bell, r * 0.08, 0, 0, r * 1.05);
    body.addColorStop(0, `rgba(${core},${(alpha * 0.75).toFixed(3)})`);
    body.addColorStop(0.55, `rgba(${edge},${(alpha * 0.42).toFixed(3)})`);
    body.addColorStop(0.85, `rgba(${edge},${(alpha * 0.3).toFixed(3)})`);
    body.addColorStop(1, `rgba(${edge},0)`);
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(0, 0, r, r * bell, 0, 0, 7);
    ctx.fill();

    if (d > 0.3) {
      const near = Math.min(1, (d - 0.3) * 1.8);              // detail resolves as it rises
      /* Eight radial canals, centre to margin. Faint, and the thing that turns a glowing disc
       * into a bell - real moon jellies are ruled with them. */
      ctx.strokeStyle = `rgba(${core},${(alpha * 0.22 * near).toFixed(3)})`;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
        ctx.moveTo(Math.cos(a) * r * 0.2, Math.sin(a) * r * 0.2 * bell);
        ctx.lineTo(Math.cos(a) * r * 0.9, Math.sin(a) * r * 0.9 * bell);
      }
      ctx.stroke();

      /* The four gonads: the horseshoes in the middle of a moon jelly, and its heart here. Pale
       * on a quiet mix, lit pink-violet as the level comes up, slowly - this is the one part
       * of the animal that tracks the whole track rather than the beat. */
      // Kept well under the bell's own light: everything here is additive, and a heart as bright
      // as the dome fuses the middle of the animal into one white blot.
      const heart = 0.12 + j.heart * 0.5 + j.ring * 0.15;
      ctx.strokeStyle = `rgba(255,186,232,${Math.min(1, alpha * heart * near).toFixed(3)})`;
      ctx.lineWidth = 1.5;
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        const gx = Math.cos(a) * r * 0.3, gy = Math.sin(a) * r * 0.3 * bell;
        ctx.beginPath();
        ctx.arc(gx, gy, r * 0.17, a + 0.9, a + Math.PI * 2 - 0.9);
        ctx.stroke();
      }

      /* The margin, frilled: sixteen scallops, rippling round with the pulse, so the edge of the
       * bell is a living fringe rather than a drawn outline. */
      ctx.strokeStyle = `rgba(${core},${(alpha * (0.25 + d * 0.5) * near).toFixed(3)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let s = 0; s <= 64; s++) {
        const a = (s / 64) * Math.PI * 2;
        const f = 0.96 + 0.035 * Math.sin(a * 16 + j.pulse * Math.PI * 2);
        const px = Math.cos(a) * r * f, py = Math.sin(a) * r * bell * f;
        if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();

      /* The beads: lights round the margin that the top end chases round the bell. Each one is
       * dim on its own; the hats run a bright crest round the ring, so a busy top end reads as
       * a spinning glitter and a quiet one leaves the beads glowing faintly where they are. */
      const sparkle = mood.high;
      for (let i = 0; i < JELLY_BEADS; i++) {
        const a = (i / JELLY_BEADS) * Math.PI * 2;
        const crest = 0.5 + 0.5 * Math.sin(seaT * 8 - a * 2);
        const b = 0.2 + sparkle * crest * crest * 1.6;
        ctx.fillStyle = `rgba(${core},${Math.min(1, alpha * b * near).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * r * 0.97, Math.sin(a) * r * bell * 0.97, 0.8 + sparkle * crest, 0, 7);
        ctx.fill();
      }

      // A glint of sky on the front of the dome: the bell is wet and convex, and this says so.
      ctx.fillStyle = `rgba(255,255,255,${(alpha * 0.35 * near).toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(-r * 0.28, -r * 0.42 * bell, r * 0.22, r * 0.1 * bell, -0.5, 0, 7);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  function drawGlow(dtMs) {
    if (!glow.length) return;
    glowSprites ??= [
      glowSprite('rgba(228,255,247,1)', 'rgba(120,240,214,0.5)', 'rgba(40,170,160,0.1)'),
      glowSprite('rgba(224,246,255,1)', 'rgba(120,205,250,0.45)', 'rgba(40,120,200,0.1)'),
    ];
    const dt = dtMs / 1000;
    const lift = 1 + mood.beat * 0.2;
    const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    ctx.globalCompositeOperation = 'lighter';
    for (let i = glow.length - 1; i >= 0; i--) {
      const g = glow[i];
      g.age += dt;
      if (g.age < 0) continue;
      const t = g.age / g.span;
      if (t >= 1) { glow.splice(i, 1); continue; }
      // Carried by the real current, slowly - it is in the water, not on the screen.
      flowAt(g.x, g.y, seaT, flow);
      g.x += flow.x * 0.3 * dt;
      g.y += flow.y * 0.3 * dt;
      const a = g.peak * smooth(0, 0.22, t) * (1 - smooth(0.5, 1, t))
        * (0.82 + 0.18 * Math.sin(seaT * g.tw + g.ph)) * lift;
      if (a < 0.01) continue;
      ctx.globalAlpha = Math.min(1, a);
      ctx.drawImage(glowSprites[g.tint], g.x - g.size / 2, g.y - g.size / 2, g.size, g.size);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /**
   * The coast, cut into strips - two per sea-facing tile edge, each half a tile wide - and the
   * strips grouped into RUNS: up to EQ_RUN tiles of one straight wall, facing one way. A whole
   * run takes one band and rises and falls as one, straight out from its wall.
   *
   * Runs, not per-strip heights, because heights read between neighbouring bands made the peaks
   * slide sideways along the shore, and the coast looked like it was flowing. Now nothing moves
   * along the coast at all: every bar only grows and shrinks perpendicular to its wall.
   */
  /* Shorter runs: three tiles of coast rather than four.
   *
   * The run is the unit that rises and falls as one, so it sets how finely the spectrum is spread
   * around the island. Shorter runs mean more of them, which means more of the twenty-four bands
   * are visible at once and neighbouring stretches of coast differ more - a better SPREAD, which
   * is the thing that makes it read as a spectrum rather than as a coastline breathing. */
  const EQ_RUN = 3;
  function coastEq() {
    if (eqFor === world.map && eqCoast.length) return eqCoast;
    eqFor = world.map;
    eqCoast = [];
    const S = TILE_PX, step = S / EQ_SUB, half = S / 2;
    const [lx, ly, lw, lh] = landBounds();
    const cx = lx + lw / 2, cy = ly + lh / 2;
    const walls = new Map();          // "dx,dy,line" -> tiles along that line facing that way
    for (const s of shoreline()) {
      for (const [bit, dx, dy] of [[1, 1, 0], [4, -1, 0], [2, 0, -1], [8, 0, 1]]) {
        if (!(s.e & bit)) continue;
        const key = `${dx},${dy},${dx ? s.tx : s.ty}`;
        if (!walls.has(key)) walls.set(key, []);
        walls.get(key).push(s);
      }
    }
    for (const [key, tiles] of walls) {
      const [dx, dy] = key.split(',').map(Number);
      const along = s => (dx ? s.ty : s.tx);
      tiles.sort((a, b) => along(a) - along(b));
      // Contiguous runs along the wall, cut at EQ_RUN tiles.
      let run = [];
      const flush = () => {
        if (!run.length) return;
        const mx = run.reduce((t, s) => t + s.tx, 0) / run.length + 0.5 + dx * 0.5;
        const my = run.reduce((t, s) => t + s.ty, 0) / run.length + 0.5 + dy * 0.5;
        const pos = Math.abs(Math.atan2(mx - cx, my - cy)) / Math.PI;   // 0 below, 1 above
        for (const s of run) {
          for (let h = 0; h < 2; h++) {
            // The half of the edge at a rounded corner has had its rock stepped back by a quarter
            // tile (see COAST_STEPS), so the bar starts there instead of out in the water.
            const side = dx ? (h ? 8 : 2) : (h ? 1 : 4);
            const wall = dx > 0 ? 1 : dx < 0 ? 4 : dy < 0 ? 2 : 8;
            const back = (s.e & side) && (s.e & wall) ? COAST_Q : 0;
            eqCoast.push({
              x: (dx > 0 ? (s.tx + 1) * S : dx < 0 ? s.tx * S - step : s.tx * S + h * half) - dx * back,
              y: (dy > 0 ? (s.ty + 1) * S : dy < 0 ? s.ty * S - step : s.ty * S + h * half) - dy * back,
              sx: dx * step, sy: dy * step,
              w: dx ? step : half, h: dy ? step : half,
              pos, shade: Math.min(EQ_SHADES - 1, (pos * EQ_SHADES) | 0),
            });
          }
        }
        run = [];
      };
      for (const s of tiles) {
        if (run.length && (along(s) !== along(run[run.length - 1]) + 1 || run.length >= EQ_RUN)) flush();
        run.push(s);
      }
      flush();
    }
    eqCoast.sort((a, b) => a.shade - b.shade);         // one fillStyle change per shade
    return eqCoast;
  }

  /* The coast glows, and it has STOPPED LISTENING.
   *
   * The picture is the one that worked - the island as a spectrum by angle, quarter-tile blocks
   * stepping out of the shallows, deep blue at the bass end running to aqua at the treble end.
   * What has gone is what was driving it.
   *
   * It was the loudest reactive thing on the board and it was in the wrong place: the coast
   * wraps the entire playfield, so a visualiser living there is one you cannot look away from
   * while you are trying to play. The music moves three quieter things instead, all at the edge
   * of attention - the mascot's bob, the rings round the boat and the rocks, and the vignette.
   *
   * So this is a standing wave now. Three sines per band on periods that do not divide into
   * each other, so the pattern never visibly repeats, plus a slow travelling term that walks the
   * whole shape round the island. Deterministic, allocation-free, three sin() per band on
   * twenty-four bands - and it breathes at the same gentle rate whether anything is playing or
   * not, which is what a coastline should do.
   */
  /* Painted into its own layer, a dozen times a second, and blitted every frame.
   *
   * It is the costliest thing in the sea - a fillRect per block per strip of coast, a few
   * thousand a frame - and it moves on periods of tens of seconds, so repainting it sixty times a
   * second redrew the same picture fifty-odd times. At twelve the motion is indistinguishable.
   * World-pixel resolution, because these are blocks of glow at four percent alpha and nobody
   * can see their edges soften when the board is zoomed. */
  const EQ_REPAINT_MS = 83;
  const EQ_PAD = EQ_MAX + 1;
  let eqLayer = null, eqLayerCtx = null, eqLayerFor = null, eqAge = Infinity;

  function drawCoastEq(dtMs) {
    if (eqLayerFor !== world.map) {
      eqLayer = document.createElement('canvas');
      eqLayer.width = (world.map.w + EQ_PAD * 2) * TILE_PX;
      eqLayer.height = (world.map.h + EQ_PAD * 2) * TILE_PX;
      eqLayerCtx = eqLayer.getContext('2d');
      eqLayerFor = world.map;
      eqAge = Infinity;
    }
    eqAge += dtMs;
    if (eqAge >= EQ_REPAINT_MS) {
      paintCoastEq(Math.min(eqAge, 250));
      eqAge = 0;
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 1;
    ctx.drawImage(eqLayer, -EQ_PAD * TILE_PX, -EQ_PAD * TILE_PX);
    ctx.globalCompositeOperation = 'source-over';
  }

  function paintCoastEq(dtMs) {
    const ctx = eqLayerCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, eqLayer.width, eqLayer.height);
    ctx.translate(EQ_PAD * TILE_PX, EQ_PAD * TILE_PX);
    const n = EQ_BANDS;
    if (eqLen.length !== n) { eqLen = new Float32Array(n); eqBlur = new Float32Array(n); }
    eqT += dtMs / 1000;
    /* On or off first, then how big.
     *
     * OFF below EQ_MIN_VOL. The coast lighting up for music nobody can hear is the one state that
     * reads as a bug rather than as weather, and the analyser cannot tell you about it: it is
     * tapped BEFORE the volume fader, so a muted track and a loud one look identical to it. The
     * volume comes from the caller of setSound for exactly this. The layer is already cleared
     * above, so returning here leaves the coast dark.
     *
     * Then the size. Half the height is a floor and the other half is the music: nothing playing
     * is half height, a loud mix is full height, and it never drops below half whatever the mix
     * does - the standing wave is scenery, and scenery should not stop when the track does.
     * EQ_VU_BOOST lifts the whole range by a third, volume-independent, because at the old
     * amplitude the bars were lost in the shallows they rise out of.
     */
    if ((sound.vol ?? 0) < EQ_MIN_VOL) return;
    const loud = (0.5 + 0.5 * Math.max(0, Math.min(1, mood.level))) * EQ_VU_BOOST;
    for (let b = 0; b < n; b++) {
      const p = b / n;
      const w = Math.sin(eqT * 0.21 + p * 6.1)
        + Math.sin(eqT * 0.13 - p * 9.7) * 0.7
        + Math.sin(eqT * 0.072 + p * 3.3) * 0.5;
      eqLen[b] = Math.max(0, w / 2.2 + 0.52) * EQ_MAX * loud;
    }
    // One gentle blur across neighbouring bands, so no band stands up on its own like a post.
    let prev = eqLen[0];
    for (let b = 0; b < n; b++) {
      const cur = eqLen[b], next = eqLen[Math.min(n - 1, b + 1)];
      eqBlur[b] = prev * 0.25 + cur * 0.5 + next * 0.25;
      prev = cur;
    }
    let any = false;
    for (let b = 0; b < n; b++) if (eqBlur[b] > 0.04) { any = true; break; }
    if (!any) return;

    ctx.globalCompositeOperation = 'lighter';
    let shade = -1;
    const deepest = EQ_MAX * EQ_SUB;
    for (const c of coastEq()) {
      // The run's own band - one height for the whole run, so nothing slides along the coast.
      const L = eqBlur[Math.min(n - 1, Math.round(c.pos * (n - 1)))] * EQ_SUB;   // in blocks
      if (L < 0.15) continue;
      if (c.shade !== shade) { shade = c.shade; ctx.fillStyle = EQ_COLOURS[shade]; }
      const blocks = Math.ceil(L);
      for (let i = 0; i < blocks; i++) {
        const frac = Math.min(1, L - i);
        const x = c.x + c.sx * i, y = c.y + c.sy * i;
        ctx.globalAlpha = EQ_ALPHA * frac * (1 - i / (deepest + 3));
        ctx.fillRect(x + 1, y + 1, c.w - 2, c.h - 2);
        if (i === blocks - 1) {
          // The tip: one faintly brighter block where the bar ends.
          ctx.globalAlpha = EQ_CAP_ALPHA * frac;
          ctx.fillRect(x + 1, y + 1, c.w - 2, c.h - 2);
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  /* The shallows: two bands of paler water stepping away from the coast.
   *
   * They used to be filled tile by tile every frame - a fillRect per sea-facing edge per band,
   * several hundred of them - for a shape that only changes when the map does. Now they are
   * painted once into a layer the size of the map plus its margin and blitted. The layer is
   * baked SHALLOWS_HEADROOM brighter than drawn at rest, so the bass can lift it by drawing it at
   * a higher alpha; globalAlpha can only ever dim. */
  const SHALLOWS_PAD = 3;
  const SHALLOWS_HEADROOM = 1.15;
  /* The shelf: the island's sand carrying on under the water.
   *
   * An island does not stop at the waterline, it slopes - and a board where the land ends in a
   * hard edge against deep blue reads as a cutout on a background. Three tiles of it, in the same
   * quarter-tile steps the coast is cut in, so it follows every bay and headland and never shows
   * a square corner. SEA_MARGIN_TILES is three to keep the whole of it on screen.
   *
   * The tone is a warm sand, two shades down from the beach itself because it is being seen
   * through water, and it is painted at a sixth of an alpha at most: what the eye reads is not
   * the colour, it is that the water gets warmer as it gets shallower. */
  const SHELF_TILES = 3;
  const SHELF_TONE = '#7d6843';
  // The same steps again round each sea boulder: [tiles out, alpha, colour]. See drawRockShelves.
  const ROCK_SHELF_BANDS = [
    [3, 0.07, SHELF_TONE],
    [2.2, 0.1, SHELF_TONE],
    [1.6, 0.17, SHELF_TONE],
    [1.6, 0.16, PALETTE.seaMid],
    [1, 0.42, PALETTE.seaLight],
  ];
  let shallowsCanvas = null, shallowsFor = null;
  function shallowsLayer() {
    if (shallowsFor === world.map && shallowsCanvas) return shallowsCanvas;
    const map = world.map, P = SHALLOWS_PAD;
    const el = document.createElement('canvas');
    el.width = (map.w + P * 2) * TILE_PX;
    el.height = (map.h + P * 2) * TILE_PX;
    const c = el.getContext('2d');
    c.translate(P * TILE_PX, P * TILE_PX);
    /* By distance to the nearest land, measured on the quarter-tile coast mask (see coastMask) -
     * so the bands follow the rounded rock in the same quarter-tile steps instead of squaring
     * off round it. Within one tile of land is the near band, within two the far band, and each
     * cell is painted exactly once.
     *
     * Distance is straight-line, cell centre to cell centre, which is what rounds the bands
     * round an outside corner. It used to be counted in whole tiles including diagonals; before
     * that it was painted outward from each sea-facing edge, which left a dark square notched out
     * of every outside corner and gave inside corners two coats. */
    const Q = 4, mask = coastMask(), MW = map.w * Q, MH = map.h * Q;
    const land = (x, y) => x >= 0 && y >= 0 && x < MW && y < MH && mask[y * MW + x] === 1;
    const R = SHELF_TILES * Q;
    const offsets = [];
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 <= R * R) offsets.push([dx, dy, d2]);
      }
    }
    offsets.sort((a, b) => a[2] - b[2]);                 // nearest first: stop at the first land
    const q = COAST_Q;
    // Runs per band: x, y, length, in quarter-tile cells. See the band assignment below.
    const near = [], far = [], shelfIn = [], shelfOut = [];
    const BANDS = [near, far, shelfIn, shelfOut];
    for (let y = -P * Q; y < MH + P * Q; y++) {
      let run = null;
      for (let x = -P * Q; x <= MW + P * Q; x++) {
        /* Four steps out, in quarter-tile cells.
         *
         * 1 and 2 are the shallows as they always were. 3 and 4 are the SHELF: the island's own
         * sand carrying on under the water and petering out, which is what a real island does -
         * the land does not stop at the waterline, it slopes. Four thin steps of it fading out
         * reads as depth; one wide band of sand reads as a beach towel.
         */
        let band = 0;
        if (x < MW + P * Q && !land(x, y)) {
          for (const [dx, dy, d2] of offsets) {
            if (!land(x + dx, y + dy)) continue;
            band = d2 <= Q * Q ? 1
              : d2 <= (1.6 * Q) * (1.6 * Q) ? 2
                : d2 <= (2.2 * Q) * (2.2 * Q) ? 3 : 4;
            break;
          }
        }
        if (run && run.band === band) { run.n++; continue; }
        if (run && run.band) BANDS[run.band - 1].push(run.x, y, run.n);
        run = { band, x, n: 1 };
      }
    }
    const paint = (runs, alpha, colour) => {
      c.globalAlpha = Math.min(1, alpha * SHALLOWS_HEADROOM);
      c.fillStyle = colour;
      for (let i = 0; i < runs.length; i += 3) c.fillRect(runs[i] * q, runs[i + 1] * q, runs[i + 2] * q, q);
    };
    /* Painted from the outside in, so every band sits on the one beyond it.
     *
     * The shelf is the island's own sand (PALETTE.floor's warm cousin - `sand`) under the water,
     * at a fifth and a tenth of its strength: barely there, and that is the point. What the eye
     * reads is not the colour, it is that the water gets warmer as it gets shallower, in the same
     * quarter-tile steps the rock is cut in - so the shelf follows every bay and headland exactly
     * as the coast does and never shows a square corner.
     */
    paint([...shelfOut], 0.07, SHELF_TONE);        // the last of the sand, almost gone
    paint([...shelfIn, ...shelfOut], 0.1, SHELF_TONE);
    paint([...near, ...far, ...shelfIn], 0.17, SHELF_TONE);
    // The shallows themselves, over the top of it, exactly as they were.
    paint([...near, ...far], 0.16, PALETTE.seaMid);
    paint(near, 0.42, PALETTE.seaLight);
    shallowsCanvas = el; shallowsFor = map;
    return el;
  }

  /* The island's own shadow, thrown onto the sea.
   *
   * Every block on the island casts one and so do the ship and the rocks out in the water, but
   * the island itself sat on the sea as if lit from directly overhead - the one solid thing on
   * the board with no shadow, and the biggest. The coast is a cliff, taller than a crate, so its
   * shadow is longer than theirs: a core at about one and a quarter of a block's reach and a
   * soft penumbra beyond it, both in the same sun direction as everything else.
   *
   * Baked per map - the coast never changes and the sun is fixed per map - blurred once at bake
   * time, and blitted under everything that floats. The land is drawn over it afterwards, so only
   * the part that falls on open water is ever seen. Lighter than a shadow on sand, because water
   * scatters light and a hard dark band on it reads as a hole. */
  const ISLAND_SHADOW_PAD = 3;
  let islandShadow = null, islandShadowFor = null;
  function islandShadowLayer() {
    if (islandShadowFor === world.map && islandShadow) return islandShadow;
    const map = world.map, P = ISLAND_SHADOW_PAD, S = TILE_PX;
    const el = document.createElement('canvas');
    el.width = (map.w + P * 2) * S;
    el.height = (map.h + P * 2) * S;
    const c = el.getContext('2d');
    c.translate(P * S, P * S);
    const { dx, dy } = sunVec();
    const land = (reach, alpha, blur) => {
      c.save();
      c.filter = `blur(${blur}px)`;
      c.globalAlpha = alpha;
      c.fillStyle = '#000';
      c.beginPath();
      for (let ty = 0; ty < map.h; ty++) {
        for (let tx = 0; tx < map.w; tx++) {
          if (cellType(map.cells[ty * map.w + tx]) === BLOCK.WATER) continue;
          c.roundRect(tx * S + dx * reach, ty * S + dy * reach, S, S, 6);
        }
      }
      c.fill();
      c.restore();
    };
    land(2.2, 0.14, 9);       // the penumbra, long and soft
    land(1.25, 0.28, 3);      // the core, close in under the cliff
    islandShadow = el; islandShadowFor = map;
    return el;
  }

  function drawSea(vw, vh, ox, oy, dtMs) {
    if (!seaNear) return;
    seaT += dtMs / 1000;
    // The music's clock and push. See `sound` at the top of the renderer.
    // The surface texture drifts a touch faster when the music is busy. A touch.
    flowT += (dtMs / 1000) * (1 + mood.level * 0.25);

    ctx.fillStyle = PALETTE.seaDeep;
    ctx.fillRect(0, 0, vw, vh);

    /* Depth.
     *
     * Open water is not one colour. It goes darker as it gets deeper and further from land, and
     * without that the sea is a flat field with some squiggles on it. A radial gradient centred
     * on the island - lighter at the coast, black-blue at the corners of the board - gives the
     * whole thing a middle, and it costs one fill.
     *
     * Built once per view rather than per frame: a canvas gradient is an object, and allocating
     * one sixty times a second to draw the same thing is work nobody asked for.
     */
    if (!depth || depthFor !== `${vw}x${vh}`) {
      const [lx, ly, lw, lh] = landBounds();
      const cx = ox + (lx + lw / 2) * TILE_PX, cy = oy + (ly + lh / 2) * TILE_PX;
      const r = Math.hypot(vw, vh) * 0.62;
      depth = ctx.createRadialGradient(cx, cy, Math.min(vw, vh) * 0.18, cx, cy, r);
      /* Flat for the first half, then falling away harder and harder.
       *
       * A gradient that darkens evenly the whole way out reads as a vignette - a lens effect
       * laid over the picture. Water does not do that: there is a shelf around the island that
       * is all much the same, and then a shelf edge, and past it the colour goes quickly. So
       * the inner stops barely move, and from halfway out every stop is a bigger step than the
       * one before it. */
      depth.addColorStop(0, 'rgba(29,81,118,0.30)');     // shelf, close in
      depth.addColorStop(0.5, 'rgba(24,68,102,0.28)');   // still the shelf
      depth.addColorStop(0.7, 'rgba(14,44,74,0.44)');    // the edge of it
      depth.addColorStop(0.86, 'rgba(6,22,44,0.64)');
      depth.addColorStop(1, 'rgba(1,5,12,0.86)');        // the deep, at the corners
      depthFor = `${vw}x${vh}`;
    }
    ctx.fillStyle = depth;
    ctx.fillRect(0, 0, vw, vh);

    // The submerged mass under each boulder, before the ripples go over it. See SHOAL_SPREAD.
    drawRockShoals(ox, oy);

    // Two layers drifting at different speeds and angles, the whole thing rotated to this map's
    // heading. Parallax between them is the reason a flat fill reads as moving water; the
    // rotation is the reason it is not the same sea on every map.
    //
    // The fill has to cover the viewport once rotated, so it is sized to the diagonal and
    // centred - a viewport-sized rect turned 40 degrees leaves two bare corners.
    const reach = Math.hypot(vw, vh) / 2 + 256;
    for (let i = 0; i < 2; i++) {
      const pattern = i === 0 ? seaNear : seaFar;
      const d = current.surface[i] ?? { sx: 11, sy: 5 };
      ctx.save();
      ctx.translate(vw / 2, vh / 2);
      ctx.rotate(current.angle);
      // Modulo the pattern size, so the offset never grows large enough to lose precision.
      ctx.translate((flowT * d.sx) % 128, (flowT * d.sy) % 128);
      ctx.fillStyle = pattern;
      ctx.fillRect(-reach, -reach, reach * 2, reach * 2);
      ctx.restore();
    }

    /* Sun glints: a sparse scatter of bright specks that live for a moment and go.
     *
     * This is the single cheapest thing that makes water look like water rather than like a
     * moving texture. Real sea is covered in points of reflected sky appearing and vanishing,
     * and the eye reads that as a wet surface before it reads anything else.
     *
     * Positions come from a hash of the index and a slowly advancing epoch, so each glint sits
     * still for its whole short life and a new one appears somewhere else - no state, no
     * allocation, deterministic enough never to flicker as a group.
     */
    /* The water lifts toward the light on the bass, and flashes on the beat.
     *
     * One translucent wash over the whole sea, under everything floating on it. The depth
     * gradient means it reads as the swell rising rather than as the screen flashing. */
    // Tinted by the brightness of the mix: dark, bass-heavy passages pull the water toward deep
    // indigo, bright ones toward teal. Slow - `tone` has a 700 ms release - so it reads as the
    // light changing over the sea, never as a flash.
    const lift = mood.bass * 0.018 + mood.beat * 0.006;
    if (lift > 0.004) {
      const t = sound.tone;
      ctx.fillStyle = `rgba(${(52 - 22 * t) | 0},${(92 + 70 * t) | 0},${(196 - 14 * t) | 0},${lift})`;
      ctx.fillRect(0, 0, vw, vh);
    }

    ctx.save();
    ctx.fillStyle = '#dff0ff';
    // Sun glints. Not driven by the music any more: the top end now lights the bioluminescence,
    // and two sparkling things answering the same hi-hat was one too many.
    const glints = GLINTS;
    const shine = 0.5;
    for (let i = 0; i < glints; i++) {
      const epoch = Math.floor(seaT / GLINT_LIFE_S + i * 0.37);
      const f = (seaT / GLINT_LIFE_S + i * 0.37) % 1;
      const hx = hash01(i * 7919 + epoch * 104729);
      const hy = hash01(i * 7919 + epoch * 104729 + 1);
      // A short rise and a long fall, so they twinkle out rather than blinking off.
      const life = f < 0.25 ? f / 0.25 : 1 - (f - 0.25) / 0.75;
      ctx.globalAlpha = Math.min(1, life * shine);
      const gx = hx * vw, gy = hy * vh;
      const len = 1.5 + hash01(i + epoch) * 3.5;
      ctx.fillRect(gx, gy, len, 1);
      ctx.fillRect(gx + len / 2 - 0.5, gy - 1, 1, 3);
    }
    ctx.restore();
    ctx.globalAlpha = 1;

    // Shallows: two bands rather than one, so the water shelves away from the coast instead of
    // stepping from pale to deep in a single tile.
    ctx.save();
    ctx.translate(ox, oy);
    // The shallows breathe very slightly with the bass. Baked once per map (see shallowsLayer)
    // and lifted toward full strength by the kick, rather than re-filled tile by tile.
    const kickLift = mood.bass * 0.5;
    const shallows = shallowsLayer();
    ctx.globalAlpha = (1 + kickLift * 0.3) / SHALLOWS_HEADROOM;
    ctx.drawImage(shallows, -SHALLOWS_PAD * TILE_PX, -SHALLOWS_PAD * TILE_PX);
    drawRockShelves(1 + kickLift * 0.3);
    // The island's shadow across the shallows, under the glow and everything afloat.
    ctx.globalAlpha = 1;
    ctx.drawImage(islandShadowLayer(), -ISLAND_SHADOW_PAD * TILE_PX, -ISLAND_SHADOW_PAD * TILE_PX);

    drawCoastEq(dtMs);

    // Under the glow and over the shallows: it is IN the water, and the bioluminescence it drifts
    // among is the thing it should look related to.
    drawJelly(ox, oy, dtMs);

    drawGlow(dtMs);

    /* No caustics.
     *
     * There was a ring of rotated ellipses pulsing along the coast here, meant to read as light
     * reaching the bottom in the shallows. It did not: at one tile across and on a grid, a
     * repeating ellipse per shore tile reads as a row of ellipses, and once you have seen it as
     * a row of ellipses you cannot see it as water again. The two shelf bands above do the same
     * job - depth against the rock - without drawing a shape the eye can name.
     */
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  function drawSplashes(ox, oy, dtMs) {
    if (Math.random() < dtMs / SPLASH_EVERY_MS) spawnSplash();
    if (!splashes.length) return;
    ctx.save();
    ctx.translate(ox, oy);
    ctx.lineWidth = 2;
    for (let i = splashes.length - 1; i >= 0; i--) {
      const s = splashes[i];
      s.life -= (dtMs / 1000) * s.rate;
      if (s.life <= 0) { splashes.splice(i, 1); continue; }
      // A spreading ring rather than a filled blob. Foam is an edge, and an outline stays
      // readable at three times the size where a disc would just be a pale smear on the sea.
      const spread = s.r * (1 + (1 - s.life) * 2.2);
      ctx.globalAlpha = s.life * s.life * 0.16;     // squared, so it fades out early and gently
      ctx.strokeStyle = PALETTE.foam;
      ctx.beginPath();
      ctx.arc(s.x, s.y, spread, 0, 7);
      ctx.stroke();
      ctx.globalAlpha = s.life * s.life * 0.05;
      ctx.fillStyle = PALETTE.foam;
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // ─── melted ice ─────────────────────────────────────────────────────────────

  /* Puddles, drawn as one pool rather than five squares.
   *
   * Each wet tile contributes three overlapping ellipses, and every tile's ellipses go into the
   * SAME path, so neighbours fuse into one body of water with an organic edge instead of a plus
   * sign of tiles. That union is drawn opaque into its own layer - rim, body, sheen - and the
   * layer goes onto the board at partial alpha once, so overlaps never double up into darker
   * patches.
   *
   * Presence is eased, not read off the tick. `vis` chases 1 while the puddle is fresh and
   * chases its remaining life over the last PUDDLE_FADE_TICKS, so a puddle swells in fast and
   * dries slowly from the edges inward, steaming as it goes - and it carries on drying for a
   * moment after the simulation has dropped it, which is what makes the end look like
   * evaporation rather than a delete. Pure presentation: the sim already stopped being wet.
   */
  const pools = new Map();         // "tx,ty" -> { tx, ty, vis, target, seed }
  const ripples = [];              // rings on the water: rain-like idle ones, footsteps, the melt
  const wisps = [];                // steam off a drying puddle
  const shards = [];               // ice flying off a melt
  const pops = [];                 // the bright burst at the moment of melting
  let poolLayer = null, poolCtx = null, poolFor = null;
  let wetFloor = null;             // Path2D of walkable tiles round the puddles; see drawPuddles

  const POOL_RIM = '#9fcfe6', POOL_BODY = '#2a6c9e', POOL_SHEEN = '#3580b6';

  /**
   * One wet tile's share of the pool, plus a bridge to each wet neighbour right and below.
   *
   * The bridges are what make it a pool. Blobs sized to stay inside their own tile leave a waist
   * between neighbours where the rim shows through, and five tiles read as five balloons; blobs
   * sized to overlap without bridges bulge past the plus into the corners. A bridge at the shared
   * edge, as thick as the thinner of the two, fills the waist and nothing else.
   */
  function poolBlobs(c, fx, scale, sx, sy, t) {
    const S = TILE_PX;
    const grow = 0.3 + 0.7 * fx.vis;
    const wob = Math.sin(t * 1.6 + fx.seed * 6.28) * 0.7;
    const cx = fx.tx * S + S / 2 + sx, cy = fx.ty * S + S / 2 + sy;
    for (let k = 0; k < 3; k++) {
      const a = fx.seed * 9 + k * 2.1;
      const ex = cx + Math.cos(a) * 3 * grow, ey = cy + Math.sin(a) * 2.5 * grow;
      const rx = (S * (0.64 - k * 0.06) + wob) * scale * grow;
      const ry = rx * (0.84 + 0.1 * Math.sin(a * 1.3));
      c.moveTo(ex + rx, ey);
      c.ellipse(ex, ey, rx, ry, 0, 0, Math.PI * 2);
    }
    for (const [dx, dy] of [[1, 0], [0, 1]]) {
      const n = pools.get(`${fx.tx + dx},${fx.ty + dy}`);
      if (!n) continue;
      const g = 0.3 + 0.7 * Math.min(fx.vis, n.vis);
      const along = S * 0.62 * scale * g, across = S * 0.5 * scale * g;
      const mx = cx + (dx * S) / 2, my = cy + (dy * S) / 2;
      const rx = dx ? along : across, ry = dx ? across : along;
      c.moveTo(mx + rx, my);
      c.ellipse(mx, my, rx, ry, 0, 0, Math.PI * 2);
    }
  }

  function drawPuddles(ox, oy, dtMs) {
    const dt = dtMs / 1000;
    const live = new Set();
    for (const q of world.puddles) {
      if (q.until <= world.tick) continue;
      const key = `${q.tx},${q.ty}`;
      live.add(key);
      let fx = pools.get(key);
      if (!fx) pools.set(key, fx = { tx: q.tx, ty: q.ty, vis: 0, target: 1, seed: hash01(q.tx * 977 + q.ty * 131) });
      const left = q.until - world.tick;
      fx.target = left >= PUDDLE_FADE_TICKS ? 1 : Math.max(0, left / PUDDLE_FADE_TICKS);
    }
    for (const [key, fx] of pools) {
      if (!live.has(key)) fx.target = 0;
      // In fast, out slow: a splash arrives, a puddle evaporates.
      const tau = fx.target > fx.vis ? 90 : 320;
      fx.vis += (fx.target - fx.vis) * (1 - Math.exp(-dtMs / tau));
      if (fx.target === 0 && fx.vis < 0.03) { pools.delete(key); continue; }

      // Idle ripples, and steam once it starts drying.
      if (fx.vis > 0.5 && ripples.length < 18 && Math.random() < dtMs / 900) {
        ripples.push({ x: fx.tx * TILE_PX + 6 + Math.random() * 20, y: fx.ty * TILE_PX + 6 + Math.random() * 20,
          life: 1, max: 4 + Math.random() * 5, rate: 1.1, w: 1 });
      }
      if (fx.target < 1 && fx.vis > 0.08 && wisps.length < 48 && Math.random() < dtMs / 160) {
        wisps.push({ x: fx.tx * TILE_PX + 5 + Math.random() * 22, y: fx.ty * TILE_PX + 8 + Math.random() * 18,
          life: 1, ph: Math.random() * 6.28 });
      }
    }

    // Wading. A ring at the feet of anyone moving through water, so you can see who is slowed.
    if (pools.size) {
      for (const p of world.players) {
        if (!p || !p.alive || !p.moving || ripples.length >= 24) continue;
        const tx = (p.rx ?? p.x) >> 8, ty = (p.ry ?? p.y) >> 8;
        if (!pools.has(`${tx},${ty}`) || Math.random() > dtMs / 110) continue;
        ripples.push({ x: ((p.rx ?? p.x) / UNITS_PER_TILE) * TILE_PX, y: ((p.ry ?? p.y) / UNITS_PER_TILE) * TILE_PX + 9,
          life: 1, max: 7, rate: 1.6, w: 1.2 });
      }
    }

    if (!pools.size && !ripples.length && !wisps.length && !shards.length && !pops.length) return;

    if (pools.size) {
      const map = world.map, S = TILE_PX;
      if (poolFor !== map) {
        poolLayer = document.createElement('canvas');
        poolLayer.width = map.w * S; poolLayer.height = map.h * S;
        poolCtx = poolLayer.getContext('2d');
        poolFor = map;
      }
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const fx of pools.values()) {
        x0 = Math.min(x0, fx.tx); y0 = Math.min(y0, fx.ty);
        x1 = Math.max(x1, fx.tx); y1 = Math.max(y1, fx.ty);
      }
      const bx = Math.max(0, (x0 - 1) * S), by = Math.max(0, (y0 - 1) * S);
      const bw = Math.min(poolLayer.width, (x1 + 2) * S) - bx, bh = Math.min(poolLayer.height, (y1 + 2) * S) - by;

      /* Water stays on the floor.
       *
       * Each wet tile's blobs reach a few pixels past its edges - that bulge is what fuses
       * neighbours into one pool with an organic outline - but drawn unclipped it also spilled
       * across every wall beside the puddle, so a puddle in a corridor painted water over the
       * rock on both sides of it. So the pool, its glints and its ripples are clipped to the
       * walkable tiles round it: water can spread onto open floor and stops dead at anything
       * solid, the way it would. */
      wetFloor = new Path2D();
      for (let ty = y0 - 1; ty <= y1 + 1; ty++) {
        for (let tx = x0 - 1; tx <= x1 + 1; tx++) {
          if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) continue;
          if (BLOCK_WALKABLE(cellType(map.cells[ty * map.w + tx]), false)) wetFloor.rect(tx * S, ty * S, S, S);
        }
      }

      const pc = poolCtx;
      pc.clearRect(bx, by, bw, bh);
      pc.save();
      pc.clip(wetFloor);
      // Rim, body, then a sheen lifted toward the top-left light.
      for (const [scale, colour, sx, sy] of [[1, POOL_RIM, 0, 0], [0.9, POOL_BODY, 0, 0], [0.62, POOL_SHEEN, -2, -2]]) {
        pc.fillStyle = colour;
        pc.beginPath();
        for (const fx of pools.values()) poolBlobs(pc, fx, scale, sx, sy, seaT);
        pc.fill();
      }
      pc.restore();
      ctx.globalAlpha = 0.64;
      ctx.drawImage(poolLayer, bx, by, bw, bh, ox + bx, oy + by, bw, bh);

      // Light on the water: two small glints per puddle, circling slowly and breathing.
      ctx.save();
      ctx.translate(ox, oy);
      ctx.clip(wetFloor);
      ctx.fillStyle = '#ffffff';
      for (const fx of pools.values()) {
        if (fx.vis < 0.25) continue;
        for (let k = 0; k < 2; k++) {
          const a = seaT * 0.7 + fx.seed * 10 + k * 3.1;
          const gx = fx.tx * S + S / 2 - 3 + Math.cos(a) * 6 * fx.vis;
          const gy = fx.ty * S + S / 2 - 3 + Math.sin(a) * 4 * fx.vis;
          ctx.globalAlpha = 0.4 * fx.vis * (0.45 + 0.55 * Math.sin(seaT * 2.6 + fx.seed * 20 + k * 2));
          if (ctx.globalAlpha <= 0.01) continue;
          ctx.beginPath(); ctx.ellipse(gx, gy, 2.6, 1.1, -0.5, 0, Math.PI * 2); ctx.fill();
        }
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    ctx.save();
    ctx.translate(ox, oy);

    for (let i = pops.length - 1; i >= 0; i--) {
      const b = pops[i];
      b.life -= dt / 0.28;
      if (b.life <= 0) { pops.splice(i, 1); continue; }
      ctx.globalAlpha = b.life * b.life * 0.5;
      ctx.fillStyle = '#e9f8ff';
      ctx.beginPath(); ctx.arc(b.x, b.y, TILE_PX * (0.45 + (1 - b.life) * 0.5), 0, Math.PI * 2); ctx.fill();
    }

    // Rings on the water stay on the water too (see wetFloor above) - while there is any.
    ctx.save();
    if (pools.size && wetFloor) ctx.clip(wetFloor);
    ctx.strokeStyle = '#d8f1ff';
    for (let i = ripples.length - 1; i >= 0; i--) {
      const r = ripples[i];
      r.life -= dt * r.rate;
      if (r.life <= 0) { ripples.splice(i, 1); continue; }
      ctx.globalAlpha = r.life * r.life * 0.55;
      ctx.lineWidth = r.w;
      ctx.beginPath(); ctx.ellipse(r.x, r.y, 1.5 + (1 - r.life) * r.max, (1.5 + (1 - r.life) * r.max) * 0.7, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    ctx.fillStyle = '#e6f4fb';
    for (let i = wisps.length - 1; i >= 0; i--) {
      const s = wisps[i];
      s.life -= dt / 1.2;
      if (s.life <= 0) { wisps.splice(i, 1); continue; }
      const up = (1 - s.life) * 16;
      ctx.globalAlpha = Math.sin(s.life * Math.PI) * 0.22;     // in and out, never a pop
      ctx.beginPath();
      ctx.arc(s.x + Math.sin(s.ph + up * 0.3) * 2.5, s.y - up, 1.8 + (1 - s.life) * 4, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = shards.length - 1; i >= 0; i--) {
      const s = shards[i];
      s.life -= dt / s.span;
      if (s.life <= 0) { shards.splice(i, 1); continue; }
      const drag = Math.exp(-dt * 5);
      s.vx *= drag; s.vy *= drag;
      s.x += s.vx * dt; s.y += s.vy * dt;
      s.rot += s.vr * dt;
      ctx.globalAlpha = Math.min(1, s.life * 1.6);
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.beginPath();
      ctx.moveTo(0, -s.size); ctx.lineTo(s.size * 0.55, 0); ctx.lineTo(0, s.size); ctx.lineTo(-s.size * 0.55, 0);
      ctx.closePath();
      ctx.fillStyle = '#cdeefc'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 0.8; ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /** Ice breaking: a flash, a ring of meltwater pushing out, and shards thrown off it. */
  function addMelt(tx, ty) {
    const x = tx * TILE_PX + TILE_PX / 2, y = ty * TILE_PX + TILE_PX / 2;
    pops.push({ x, y, life: 1 });
    ripples.push({ x, y, life: 1, max: TILE_PX * 0.9, rate: 1.4, w: 2.2 });
    ripples.push({ x, y, life: 1, max: TILE_PX * 0.5, rate: 1.9, w: 1.4 });
    for (let i = 0; i < 12 && shards.length < 60; i++) {
      const a = (i / 12) * Math.PI * 2 + Math.random() * 0.4;
      const v = 60 + Math.random() * 90;
      shards.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, rot: a, vr: (Math.random() * 2 - 1) * 9,
        size: 2 + Math.random() * 2.5, life: 1, span: 0.45 + Math.random() * 0.3 });
    }
  }

  // ─── smoke ──────────────────────────────────────────────────────────────────
  //
  // What a blast leaves behind. The fire is half a second and the rules; the smoke is two and a
  // half and pure atmosphere, so it is a particle the renderer owns rather than part of a fire
  // tile. It starts as the flames die - dense and dark low down, close to the tile - then lifts,
  // swells, rolls slowly and thins to nothing, carried off with the same wind as the sea.
  //
  // Each puff is a pre-drawn soft disc, blitted scaled: no gradients built per frame, no filters,
  // and a hard cap, so a chain across the map costs a fixed amount however big it gets.

  const smokes = [];
  const SMOKE_MAX = 260;
  let smokeSprites = null;

  function smokeSprite(core, edge) {
    const el = document.createElement('canvas');
    el.width = el.height = 64;
    const g = el.getContext('2d');
    // Two overlapping soft lobes rather than one disc: a single radial gradient reads as a ball.
    for (const [x, y, r, a] of [[30, 34, 26, 1], [38, 28, 18, 0.8], [24, 26, 16, 0.7]]) {
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, core.replace('A', String(a)));
      grad.addColorStop(0.55, edge.replace('A', String(a * 0.6)));
      grad.addColorStop(1, edge.replace('A', '0'));
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    }
    return el;
  }

  /** A blast just went off over these cells. A keg's smoke is bigger, darker and lasts longer. */
  function addSmoke(cells, keg = false) {
    smokeSprites ??= [
      smokeSprite('rgba(40,42,48,A)', 'rgba(58,61,68,A)'),      // soot, the first second
      smokeSprite('rgba(98,102,110,A)', 'rgba(120,124,132,A)'),  // grey, as it cools
      smokeSprite('rgba(150,154,160,A)', 'rgba(170,174,180,A)'), // the pale wisps at the top
    ];
    for (const c of cells) {
      const n = c.kind === 'core' ? (keg ? 7 : 4) : (keg ? 2 : 1);
      for (let i = 0; i < n; i++) {
        if (smokes.length >= SMOKE_MAX) smokes.shift();
        smokes.push({
          x: (c.tx + 0.5) * TILE_PX + (Math.random() - 0.5) * TILE_PX * 0.6,
          y: (c.ty + 0.5) * TILE_PX + (Math.random() - 0.5) * TILE_PX * 0.6,
          // Born as the fire dies: the arms first, the core a beat later.
          delay: (c.kind === 'core' ? 0.3 : 0.18) + Math.random() * 0.22,
          age: 0,
          // 40% shorter than it was, on request: it clears while the next fight is starting.
          life: ((keg ? 2.6 : 1.8) + Math.random() * 0.9) * 0.6,
          r0: TILE_PX * (0.28 + Math.random() * 0.12) * (keg ? 1.3 : 1),
          grow: TILE_PX * (0.55 + Math.random() * 0.35) * (keg ? 1.5 : 1),
          rise: 10 + Math.random() * 10,                 // px/s, slowing as it goes
          dx: (Math.random() - 0.5) * 14,
          spin: (Math.random() - 0.5) * 0.9,
          rot: Math.random() * Math.PI * 2,
          peak: (c.kind === 'core' ? 0.5 : 0.36) * (keg ? 1.15 : 1),
        });
      }
    }
  }

  function drawSmoke(ox, oy, dtMs) {
    if (!smokes.length) return;
    const dt = dtMs / 1000;
    // The same wind the sea drifts in, gently.
    const wx = Math.cos(current.angle) * current.speed * 0.6;
    const wy = Math.sin(current.angle) * current.speed * 0.6;
    const ease = x => x * x * (3 - 2 * x);
    for (let i = smokes.length - 1; i >= 0; i--) {
      const s = smokes[i];
      if (s.delay > 0) { s.delay -= dt; continue; }
      s.age += dt;
      const k = s.age / s.life;
      if (k >= 1) { smokes.splice(i, 1); continue; }
      // Rises quickly at first and slows, the way warm air does as it cools.
      const lift = 1 - k * 0.7;
      s.y -= s.rise * lift * dt;
      s.x += (s.dx * lift + wx) * dt;
      s.y += wy * dt;
      s.rot += s.spin * dt;
      // In over the first fifth, hold, out over the last half - never a pop at either end.
      const a = s.peak * ease(Math.min(1, k / 0.18)) * (1 - ease(Math.max(0, (k - 0.45) / 0.55)));
      if (a < 0.01) continue;
      const r = s.r0 + s.grow * Math.sqrt(k);
      // Soot to grey to pale as it ages, by cross-fading the three sprites.
      const tone = Math.min(1.999, k * 2.2);
      const t0 = Math.floor(tone), mix = tone - t0;
      ctx.save();
      ctx.translate(ox + s.x, oy + s.y);
      ctx.rotate(s.rot);
      ctx.globalAlpha = a * (1 - mix);
      ctx.drawImage(smokeSprites[t0], -r, -r, r * 2, r * 2);
      if (mix > 0.02) {
        ctx.globalAlpha = a * mix;
        ctx.drawImage(smokeSprites[t0 + 1], -r, -r, r * 2, r * 2);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // ─── gulls ──────────────────────────────────────────────────────────────────
  //
  // The flight is the server's (see shared/sim/gulls.js): every frame asks gullAt where a bird
  // is at the smoothed tick, so it is drawn exactly where a blast has to catch it. Everything
  // else here - the wingbeat, the lean into the weave, the shadow, the cry, the tumble when one
  // is hit - is presentation, and none of it is told to the server.

  const gullSeen = new Map();      // id -> { def, x, y, alt, heading, cryAt, gone }
  const falls = [];                // gulls on their way down
  const feathers = [];             // what came off them
  const coinGlints = [];           // the coin landing
  const coinFlights = [];          // coins on their way to whoever shot the bird down
  let gullT = 0;                   // the smoothed tick the birds were last drawn at

  /** Everything needed to draw one gull at a fractional tick. */
  function gullPose(g, t) {
    const now = gullAt(g, t), ahead = gullAt(g, t + 1), behind = gullAt(g, t - 1);
    const heading = Math.atan2(ahead.y - now.y, ahead.x - now.x);
    // Lean into the weave: how fast the heading is turning, which way.
    let turn = heading - Math.atan2(now.y - behind.y, now.x - behind.x);
    if (turn > Math.PI) turn -= Math.PI * 2; else if (turn < -Math.PI) turn += Math.PI * 2;
    const climbing = ahead.alt > now.alt + 0.002;
    const diving = ahead.alt < now.alt - 0.002;

    /* The wingbeat.
     *
     * Gulls glide far more than they flap, so a bird flapping all the time reads as a pigeon.
     * Flapping happens in bursts on a slow per-bird cycle, and always on the climb out of a dive
     * - that is where the work is. Going down, the wings tuck back. From above a wing raised or
     * lowered is foreshortened, so a beat is the visible span swinging between about half and
     * all of it: the cosine of a wing swinging through ±58 degrees. */
    const burst = Math.sin(seaT * 0.8 + g.id * 2.3) > 0.45;
    let span = 0.97 + 0.03 * Math.sin(seaT * 1.7 + g.id);
    if (climbing || burst) {
      const beat = Math.sin((seaT * (climbing ? 4.2 : 3.3) + g.id * 0.37) * Math.PI * 2);
      span = Math.cos(beat * 1.01);
    }
    const fold = diving ? Math.min(1, (1 - now.alt) * 1.25) : 0;
    /* Two heights, and they are not the same thing.
     *
     * `alt` is the dive - this bird's own height within its flight, 1 cruising and 0 at the
     * bottom. `hi` is which layer of sky it is flying in at all, picked once when it spawned
     * (see GULL_DEPTH_MIN). The dive makes a bird dip; the layer makes one bird further away
     * than another. Multiplying them is what gives a sky of four gulls four distances in it.
     */
    const hi = g.hi || 1;
    return {
      x: (now.x / UNITS_PER_TILE) * TILE_PX, y: (now.y / UNITS_PER_TILE) * TILE_PX,
      alt: now.alt, hi, heading, span, fold, lean: Math.max(-1, Math.min(1, turn * 9)),
      // Closer to the camera when low, and smaller the higher its layer. The size change is the
      // second half of the height cue - the first is the shadow.
      scale: (0.78 + 0.4 * now.alt) / hi,
      // Air between you and it. A bird three layers up is washed toward the colour of the sky,
      // which from this camera is the only way height reads when it is not diving.
      haze: 1 - 0.46 * (hi - 1),
    };
  }

  /**
   * How far the shadow sits from the bird, and how soft: right under it and crisp at the bottom
   * of a dive, a long soft way off for a bird cruising in the top layer.
   */
  function gullShadowOffset(alt, hi = 1) {
    const { dx, dy } = sunVec();
    const len = Math.hypot(dx, dy) || 1;
    const reach = (3 + 44 * alt) * hi;
    return { sx: (dx / len) * reach, sy: (dy / len) * reach, soft: hi };
  }

  /* The shadows, on the ground, with the other shadows - before the players stand on them.
   *
   * This is the tell. A gull is only catchable at the bottom of a dive, and from straight above
   * height is invisible; what you can see is the shadow sliding in until it is underneath the
   * bird and turning crisp. */
  function drawGullShadows(ox, oy, t) {
    if (!world.gulls.length) return;
    ctx.save();
    clipToFloor(ox, oy);
    for (const g of world.gulls) {
      if (gullSeen.get(g.id)?.gone) continue;
      const p = gullPose(g, t);
      const { sx, sy, soft } = gullShadowOffset(p.alt, p.hi);
      ctx.save();
      ctx.fillStyle = '#000';
      // Higher up: fainter and spread wider, which is what a shadow does as the light leaving
      // the bird has further to travel before it reaches the sand.
      ctx.globalAlpha = (0.3 - 0.16 * p.alt) / soft;
      ctx.translate(ox + p.x + sx, oy + p.y + sy);
      ctx.rotate(p.heading);
      ctx.scale(p.scale * 0.92 * soft, p.scale * 0.92 * soft);
      drawGull(ctx, { span: p.span, fold: p.fold, lean: p.lean, shadow: true });
      ctx.restore();
    }
    ctx.restore();
  }

  /** A gull is down: the tumble, a burst of feathers, and the coin's glint where it lands. */
  function gullDown(def, x, y, coin) {
    const t = gullT || world.tick;
    const p = gullPose(def, t);
    const ahead = gullAt(def, t + 1), now = gullAt(def, t);
    const vx = ((ahead.x - now.x) / UNITS_PER_TILE) * TILE_PX * 30;
    const vy = ((ahead.y - now.y) / UNITS_PER_TILE) * TILE_PX * 30;
    const px = (x / UNITS_PER_TILE) * TILE_PX, py = (y / UNITS_PER_TILE) * TILE_PX;
    falls.push({ x: px, y: py, vx, vy, heading: p.heading, alt: p.alt, hi: p.hi, age: 0,
      spin: (Math.random() < 0.5 ? -1 : 1) * (7 + Math.random() * 4),
      coin: coin ? { x: (coin.cx + 0.5) * TILE_PX, y: (coin.cy + 0.5) * TILE_PX } : null });
    for (let i = 0; i < 14 && feathers.length < 60; i++) {
      const a = Math.random() * Math.PI * 2, v = 18 + Math.random() * 46;
      feathers.push({
        x: px, y: py, vx: Math.cos(a) * v + vx * 0.25, vy: Math.sin(a) * v + vy * 0.25,
        rot: Math.random() * Math.PI * 2, vr: (Math.random() * 2 - 1) * 5,
        life: 1, span: 1.3 + Math.random() * 1.1, ph: Math.random() * 6.28,
        size: 0.8 + Math.random() * 0.6,
        tone: Math.random() < 0.6 ? '#f2f5f7' : Math.random() < 0.7 ? '#b7c2cc' : '#2a2e35',
      });
    }
    pops.push({ x: px, y: py, life: 1 });
    api.onGullDown?.(x / UNITS_PER_TILE, y / UNITS_PER_TILE);
  }

  /** Called with the server's `gullhit`, which knows exactly where it was and where the coin went. */
  function gullHit(e) {
    const seen = gullSeen.get(e.id);
    if (seen?.gone) return;
    const def = seen?.def ?? world.gulls.find(g => g.id === e.id);
    if (!def) return;
    gullSeen.set(e.id, { ...(seen || {}), def, gone: true });
    gullDown(def, e.x, e.y, e.cx !== undefined ? { cx: e.cx, cy: e.cy } : null);
    if (e.coins && e.by >= 0) throwCoins(e.x, e.y, e.by, e.coins);
  }

  /* The payout, thrown out of the sky and into the shooter's pocket.
   *
   * The coins are already theirs - the server paid them on the tick the bird fell - so this is
   * pure presentation, and it has one job: connect the blast you set to the number that moved in
   * the corner of the screen. A coin on the floor did that connecting badly; a coin that flies to
   * YOU and lands on you cannot be misread.
   *
   * Thrown up and out first, then homing, each one a little later than the last, so three coins
   * read as a handful rather than as one coin drawn three times. The target is read every frame
   * from the rendered position, which means it follows a player who is still running.
   */
  function throwCoins(x, y, seat, n) {
    const px = (x / UNITS_PER_TILE) * TILE_PX, py = (y / UNITS_PER_TILE) * TILE_PX;
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i - (n - 1) / 2) * 0.5;
      coinFlights.push({
        x: px, y: py, vx: Math.cos(a) * 70, vy: Math.sin(a) * 70,
        seat, age: -i * 0.09, lift: 0, spin: Math.random() * 6, done: false,
      });
    }
  }

  /** A gold coin seen three-quarters on, at `r` pixels. The rim is what makes it metal. */
  function drawCoinFace(c, r, turn) {
    // Turning edge-on and back: the face narrows to a sliver and the thickness behind it shows.
    const squash = Math.abs(Math.cos(turn));
    c.fillStyle = '#7d5c0f';
    c.beginPath(); c.ellipse(0.6, 0.9, Math.max(0.7, r * squash), r, 0, 0, 7); c.fill();
    c.fillStyle = '#edc24e';
    c.beginPath(); c.ellipse(0, 0, Math.max(0.5, r * squash), r, 0, 0, 7); c.fill();
    if (squash < 0.35) return;                       // edge-on: no face to decorate
    c.strokeStyle = '#4a3608';
    c.lineWidth = 1;
    c.stroke();
    c.globalAlpha *= 0.85;
    c.fillStyle = '#f6e7a9';
    c.beginPath();
    c.ellipse(-r * 0.3 * squash, -r * 0.3, r * 0.32 * squash, r * 0.34, -0.5, 0, 7);
    c.fill();
  }

  function drawCoinFlights(ox, oy, dtMs) {
    if (!coinFlights.length) return;
    const dt = dtMs / 1000;
    for (let i = coinFlights.length - 1; i >= 0; i--) {
      const f = coinFlights[i];
      f.age += dt;
      if (f.age < 0) continue;
      const p = world.players[f.seat];
      if (!p) { coinFlights.splice(i, 1); continue; }
      const tx = ((p.rx ?? p.x) / UNITS_PER_TILE) * TILE_PX;
      const ty = ((p.ry ?? p.y) / UNITS_PER_TILE) * TILE_PX - TILE_PX * 0.35;

      /* Thrown, then pulled.
       *
       * The throw is a real velocity with drag on it, so the first moment is the coin coming off
       * the blast. The pull is an acceleration toward the target that grows with time - which is
       * what makes the end of the flight certain without the beginning looking magnetic. Capped,
       * or a coin chasing a sprinting player would orbit them.
       */
      const dx = tx - f.x, dy = ty - f.y;
      const d = Math.hypot(dx, dy) || 1;
      const pull = Math.min(2600, 420 + f.age * 2600);
      f.vx = f.vx * Math.exp(-dt * 2.2) + (dx / d) * pull * dt;
      f.vy = f.vy * Math.exp(-dt * 2.2) + (dy / d) * pull * dt;
      f.x += f.vx * dt; f.y += f.vy * dt;
      f.spin += dt * 11;
      // A hop in the air on the way, so it arcs over the board rather than sliding across it.
      f.lift = Math.sin(Math.min(1, f.age / 0.5) * Math.PI) * 9;

      if (d < 7 || f.age > 1.8) {
        coinFlights.splice(i, 1);
        // Landing in the pocket: the same glint the floor coin gets, on the player.
        coinGlints.push({ x: tx, y: ty, life: 1, rot: Math.random() * 6 });
        continue;
      }

      ctx.save();
      ctx.globalAlpha = Math.min(1, f.age * 6) * Math.min(1, d / 10);
      // The shadow it throws while it is up, which is the only cue that it is above the board.
      ctx.save();
      ctx.globalAlpha *= 0.22;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(ox + f.x + 2, oy + f.y + 3, 3.4, 1.6, 0, 0, 7);
      ctx.fill();
      ctx.restore();
      ctx.translate(ox + f.x, oy + f.y - f.lift);
      drawCoinFace(ctx, 4.2, f.spin);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /**
   * Bookkeeping per frame: new birds, birds that left, and birds that vanished early.
   *
   * A gull that disappears from the snapshot before its flight is over was shot down, whether or
   * not the `gullhit` event made it here - events ride in snapshots, and a snapshot can be lost
   * on the datagram channel. Without this it would simply blink out of the sky.
   */
  function trackGulls(t) {
    const live = new Set();
    const [lx, ly, lw, lh] = landBounds();
    for (const g of world.gulls) {
      live.add(g.id);
      let s = gullSeen.get(g.id);
      if (!s) gullSeen.set(g.id, s = { def: g, cryAt: -1, gone: false });
      const at = gullAt(g, t);
      s.x = at.x; s.y = at.y;
      // A cry now and then, but only over or near the island - out past the edge of the board
      // nobody can see what is making the noise.
      const tx = at.x / UNITS_PER_TILE, ty = at.y / UNITS_PER_TILE;
      const near = tx > lx - 3 && tx < lx + lw + 3 && ty > ly - 3 && ty < ly + lh + 3;
      if (!near) continue;
      if (s.cryAt < 0) s.cryAt = seaT + 0.3 + Math.random() * 1.6;
      else if (seaT >= s.cryAt) {
        api.onGullCry?.(tx, ty);
        s.cryAt = seaT + 4.5 + Math.random() * 6;
      }
    }
    for (const [id, s] of gullSeen) {
      if (live.has(id)) continue;
      if (!s.gone && t < s.def.t0 + s.def.dur - 4) gullDown(s.def, s.x, s.y, null);
      gullSeen.delete(id);
    }
  }

  function drawGulls(ox, oy, t, dtMs) {
    const dt = dtMs / 1000;
    // Highest layer first, so a low bird crossing a high one passes in front of it. Four gulls
    // in the sky and no order to them is four gulls at the same distance.
    const flock = world.gulls.filter(g => !gullSeen.get(g.id)?.gone)
      .sort((a, b) => (b.hi || 1) - (a.hi || 1));
    for (const g of flock) {
      const p = gullPose(g, t);
      ctx.save();
      ctx.globalAlpha = p.haze;
      ctx.translate(ox + p.x, oy + p.y);
      ctx.rotate(p.heading);
      ctx.scale(p.scale, p.scale);
      drawGull(ctx, p);
      ctx.restore();
    }
    ctx.globalAlpha = 1;

    // The tumble: spinning, wings flailing, dropping out of the sky and shrinking as it goes.
    for (let i = falls.length - 1; i >= 0; i--) {
      const f = falls[i];
      f.age += dt;
      const FALL_S = 0.62, FADE_S = 0.3;
      if (f.age > FALL_S + FADE_S) { falls.splice(i, 1); continue; }
      const k = Math.min(1, f.age / FALL_S);
      const drag = Math.exp(-dt * 4);
      f.vx *= drag; f.vy *= drag;
      f.x += f.vx * dt; f.y += f.vy * dt;
      f.heading += f.spin * dt;
      if (k >= 1 && !f.landed) {
        f.landed = true;
        ripples.push({ x: f.x, y: f.y, life: 1, max: TILE_PX * 0.6, rate: 2, w: 1.4 });
        if (f.coin) coinGlints.push({ x: f.coin.x, y: f.coin.y, life: 1, rot: Math.random() * 6 });
      }
      const alt = f.alt * (1 - k);
      const hi = f.hi || 1;
      const scale = ((0.78 + 0.4 * alt) / hi) * (1 - 0.25 * k);
      const { sx, sy } = gullShadowOffset(alt, hi);
      ctx.save();
      ctx.globalAlpha = f.age > FALL_S ? Math.max(0, 1 - (f.age - FALL_S) / FADE_S) : 1;
      ctx.save();
      ctx.globalAlpha *= 0.3;
      ctx.fillStyle = '#000';
      ctx.translate(ox + f.x + sx, oy + f.y + sy);
      ctx.rotate(f.heading);
      ctx.scale(scale * 0.92, scale * 0.92);
      drawGull(ctx, { span: 0.55, fold: 0.3, shadow: true });
      ctx.restore();
      ctx.translate(ox + f.x, oy + f.y);
      ctx.rotate(f.heading);
      ctx.scale(scale, scale);
      drawGull(ctx, { span: 0.5 + 0.2 * Math.sin(f.age * 38), fold: 0.3, lean: Math.sin(f.age * 31) });
      ctx.restore();
    }

    // Feathers: thrown out, then drifting and rocking, the way a feather never falls straight.
    for (let i = feathers.length - 1; i >= 0; i--) {
      const q = feathers[i];
      q.life -= dt / q.span;
      if (q.life <= 0) { feathers.splice(i, 1); continue; }
      const drag = Math.exp(-dt * 3.2);
      q.vx *= drag; q.vy *= drag;
      q.x += q.vx * dt + Math.sin(seaT * 4 + q.ph) * 6 * dt;
      q.y += q.vy * dt + 7 * dt;
      q.rot += q.vr * dt * q.life;
      ctx.save();
      ctx.globalAlpha = Math.min(1, q.life * 2.5) * 0.95;
      ctx.translate(ox + q.x, oy + q.y);
      ctx.rotate(q.rot + Math.sin(seaT * 5 + q.ph) * 0.5);
      ctx.scale(q.size, q.size);
      drawFeather(ctx, q.tone);
      ctx.restore();
    }

    // The coin's arrival: a gold ring and a four-point star, so the eye goes to where it fell.
    for (let i = coinGlints.length - 1; i >= 0; i--) {
      const s = coinGlints[i];
      s.life -= dt / 0.75;
      if (s.life <= 0) { coinGlints.splice(i, 1); continue; }
      const x = ox + s.x, y = oy + s.y, k = 1 - s.life;
      ctx.save();
      ctx.globalAlpha = s.life * 0.7;
      ctx.strokeStyle = '#ffd86b';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, 4 + k * 14, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = Math.min(1, s.life * 1.6);
      ctx.translate(x, y);
      ctx.rotate(s.rot + k * 1.6);
      const r = 3 + 6 * Math.sin(Math.min(1, k * 1.4) * Math.PI);
      ctx.fillStyle = '#fff3c4';
      ctx.beginPath();
      for (let n = 0; n < 4; n++) {
        const a = (n / 4) * Math.PI * 2;
        ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        ctx.lineTo(Math.cos(a + Math.PI / 4) * r * 0.25, Math.sin(a + Math.PI / 4) * r * 0.25);
      }
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  // ─── frame ──────────────────────────────────────────────────────────────────

  function frame(dtMs = 16) {
    if (!world.ready || !world.map) return;
    ensureBaked();

    const me = world.me();
    if (!view.w) resize();
    if (!view.w) return;
    const zoom = view.zoom;
    // Everything below works in world pixels; the transform turns them into device pixels.
    ctx.setTransform(view.dpr * zoom, 0, 0, view.dpr * zoom, 0, 0);
    ctx.imageSmoothingEnabled = view.smooth;
    /* Start every frame from a known state.
     *
     * `setTransform` resets the transform and nothing else. A frame that throws part-way
     * through - in a draw helper that had already called `save()` and set `lighter` - leaves
     * the context on that blend with an unbalanced save stack, and every frame after it adds
     * instead of painting: the board goes white within a few frames and the error that caused
     * it is six frames back in the log. Two assignments make a thrown frame cost one frame. */
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    const vw = view.w / zoom, vh = view.h / zoom;
    // The camera frames the ISLAND, not the grid: centring on the middle of the rectangle puts
    // an off-centre island off-centre on screen, with all the spare ocean on one side.
    const [lx, ly, lw, lh] = landBounds();
    const worldW = lw * TILE_PX, worldH = lh * TILE_PX;
    const originX = lx * TILE_PX, originY = ly * TILE_PX;

    // Follow, then clamp. When the whole map fits - which it now does on most screens - the
    // clamp collapses to a single position and the camera simply stops existing, which is the
    // right answer for a sixteen-player game on an island: you can see everyone.
    if (me && (worldW > vw || worldH > vh)) {
      const tx = (me.rx / UNITS_PER_TILE) * TILE_PX - vw / 2;
      const ty = (me.ry / UNITS_PER_TILE) * TILE_PX - vh / 2;
      // Time-based, not per-frame: a fixed 0.25 factor makes the camera twice as laggy at
      // 120 Hz as at 60 Hz, which is exactly the kind of thing that reads as "it feels off".
      const k = 1 - Math.exp(-dtMs / 35);
      if (Math.abs(tx - cam.x) > vw || Math.abs(ty - cam.y) > vh) { cam.x = tx; cam.y = ty; }
      else { cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k; }
    }
    // Centre whichever axis has room to spare, instead of pinning the island to the top left.
    // cam stays in absolute world pixels throughout; only the clamp knows about the island.
    cam.x = worldW <= vw ? originX + (worldW - vw) / 2
      : Math.max(originX, Math.min(originX + worldW - vw, cam.x));
    cam.y = worldH <= vh ? originY + (worldH - vh) / 2
      : Math.max(originY, Math.min(originY + worldH - vh, cam.y));

    /* Drunk camera: a slow roll and a lazy drift, not a shake.
     *
     * A shake is an impact - short, high frequency, and it means something hit you. Being drunk
     * is the opposite: low frequency, continuous, and it never quite settles. So the board
     * leans a degree or two and wanders a few pixels on two slow sines, which is enough to make
     * lining up a corridor feel wrong without making anybody ill.
     *
     * Rotation is about the centre of the board rather than the origin, or the whole thing
     * swings away like a door.
     */
    const meNow = world.me();
    drunk += ((meNow && (meNow.status & STATUS.DRUNK) ? 1 : 0) - drunk) * (1 - Math.exp(-dtMs / 400));
    if (drunk > 0.01) {
      const roll = Math.sin(seaT * 0.63) * 0.035 * drunk;
      ctx.translate(vw / 2, vh / 2);
      ctx.rotate(roll);
      ctx.translate(-vw / 2, -vh / 2);
      ctx.translate(Math.sin(seaT * 0.41) * 9 * drunk, Math.cos(seaT * 0.29) * 6 * drunk);
    }

    // Shake is applied to the draw offset, not to the camera, so it cannot accumulate into the
    // follow logic or drift the view. Decay is time-based for the same reason the follow is.
    let sx = 0, sy = 0;
    if (shake > 0.002) {
      const amp = shake * shake * 11;        // squared, so small hits barely register
      sx = (Math.random() * 2 - 1) * amp;
      sy = (Math.random() * 2 - 1) * amp;
      shake *= Math.exp(-dtMs / 90);
    } else shake = 0;

    const ox = -Math.round(cam.x) + Math.round(sx), oy = -Math.round(cam.y) + Math.round(sy);

    // Listen before drawing a single wave, so everything this frame hears the same instant.
    sound = soundOf ? soundOf(dtMs) : CALM;
    // And smoothed once more, here, for everything on the open sea. See mood.
    {
      const up = 1 - Math.exp(-dtMs / 180), down = 1 - Math.exp(-dtMs / 700);
      const glide = (key, v) => { mood[key] += (v - mood[key]) * (v > mood[key] ? up : down); };
      glide('bass', lifted(sound.bass)); glide('mid', lifted(sound.mid));
      glide('high', lifted(sound.high)); glide('level', lifted(sound.level));
      glide('beat', sound.beat);
    }

    feedGlow(dtMs);

    drawSea(vw, vh, ox, oy, dtMs);
    // Both before the flow field, so the current runs ACROSS them rather than over the top.
    // Streaks of foam crossing a deck or a boulder read as the water being in front of the
    // thing, which is the one spatial relationship that cannot be true here.
    drawWaterRocks(ox, oy);
    drawMoored(ox, oy);
    /* No flow indicators.
     *
     * There were six hundred short white streaks drifting on the flow field here, and they were
     * the clearest thing in the sea - which is the problem: the only moving thing on screen that
     * nobody needs to look at was also the most legible. What the current does to the water is
     * already said by the two scrolling surface layers, the depth gradient and the glints, and
     * none of those draw a shape the eye can name. The field itself (`flowAt`) stays: the dust,
     * the bioluminescence and the coast all drift on it.
     */

    const cx0 = Math.floor(cam.x / CHUNK_PX), cx1 = Math.floor((cam.x + vw) / CHUNK_PX);
    const cy0 = Math.floor(cam.y / CHUNK_PX), cy1 = Math.floor((cam.y + vh) / CHUNK_PX);
    for (let cy = cy0; cy <= cy1; cy++)
      for (let cx = cx0; cx <= cx1; cx++)
        ctx.drawImage(chunkAt(cx, cy), ox + cx * CHUNK_PX, oy + cy * CHUNK_PX);

    drawSplashes(ox, oy, dtMs);
    // On the floor, under the perks, bombs and everybody standing in it.
    drawPuddles(ox, oy, dtMs);

    /* In and out, both quick.
     *
     * A perk used to exist or not exist between two frames - it appeared the instant a crate
     * broke, inside the dust of the blast that broke it, and it disappeared the instant somebody
     * walked over it. Both are the same problem: nothing on this board should change state in
     * one frame, because a thing that does cannot be seen to have changed at all. A sixth of a
     * second of fade and overshoot on arrival reads as the thing being uncovered; the same on
     * the way out reads as it being taken.
     *
     * Both are keyed off the id, which is unique and monotonic, so nothing has to be told
     * anything - a perk is new because this renderer has not seen its id before, and gone
     * because its id is no longer in the snapshot. A reconnect mid-fade shows the perk plainly,
     * which is right: it is not new to the BOARD, only to this renderer.
     */
    const now = performance.now();
    for (const k of world.perks) {
      if (!perkSeen.has(k.id)) perkSeen.set(k.id, now);
      perkLive.add(k.id);
      const inT = Math.min(1, (now - perkSeen.get(k.id)) / PERK_POP_MS);
      const bob = Math.sin((world.tick + k.id * 7) / 6) * 2;
      // Dying drops fade and shrink. `until` rides along in the snapshot, so this needs no event
      // and survives a reconnect - a perk half-faded when you dropped out is still half-faded
      // when you come back, instead of resetting to full and then vanishing.
      const left = (k.until ?? Infinity) - world.tick;
      const fade = left >= PERK_FADE_TICKS ? 1 : Math.max(0, left / PERK_FADE_TICKS);
      ctx.save();
      ctx.translate(ox + k.tx * TILE_PX, oy + k.ty * TILE_PX);

      /* Rum glows.
       *
       * One drop in ten and the only perk that changes how the game is played rather than how
       * well you play it, so it is worth crossing a map for - and worth being able to SEE from
       * across one. A warm halo behind the tile, breathing, drawn before the plinth so it reads
       * as light coming off the bottle rather than as a ring painted round it.
       */
      if (PERK_GLOWS.has(k.type)) {
        const beat = 0.6 + 0.4 * Math.sin((world.tick + k.id * 11) / 9);
        const g = ctx.createRadialGradient(
          TILE_PX / 2, TILE_PX / 2, TILE_PX * 0.12,
          TILE_PX / 2, TILE_PX / 2, TILE_PX * (0.85 + 0.15 * beat),
        );
        g.addColorStop(0, `rgba(255,186,92,${0.42 * beat})`);
        g.addColorStop(0.5, `rgba(217,154,85,${0.2 * beat})`);
        g.addColorStop(1, 'rgba(217,154,85,0)');
        ctx.fillStyle = g;
        ctx.fillRect(-TILE_PX, -TILE_PX, TILE_PX * 3, TILE_PX * 3);
      }

      if (inT < 1) {
        // Up through a small overshoot: a thing that arrives at exactly its final size looks
        // placed, where one that goes a few percent past and settles looks uncovered.
        const pop = 1 + Math.sin(inT * Math.PI) * 0.16;
        ctx.globalAlpha = inT;
        ctx.translate(TILE_PX / 2, TILE_PX / 2);
        ctx.scale(pop * (0.6 + 0.4 * inT), pop * (0.6 + 0.4 * inT));
        ctx.translate(-TILE_PX / 2, -TILE_PX / 2);
      }

      if (fade < 1) {
        /* Five seconds of leaving, and most of it is just getting dimmer.
         *
         * The blink used to start as soon as the fade did, which at fifteen seconds meant a
         * flashing perk was the normal state of a perk. It is the last fifth now - the part where
         * "this is going" becomes "this is going NOW" - and the rest is a plain, slow fade that
         * reads as time passing rather than as an alarm. */
        const blink = 0.8 + 0.2 * Math.sin(world.tick / 1.8);
        ctx.globalAlpha = fade * (fade < 0.2 ? blink : 1) * Math.min(1, inT);
        // Shrink about the tile's centre, so it sinks into the floor rather than drifting.
        const scale = 0.72 + 0.28 * fade;
        ctx.translate(TILE_PX / 2, TILE_PX / 2);
        ctx.scale(scale, scale);
        ctx.translate(-TILE_PX / 2, -TILE_PX / 2);
      }
      drawPerk(ctx, { type: k.type, bob });
      ctx.restore();
    }

    /* And the ones that have gone: taken, or burnt where they lay.
     *
     * Drawn from what was remembered of them for a sixth of a second - rising, shrinking and
     * fading - after which the id is forgotten. Rising, because every other "this is yours now"
     * on this board goes up: the pickup label, the coins, the score. */
    for (const [id, at] of perkSeen) {
      if (perkLive.has(id)) continue;
      const ghost = perkGone.get(id);
      if (!ghost) { perkSeen.delete(id); continue; }
      const t = (now - ghost.at) / PERK_POP_MS;
      if (t >= 1) { perkSeen.delete(id); perkGone.delete(id); continue; }
      void at;
      ctx.save();
      ctx.globalAlpha = (1 - t) * 0.9;
      ctx.translate(ox + ghost.tx * TILE_PX, oy + ghost.ty * TILE_PX + TILE_PX * -0.35 * t);
      ctx.translate(TILE_PX / 2, TILE_PX / 2);
      ctx.scale(1 - 0.35 * t, 1 - 0.35 * t);
      ctx.translate(-TILE_PX / 2, -TILE_PX / 2);
      drawPerk(ctx, { type: ghost.type, bob: 0 });
      ctx.restore();
    }
    // What was on the board this frame becomes what to compare against next frame.
    for (const k of world.perks) {
      perkGone.set(k.id, { tx: k.tx, ty: k.ty, type: k.type, at: now });
    }
    for (const [id, ghost] of perkGone) {
      if (!perkLive.has(id) && now - ghost.at > PERK_POP_MS * 2) perkGone.delete(id);
    }
    perkLive.clear();

    /* Bombs, counting down in real time.
     *
     * A bomb bursts on the client when `world.tick` reaches its `at` - and `world.tick` only moves
     * when a snapshot lands, two ticks at a time. Reading it directly would step the countdown 15
     * times a second. So the time left is measured against that same tick, carried forward
     * smoothly by the time since it last changed and capped just short of the next one: the ring
     * and the fuse run continuously and still reach zero on the frame the blast appears. */
    if (world.tick !== bombClock.tick) { bombClock.tick = world.tick; bombClock.at = performance.now(); }
    const tickNow = world.tick + Math.min(1.95, (performance.now() - bombClock.at) / (world.tickMs || TICK_MS));
    const bombNow = performance.now();
    for (const b of world.bombs) {
      const owner = (b.o ?? b.owner) % 16;
      /* In quickly. A bomb used to exist from one frame to the next, which at sixteen players is
       * a board where things appear out of nothing - and the one thing a bomb has to communicate
       * is that somebody PUT it there. A tenth of a second of fade and a small squash-and-settle
       * says that; anything longer starts to read as lag on their input. Keyed off the id, like
       * the perks, so nothing has to be told and a reconnect simply shows the bomb. */
      if (!bombSeen.has(b.id)) bombSeen.set(b.id, bombNow);
      const pop = Math.min(1, (bombNow - bombSeen.get(b.id)) / BOMB_POP_MS);
      ctx.save();
      ctx.translate(ox + b.tx * TILE_PX, oy + b.ty * TILE_PX);
      if (pop < 1) {
        // Lands wide and settles: a bomb is a heavy thing set down, not a thing that grew.
        const squash = 1 + Math.sin(pop * Math.PI) * 0.18;
        ctx.globalAlpha = pop;
        ctx.translate(TILE_PX / 2, TILE_PX / 2);
        ctx.scale(squash * (0.7 + 0.3 * pop), (2 - squash) * (0.7 + 0.3 * pop));
        ctx.translate(-TILE_PX / 2, -TILE_PX / 2);
      }
      drawBombLive(ctx, baked.bombs[seatSlot(owner)], {
        leftS: Math.max(0, b.at - tickNow) / TICK_HZ,
        fullS: FUSE_TICKS / TICK_HZ,
        colorIndex: owner,
        // Reach, for the pips under it. `r` on the wire; `radius` when it came from a welcome.
        radius: b.r ?? b.radius ?? 0,
        t: seaT + b.id * 0.37,
      });
      ctx.restore();
      ctx.globalAlpha = 1;
    }
    // Ids only ever grow, so the record of what has been seen would too.
    if (bombSeen.size > 64) {
      const live = new Set(world.bombs.map(b => b.id));
      for (const id of bombSeen.keys()) if (!live.has(id)) bombSeen.delete(id);
    }

    /* The light first, then the flames. See BLAST_LIGHT_PX.
     *
     * It travels, and it stops at walls.
     *
     * Each burning tile is a light. Its pool is drawn into a small scratch canvas, the SHADOW of
     * every solid tile within reach is punched out of that pool - a quad extruded away from the
     * light, the standard 2D shadow - and the face of each of those tiles that is turned toward
     * the light gets a warm line along it, which is the bounce. Then the finished light is
     * merged into the frame's light layer with `lighten`.
     *
     * Three things come out of that and all three are the point:
     *   - a corridor lights up along its length and the rooms either side of it stay dark;
     *   - a wall between you and a blast means you see the glow on ITS face and nothing past it;
     *   - the pools MERGE rather than stack. `lighten` takes the brighter of the two, so a keg -
     *     twenty-nine burning tiles - is as bright as one tile and no brighter, where adding
     *     them saturated the whole canvas to white.
     */
    if (world.fires.length) {
      // Two scratch canvases: the frame's light layer, and one light's worth.
      if (!lightLayer || lightLayer.width !== canvas.width || lightLayer.height !== canvas.height) {
        lightLayer = document.createElement('canvas');
        lightLayer.width = canvas.width;
        lightLayer.height = canvas.height;
        lightCtx = lightLayer.getContext('2d');
      }
      const lampPx = Math.ceil(BLAST_LIGHT_PX * 2 * view.dpr * zoom) + 4;
      if (!lampLayer || lampLayer.width !== lampPx) {
        lampLayer = document.createElement('canvas');
        lampLayer.width = lampPx;
        lampLayer.height = lampPx;
        lampCtx = lampLayer.getContext('2d');
      }
      const lc = lightCtx, mc = lampCtx;
      lc.setTransform(1, 0, 0, 1, 0, 0);
      lc.clearRect(0, 0, lightLayer.width, lightLayer.height);
      lc.setTransform(view.dpr * zoom, 0, 0, view.dpr * zoom, 0, 0);
      lc.globalCompositeOperation = 'lighten';

      const map = world.map;
      const R = BLAST_LIGHT_PX;
      const reach = Math.ceil(R / TILE_PX);
      let lit = false;
      for (const f of world.fires) {
        const age = Math.min(1, 1 - Math.max(0, (f.until - tickNow) / FIRE_TICKS));
        // Two frames up, then down. Slower than the flames, so the walls are still warm as the
        // fire thins out rather than going dark under it.
        /* A fifth slower again on the way down, and only the LIGHT - the flames keep their own
         * timing. The walls holding the glow a beat after the fire has started to thin is what
         * firelight actually does, and it is also the half of the effect you see with your
         * peripheral vision rather than by looking at it. */
        const k = age < 0.07 ? age / 0.07 : Math.max(0, 1 - (age - 0.07) / 0.83);
        if (k <= 0) continue;
        // Board coordinates for the geometry, screen for where the finished lamp lands.
        const cx = (f.tx + 0.5) * TILE_PX, cy = (f.ty + 0.5) * TILE_PX;
        const sx = ox + cx, sy = oy + cy;
        // Off-screen lights cost the same to build as on-screen ones and show nothing.
        if (sx < -R || sy < -R || sx > vw + R || sy > vh + R) continue;
        lit = true;

        // One light, in its own little canvas, centred.
        mc.setTransform(1, 0, 0, 1, 0, 0);
        mc.clearRect(0, 0, lampPx, lampPx);
        mc.setTransform(view.dpr * zoom, 0, 0, view.dpr * zoom, 0, 0);
        const mid = lampPx / (2 * view.dpr * zoom);
        mc.save();
        mc.translate(mid, mid);

        mc.globalCompositeOperation = 'source-over';
        mc.globalAlpha = k * k * (f.kind === 'core' ? 1 : 0.7);
        // The light is the same fire at the other end of the room, so it is the same hue: the
        // wall two tiles away warms in the colour of whoever lit the blast. One cached gradient
        // per seat; see blastLightFor.
        mc.fillStyle = blastLightFor(f.owner ?? -1);
        mc.beginPath();
        mc.arc(0, 0, R, 0, 7);
        mc.fill();


        // The walls in range, as shadows and as lit faces.
        for (let ty = f.ty - reach; ty <= f.ty + reach; ty++) {
          for (let tx = f.tx - reach; tx <= f.tx + reach; tx++) {
            if (tx === f.tx && ty === f.ty) continue;
            if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h) continue;
            const t = cellType(map.cells[ty * map.w + tx]);
            if (BLOCK_WALKABLE(t, false) || t === BLOCK.WATER) continue;
            // Tile corners, relative to the light.
            const ax = tx * TILE_PX - cx, ay = ty * TILE_PX - cy;
            const bx = ax + TILE_PX, by = ay + TILE_PX;
            if (Math.hypot(ax + TILE_PX / 2, ay + TILE_PX / 2) > R + TILE_PX) continue;
            const pts = [[ax, ay], [bx, ay], [bx, by], [ax, by]];
            /* The silhouette: the two corners furthest apart by angle. Sorting by angle is the
             * textbook way and it breaks across the -pi/pi seam; comparing every pair is sixteen
             * comparisons on four points and has no seam at all. */
            let p0 = pts[0], p1 = pts[1], widest = -1;
            for (const u of pts) {
              for (const v of pts) {
                const cross = u[0] * v[1] - u[1] * v[0];
                const dot = u[0] * v[0] + u[1] * v[1];
                const ang = Math.abs(Math.atan2(cross, dot));
                if (ang > widest) { widest = ang; p0 = u; p1 = v; }
              }
            }
            const far = R * 2.4;
            const ext = q => {
              const d = Math.hypot(q[0], q[1]) || 1;
              return [(q[0] / d) * far, (q[1] / d) * far];
            };
            const e0 = ext(p0), e1 = ext(p1);
            mc.globalCompositeOperation = 'destination-out';
            mc.globalAlpha = 1;
            mc.fillStyle = '#000';
            mc.beginPath();
            mc.moveTo(p0[0], p0[1]);
            mc.lineTo(e0[0], e0[1]);
            mc.lineTo(e1[0], e1[1]);
            mc.lineTo(p1[0], p1[1]);
            mc.closePath();
            mc.fill();

            /* The bounce: the face turned toward the light, picked out warm.
             *
             * It is drawn ON the silhouette edge, which the shadow quad starts from rather than
             * covers, so the wall itself reads as catching the light while everything behind it
             * does not. This is the part that makes a blast round a corner look like a blast
             * round a corner instead of a sticker of one. */
            const dist = Math.hypot(ax + TILE_PX / 2, ay + TILE_PX / 2);
            // Falls off with the square root of the distance rather than linearly, so a wall four
            // tiles down a corridor still catches something - a linear falloff put all of the
            // bounce on the two tiles beside the blast and nothing past them, which is the
            // opposite of what a corridor does with light.
            const bounce = Math.max(0, 1 - Math.sqrt(dist / R)) * k;
            if (bounce > 0.02) {
              mc.globalCompositeOperation = 'lighter';
              mc.globalAlpha = Math.min(0.72, bounce * 0.95);
              mc.strokeStyle = 'rgba(255,190,110,0.95)';
              mc.lineWidth = 3.6;
              mc.beginPath();
              mc.moveTo(p0[0], p0[1]);
              mc.lineTo(p1[0], p1[1]);
              mc.stroke();
            }
          }
        }
        mc.restore();

        // Into the frame's layer, where it merges with every other light rather than adding.
        lc.globalAlpha = 1;
        lc.drawImage(lampLayer, sx - mid, sy - mid, mid * 2, mid * 2);
      }

      if (lit) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = BLAST_LIGHT_ALPHA;
        ctx.drawImage(lightLayer, 0, 0, vw, vh);
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }

    // Fire over the bombs that made it, under the people it is about to kill.
    // On the smoothed tick, not the snapshot tick: world.tick moves two at a time, fifteen times a
    // second, which held every blast on the same picture for four frames at a time.
    for (const f of world.fires) {
      const age = Math.min(1, 1 - Math.max(0, (f.until - tickNow) / FIRE_TICKS));
      ctx.save();
      ctx.translate(ox + f.tx * TILE_PX, oy + f.ty * TILE_PX);
      // Whose it is, in the flames themselves - see fireTones in art.js. A keg inherits whoever
      // set it off, so a player's own keg burns in the player's own fire.
      drawFire(ctx, {
        kind: f.kind, rot: f.rot, age, t: seaT, seed: f.tx * 7 + f.ty * 13, owner: f.owner ?? -1,
      });
      ctx.restore();
    }

    // Y-sorted so someone below overlaps someone above.
    const alive = world.players.filter(Boolean).sort((a, b) => a.ry - b.ry);
    for (const p of alive) drawTracer(ctx, p, ox, oy);
    /* Every shadow before every player, not a shadow-then-player pair each.
     *
     * Two passes, because with one pass a player standing below another would paint over the
     * other's shadow - and a shadow that disappears when somebody walks past it is worse than
     * no shadow. All the shadows belong to the floor; all the players stand on top of them. */
    drawSunShadows(alive, ox, oy);
    // Dust is in the air but below the people: slide trails and whatever is left of whoever
    // died. Before the sprites, so a pirate is never drawn behind their own dust.
    trackSlides(ox, oy, dtMs);
    drawDust(ox, oy, dtMs);
    // Gulls on the same clock the bombs count down on, which is the clock the fire is drawn on:
    // the bird is drawn exactly where a blast would have to catch it.
    gullT = tickNow;
    trackGulls(tickNow);
    drawGullShadows(ox, oy, tickNow);
    for (const p of alive) drawOne(ctx, p, ox, oy, p.i === world.you);

    drawAim(ox, oy, dtMs);
    for (const p of alive) drawTipsy(ctx, p, ox, oy);
    for (const p of alive) drawConfused(ctx, p, ox, oy);
    for (const p of alive) drawStamina(ctx, p, ox, oy);
    // Smoke drifts over the players - it is in the air - but under the pickup labels and the
    // gulls, which have to stay readable.
    drawSmoke(ox, oy, dtMs);
    drawFloaters(ox, oy, dtMs);
    // Over everything on the island: they are in the air. Under the speech bubbles, which are
    // interface rather than world.
    drawGulls(ox, oy, tickNow, dtMs);
    // The payout, over the gull that just dropped it and over the player it is flying to.
    drawCoinFlights(ox, oy, dtMs);
    // Last of the things that live over a player, and the only one in screen space - it resets
    // the transform itself and puts it back. Without this call the bubbles are built and then
    // never painted, which is exactly how they went missing.
    // It saves and restores around its own transform, so the board transform survives the call.
    drawSays(ox, oy, zoom);

    drawRadarRim(ox, oy, vw, vh, dtMs, zoom);

    /* A vignette that breathes with the music, drawn last so it sits over everything.
     *
     * Two jobs at once, which is why it earns the fill. Flat, it does what every vignette does:
     * darkens the corners so the eye goes to the middle, where you are. Breathing, it is the
     * only reactive thing on screen that touches the WHOLE frame - the coast glows and the
     * shallows light, but all of that is out at the edges and none of it reaches the board. A
     * kick squeezes the picture very slightly, everywhere.
     *
     * Deliberately tiny. The range is 0.30 to about 0.40 of a corner that is already dark, which
     * is at the edge of noticeable in a still frame and the right amount while moving - the
     * ailure mode of a reactive vignette is a screen that pumps, and a pumping screen in a game
     * you are trying to read is unplayable.
     *
     * Cached per view: a radial gradient is cheap but not free, and this one only changes when
     * the board is resized.
     */
    const squeeze = mood.beat * 0.11 + mood.bass * 0.06;
    if (vignetteFor !== `${vw}x${vh}`) {
      vignetteFor = `${vw}x${vh}`;
      const vg = ctx.createRadialGradient(vw / 2, vh / 2, Math.min(vw, vh) * 0.34,
        vw / 2, vh / 2, Math.max(vw, vh) * 0.78);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(0.65, 'rgba(4,7,12,0.22)');
      vg.addColorStop(1, 'rgba(2,4,8,0.62)');
      vignette = vg;
    }
    ctx.globalAlpha = 0.8 + squeeze * 0.45;
    ctx.fillStyle = vignette;
    ctx.fillRect(-4, -4, vw + 8, vh + 8);
    ctx.globalAlpha = 1;

    if (flash > 0.004) {
      ctx.fillStyle = `rgba(${flashColour},${flash * 0.5})`;
      ctx.fillRect(-4, -4, vw + 8, vh + 8);
      flash *= Math.exp(-dtMs / 110);
    } else flash = 0;

    if (performance.now() - redrawWindow > 1000) { redrawWindow = performance.now(); redrawsThisSecond = 0; }
  }

  /* ─── the rim ────────────────────────────────────────────────────────────────
   *
   * The island's border, drawn dark, with one lit slither of it tracking the player.
   *
   * The edge of the playing ground was a line that did nothing, and it is the only part of the
   * screen that is always in peripheral vision. So it is a dark band now - a frame the board
   * sits inside rather than a line it stops at - and exactly one short stretch of that band is
   * lit: the stretch nearest you, fading out along the border in both directions.
   *
   * It reads as a position rather than as a decoration, which is the point. Where the lit part
   * sits IS where you are against the edge of the island, and at the zoom floor, with the board
   * bigger than the window, that is the only thing on screen that says so.
   *
   * Two more things ride on it, and both are the same light rather than new furniture:
   *   SOUND   the slither breathes with the music - longer and brighter on the level, a lift on
   *           every beat. The sea and the coast already do this; the rim joining in costs one
   *           multiply and keeps the whole frame on one pulse.
   *   DAMAGE  the entire border goes red and beats for a second when something takes a shield or
   *           takes you. A hit is otherwise told by a flash that is over in a tenth of a second.
   */
  const RIM_PX = 6;               // the dark band, in CSS pixels, whatever the zoom
  const RIM_RADIUS_PX = 8;        // the canvas's own corner radius; see canvas#game in style.css
  const RIM_LIT_PX = 170;         // how much of the border your own slither covers, before music
  const RIM_BLIP_PX = 84;         // and how much somebody else's does (was 54: too easy to miss)
  const RIM_BLIPS = 4;            // never more than four of them
  const RIM_ALERT_S = 1.1;        // how long a hit keeps the border red
  const RIM_BLIP_FOLLOW_MS = 140; // how fast a blip follows its player along the border
  const RIM_BLIP_FADE_MS = 220;   // how fast a blip fades in or out of the nearest few
  const RIM_TRACK_PAD = 0.5;      // tiles between the island's edge and the radar track
  const RIM_TRACK_RADIUS = 3.5;   // the track's corner radius, in tiles - a racetrack, not a frame
  /* Per-seat blip state: where it is along the border, how visible, and its own pulse phase.
   *
   * State, because a blip computed fresh every frame jittered. Its position came from the nearest
   * of 160 SAMPLES of the border - about 25 px apart on a wide board, so a walking player's blip
   * hopped in steps - nothing eased it, and the "nearest three" were re-sorted every frame, so
   * two players at similar range swapped places, popped in and out and traded pulse phases. Now
   * the position is exact and eased along the border, membership fades rather than pops, and the
   * phase belongs to the seat. */
  const rimBlips = new Map();
  // Everybody else, on the rim and round their sprite: one maroon. See drawEdge.
  const FOE_RED = 'rgb(178,34,58)';
  let rimTotalWas = 0;
  let rimAlert = 0;               // 1 at the moment of the hit, decaying
  let rimAt = -1;                 // where your slither is, in pixels along the perimeter
  let rimBend = 0;                // 0 on a straight, 1 mid-corner; eased, drives the stretch
  const RIM_CORNER_EASE = 26;     // how far either side of an arc the slow zone reaches

  const rimCorner = (cx, cy, ang, r) => [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r];

  /**
   * A walk around a rounded rectangle: distance clockwise from the start of the top edge.
   *
   * The frame is the CANVAS, corners and all, so the maths has to know about the corners - a
   * sharp-cornered perimeter laid over a rounded one puts the light outside the canvas at four
   * places, which is precisely where it is most visible. Eight runs: four straight, four arcs.
   */
  function rimPath(x0, y0, w, h, r) {
    const sw = w - 2 * r, sh = h - 2 * r;         // straight length of each side
    const arc = (Math.PI / 2) * r;                // length of one quarter turn
    const runs = [sw, arc, sh, arc, sw, arc, sh, arc];
    const total = runs.reduce((n, v) => n + v, 0);
    const at = t => {
      let d = ((t % total) + total) % total;
      let i = 0;
      while (d > runs[i]) { d -= runs[i]; i++; }
      const f = runs[i] ? d / runs[i] : 0;
      switch (i) {
        case 0: return [x0 + r + d, y0];
        case 1: return rimCorner(x0 + w - r, y0 + r, -Math.PI / 2 + f * (Math.PI / 2), r);
        case 2: return [x0 + w, y0 + r + d];
        case 3: return rimCorner(x0 + w - r, y0 + h - r, f * (Math.PI / 2), r);
        case 4: return [x0 + w - r - d, y0 + h];
        case 5: return rimCorner(x0 + r, y0 + h - r, Math.PI / 2 + f * (Math.PI / 2), r);
        case 6: return [x0, y0 + h - r - d];
        default: return rimCorner(x0 + r, y0 + r, Math.PI + f * (Math.PI / 2), r);
      }
    };
    /** Which of the eight runs a distance falls in; the odd ones are the four corners. */
    const runAt = t => {
      let d = ((t % total) + total) % total;
      let i = 0;
      while (i < runs.length - 1 && d > runs[i]) { d -= runs[i]; i++; }
      return i;
    };
    /* The exact nearest point on the border to a point on the board, as a distance along it.
     *
     * Exact rather than sampled: continuous in the point, so a player walking moves their light
     * smoothly instead of in steps. Inside a corner's square it is the angle round that corner's
     * arc; anywhere else it is the nearest straight side, clamped to that side's straight part. */
    const c1 = sw, c2 = c1 + arc, c3 = c2 + sh, c4 = c3 + arc, c5 = c4 + sw, c6 = c5 + arc, c7 = c6 + sh;
    const L = x0 + r, R = x0 + w - r, T = y0 + r, B = y0 + h - r;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const project = (qx, qy) => {
      const px = clamp(qx, x0, x0 + w), py = clamp(qy, y0, y0 + h);
      const H = Math.PI / 2;
      if (px > R && py < T) return c1 + clamp(Math.atan2(py - T, px - R) + H, 0, H) * r;
      if (px > R && py > B) return c3 + clamp(Math.atan2(py - B, px - R), 0, H) * r;
      if (px < L && py > B) return c5 + clamp(Math.atan2(py - B, px - L) - H, 0, H) * r;
      if (px < L && py < T) {
        const a = Math.atan2(py - T, px - L);
        return c7 + clamp((a < 0 ? a + 2 * Math.PI : a) - Math.PI, 0, H) * r;
      }
      const dT = py - y0, dR = x0 + w - px, dB = y0 + h - py, dL = px - x0;
      const m = Math.min(dT, dR, dB, dL);
      if (m === dT) return clamp(px - L, 0, sw);
      if (m === dR) return c2 + clamp(py - T, 0, sh);
      if (m === dB) return c4 + clamp(R - px, 0, sw);
      return c6 + clamp(B - py, 0, sh);
    };
    return { total, at, runAt, project };
  }

  function drawRadarRim(ox, oy, vw, vh, dtMs, zoom) {
    const me = world.me();
    // CSS pixels over the zoom, so the band is the same thickness on screen whether the board is
    // scaled up on a big window or down at the zoom floor.
    const bw = RIM_PX / zoom;
    const r = RIM_RADIUS_PX / zoom;
    const x0 = bw / 2, y0 = bw / 2, w = vw - bw, h = vh - bw;
    if (w <= 2 * r || h <= 2 * r) return;

    if (rimAlert > 0) rimAlert = Math.max(0, rimAlert - (dtMs / 1000) / RIM_ALERT_S);
    const dead = !!me && !me.alive;

    // The dark band: the frame of the board, exactly where and what it always was. It is still
    // what carries the hit and death states below - only the moving lights left it.
    ctx.save();
    ctx.lineWidth = bw;
    ctx.strokeStyle = 'rgba(6,10,16,0.85)';
    ctx.beginPath();
    ctx.roundRect(x0, y0, w, h, r);
    ctx.stroke();

    /* ─── the track: the radar, moved in to hug the island ───
     *
     * The lights used to run round the CANVAS, which on a wide window is a long way from the
     * fight - two or three tiles of open sea between the coast and the frame, so glancing from
     * your pirate to "where is he" crossed all of it. Now they run on a track of their own, laid
     * through the shallows half a tile off the coast, with corners rounded to RIM_TRACK_RADIUS -
     * a racetrack round the island rather than a picture frame round the screen. Closer to every
     * player, and the big radius means a light slides round a corner instead of turning on it.
     *
     * Nothing about the board changes: the frame band stays, the sea and coast are untouched,
     * and the track itself is only a hairline so the lights have something to run along. Where
     * the island is bigger than the window (the zoom floor) the track is clamped inside the
     * canvas, and the radar falls back to riding the edge - which is the only place it can be. */
    const [lx, ly, lw, lh] = landBounds();
    const pad = TILE_PX * RIM_TRACK_PAD, inset = bw * 1.5;
    const tx0 = Math.max(inset, ox + lx * TILE_PX - pad);
    const ty0 = Math.max(inset, oy + ly * TILE_PX - pad);
    const tx1 = Math.min(vw - inset, ox + (lx + lw) * TILE_PX + pad);
    const ty1 = Math.min(vh - inset, oy + (ly + lh) * TILE_PX + pad);
    const tw = tx1 - tx0, th = ty1 - ty0;
    const tr = Math.min(TILE_PX * RIM_TRACK_RADIUS, tw / 2 - 1, th / 2 - 1);
    if (tw <= 2 * tr || th <= 2 * tr || tr <= 0) { ctx.restore(); return; }
    const rim = rimPath(tx0, ty0, tw, th, tr);
    ctx.lineWidth = Math.max(1, bw * 0.25);
    ctx.strokeStyle = 'rgba(6,10,16,0.32)';
    ctx.beginPath();
    ctx.roundRect(tx0, ty0, tw, th, tr);
    ctx.stroke();
    ctx.lineWidth = bw;

    /** One stretch of the border, lit, centred on `mid` and fading to nothing at both ends. */
    const slither = (mid, halfLen, peak, colour, steps) => {
      const step = (halfLen * 2) / steps;
      ctx.strokeStyle = colour;
      for (let i = 0; i < steps; i++) {
        const k = 1 - Math.abs((i + 0.5) / steps * 2 - 1);
        ctx.globalAlpha = peak * k * k;
        const [ax, ay] = rim.at(mid - halfLen + i * step);
        const [bx, by] = rim.at(mid - halfLen + (i + 1) * step);
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };

    /** Where on the border a point on the board is: its exact nearest point. See rimPath. */
    const nearestAt = (wx, wy) => rim.project(wx, wy);
    /* The track's length changes with a resize, and - while it is clamped to the canvas - as the
     * camera follows you. Stored positions are rescaled rather than thrown away: clearing them
     * whenever the length moved would wipe every blip on every frame the camera did. */
    if (rimTotalWas > 0 && rim.total !== rimTotalWas) {
      const k = rim.total / rimTotalWas;
      for (const b of rimBlips.values()) b.at = (b.at * k) % rim.total;
      if (rimAt >= 0) rimAt = (rimAt * k) % rim.total;
    }
    rimTotalWas = rim.total;

    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'butt';

    /* Everybody else: the nearest few, clearly but never louder than you.
     *
     * Four at most, nearest first. They are a hint that somebody is over there, not a map: a
     * border lit in sixteen places says nothing at all, and the one thing that has to survive
     * on this frame is where YOU are. But a hint has to be SEEN to be a hint, and at a peak of
     * a sixth of an alpha over a few dozen pixels they mostly were not - so they are longer,
     * brighter, and carry a hot thread down the middle that holds up against bright water.
     */
    if (me) {
      const fade = 1 - Math.exp(-dtMs / RIM_BLIP_FADE_MS);
      const follow = 1 - Math.exp(-dtMs / RIM_BLIP_FOLLOW_MS);
      const ranked = world.players
        .filter(q => q && q.alive && q.i !== world.you)
        .map(q => ({ q, d: Math.hypot(q.rx - me.rx, q.ry - me.ry) }))
        .sort((m, n) => m.d - n.d);
      const shown = new Set(ranked.slice(0, RIM_BLIPS).map(o => o.q.i));
      // Anybody who left the room, or died, fades out from where they were.
      for (const [seat, b] of rimBlips) {
        if (!ranked.some(o => o.q.i === seat)) {
          b.vis += (0 - b.vis) * fade;
          if (b.vis < 0.01) rimBlips.delete(seat);
        }
      }
      for (const { q, d } of ranked) {
        let b = rimBlips.get(q.i);
        const want = nearestAt(ox + (q.rx / UNITS_PER_TILE) * TILE_PX, oy + (q.ry / UNITS_PER_TILE) * TILE_PX);
        if (!b) {
          if (!shown.has(q.i)) continue;
          // A stable phase per seat, so two blips never share a pulse and never swap one.
          b = { at: want, vis: 0, d, ph: (q.i * 2.39996) % (Math.PI * 2) };
          rimBlips.set(q.i, b);
        }
        b.vis += ((shown.has(q.i) ? 1 : 0) - b.vis) * fade;
        b.d += (d - b.d) * follow;
        // Eased along the border the short way round, so a turn of a corner is a slide.
        const delta = ((want - b.at + rim.total * 1.5) % rim.total) - rim.total / 2;
        b.at = (b.at + delta * follow + rim.total) % rim.total;
      }
      for (const b of rimBlips.values()) {
        if (b.vis < 0.01) continue;
        /* A blip says how close they are, not who they are.
         *
         * Distance is the only thing about another player that is worth a light on the frame
         * while you are busy, so it is what every property of the blip is wired to: the colour
         * runs from cold blue at the far end of the island to alarm red inside two tiles, and
         * the pulse quickens as it reddens. The pulse moves BRIGHTNESS only, and gently - it
         * used to stretch the blip's length too, fast when close, which read as jitter.
         *
         * Not their own colour: sixteen hues on one dark band is a fruit salad, half of them
         * are the orange of the fire, and "who" is a question the scoreboard answers. */
        const tiles = b.d / UNITS_PER_TILE;
        const near = Math.max(0, Math.min(1, 1 - (tiles - 2) / 9));
        b.ph += (dtMs / 1000) * (2.2 + 5 * near);
        const pulse = 0.82 + 0.18 * Math.sin(b.ph);
        const sound = 1 + mood.beat * 0.3;
        /* One colour for everybody else: maroon. Distance still drives brightness, length and
         * pulse, but not hue - a blue-to-red scale on the frame read as players' colours, and
         * "that is somebody else" is the one thing a blip has to say. */
        const colour = FOE_RED;
        const half = ((RIM_BLIP_PX / 2) / zoom) * (1 + 0.3 * near);
        /* PAINTED, not added. Everything else on the rim is additive light, and that is right
         * for a bright colour - but maroon added at partial alpha onto a near-black band comes
         * out as a slightly less black band, and the blips disappeared the moment they went
         * maroon. Normal blending at a high alpha makes them the maroon they are meant to be. */
        const peak = Math.min(1, (0.78 + 0.22 * near) * pulse * sound) * b.vis;
        ctx.globalCompositeOperation = 'source-over';
        ctx.lineWidth = bw;
        slither(b.at, half, peak, colour, 16);
        // The thread: a narrower, paler line down the middle, which keeps the blip legible over
        // bright water, where a dark red on its own would read as a gap in the frame.
        ctx.lineWidth = bw * 0.4;
        slither(b.at, half * 0.6, peak * 0.85, 'rgb(236,112,128)', 10);
      }
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = bw;
    }

    if (me) {
      const px = ox + (me.rx / UNITS_PER_TILE) * TILE_PX;
      const py = oy + (me.ry / UNITS_PER_TILE) * TILE_PX;
      const want = nearestAt(px, py);
      // Eased ALONG the border, the short way round, so rounding a corner slides the light round
      // it rather than throwing it across the frame.
      if (rimAt < 0) rimAt = want;
      else {
        const delta = ((want - rimAt + rim.total * 1.5) % rim.total) - rim.total / 2;
        /* Much slower through the corners, and the zone starts before the corner does.
         *
         * A corner is where the border turns fastest and where the light travels furthest for
         * the least movement from you, so at the straights' follow rate it whipped round the
         * arc and snapped out the far side - in the one place on the frame the eye is already
         * watching. Seven times the time constant takes that whip and makes it a long slide
         * around the bend, and the zone reaches half a corner's length past each arc so the
         * light is already slowing as it arrives rather than braking on the turn.
         *
         * The straights keep the quick follow. That contrast is the effect: quick where the
         * border is a line, unhurried where it is a curve. */
        const cornerNear = t => {
          if (rim.runAt(t) % 2 === 1) return true;
          const lead = rim.runAt(t + RIM_CORNER_EASE) % 2 === 1;
          return lead || rim.runAt(t - RIM_CORNER_EASE) % 2 === 1;
        };
        const corner = cornerNear(rimAt) || cornerNear(want);
        rimAt = (rimAt + delta * (1 - Math.exp(-dtMs / (corner ? 700 : 90))) + rim.total) % rim.total;
        rimBend += ((corner ? 1 : 0) - rimBend) * (1 - Math.exp(-dtMs / 180));
      }

      // The music: longer and brighter on the level, a lift on every beat. The same two numbers
      // the sea and the coast move on, so the whole frame shares one pulse.
      const lift = 1 + mood.level * 0.35 + mood.beat * 0.25;
      // And it stretches as it goes round: a light taking a long bend reads as being drawn
      // out by the turn, where one that keeps its length reads as having stalled on it.
      const half = Math.min(rim.total / 2, ((RIM_LIT_PX / 2) * lift * (1 + 0.45 * rimBend)) / zoom);
      /* Your own colour, the one your pirate is painted in.
       *
       * Sixteen players, sixteen colours, and yours is the one you have been looking at all
       * round - so the light on the frame needs no explaining at all: that is me, over there.
       * It is also the one hue on the frame that cannot be a blip, because the blips are a
       * blue-to-red distance scale and nothing else. Red while you are down.
       */
      const mine = playerShades(me.i).light;
      // A touch brighter than it was (0.72 -> 0.84 at rest), plus the same hot thread the blips
      // carry, so it still outranks them now that they are easier to see.
      const peak = Math.min(1, 0.84 * (0.72 + 0.28 * lift));
      slither(rimAt, half, peak, dead ? '#ff3b4e' : mine, 26);
      if (!dead) {
        ctx.lineWidth = bw * 0.4;
        slither(rimAt, half * 0.6, peak * 0.6, '#ffffff', 16);
        ctx.lineWidth = bw;
      }
    }

    /* A hit takes the whole frame, because what is being reported has no direction.
     *
     * Two states, different on purpose. A shield or a wound beats red for a second and goes.
     * DEATH holds the frame in flat maroon for as long as you are down - the same maroon the
     * death card and the banner are built from - so the glance that tells you that you are out
     * of the round is the frame around it. */
    ctx.globalCompositeOperation = 'source-over';
    if (dead || rimAlert > 0) {
      const beat = 0.55 + 0.45 * Math.sin(seaT * 17);
      ctx.strokeStyle = dead
        ? 'rgba(128,30,50,0.92)'
        : 'rgba(214,40,46,' + (0.85 * rimAlert * beat).toFixed(3) + ')';
      ctx.lineWidth = bw;
      ctx.beginPath();
      ctx.roundRect(x0, y0, w, h, r);
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  // One coloured pip per active status, above the head. Statuses are contagious, so knowing at a
  // glance what the person running at you is carrying is most of playing around them.
  const PIPS = [
    [STATUS.PACIFISM, '#9aa6b5'], [STATUS.SLOWDOWN, '#5b7fd4'], [STATUS.INVISIBLE, '#b98fd9'],
    [STATUS.CHANGELING, '#d45b8f'], [STATUS.REDUCTION, '#5ad1a0'], [STATUS.FAST_DET, '#e8655a'],
  ];

  function drawStatusPips(c, p, px, py) {
    if (!(p.status & ~STATUS.INVULN)) return;
    let n = 0;
    for (const [bit, colour] of PIPS) {
      if (!(p.status & bit)) continue;
      c.fillStyle = colour;
      c.fillRect(px + 4 + n * 5, py - 14, 4, 4);
      n++;
    }
  }

  function drawTracer(c, p, ox, oy) {
    if (!p.trail.length || !p.alive) return;
    const k = playerShades(p.i);
    for (let n = 0; n < p.trail.length; n++) {
      const f = (n + 1) / TRACER_SAMPLES;
      const [x, y] = p.trail[n];
      c.globalAlpha = 0.1 + f * 0.3;
      c.beginPath();
      c.arc(ox + (x / UNITS_PER_TILE) * TILE_PX, oy + (y / UNITS_PER_TILE) * TILE_PX, 2 + f * 3, 0, 7);
      c.fillStyle = k.base;
      c.fill();
    }
    c.globalAlpha = 1;
  }

  /** A shockwave under an arriving player, in their own colour, so it says WHO as well as WHERE. */
  function drawSpawnRing(c, cx, cy, pop, i) {
    const t = (pop - 1) / (SPAWN_POP_SCALE - 1);     // 1 at the moment of arrival, 0 when settled
    const k = playerShades(i);
    c.save();

    // An expanding ring that runs the opposite way to the sprite: the pirate collapses inwards
    // while the shockwave races outwards, and the two moving apart is what reads as an impact
    // rather than as a sprite being resized.
    const ring = TILE_PX * (0.4 + (1 - t) * 7);
    c.globalAlpha = t * 0.5;
    c.lineWidth = 2 + t * 6;
    c.strokeStyle = k.light;
    c.beginPath();
    c.arc(cx, cy, ring, 0, 7);
    c.stroke();

    // A second, faster ring, so the wave has an edge instead of being one fat band.
    c.globalAlpha = t * 0.28;
    c.lineWidth = 1 + t * 2;
    c.beginPath();
    c.arc(cx, cy, ring * 1.45, 0, 7);
    c.stroke();

    // The glow under the sprite itself, which stays tied to how big the sprite still is.
    c.globalAlpha = t * 0.2;
    c.fillStyle = k.base;
    c.beginPath();
    c.arc(cx, cy, TILE_PX * 0.5 * Math.min(pop, 6), 0, 7);
    c.fill();

    c.restore();
    c.globalAlpha = 1;
  }

  /* Players, in the sun. The rocks and the boat get theirs where they are drawn.
   *
   * The silhouette is baked (see `playerShadows` in art.js) and simply blitted at the sun's
   * offset - no filter, no per-frame compositing, one drawImage each. Squashed vertically on
   * the way down, because a shadow on the ground is a projection of an upright thing and an
   * unsquashed copy reads as a second player lying underneath the first.
   */
  /* A speech bubble over somebody's head.
   *
   * Drawn in SCREEN space, not board space - the board is scaled to fit the island and at the
   * zoom floor that is about two thirds, which would make text unreadable exactly when the
   * board is busiest. The anchor is converted up to screen pixels and the bubble drawn at its
   * natural size there.
   *
   * It follows the player while it is up, because a bubble pinned to where somebody WAS is a
   * bubble pointing at nothing by the time you look at it.
   */
  /* Greedy word wrap against the CURRENT font - so the caller sets the font first.
   *
   * A word longer than the whole line (a pasted URL, sixteen w's) is left to overhang its line
   * rather than broken mid-word: the box is measured off the widest line either way, so the
   * bubble still fits it, and a mid-word break is harder to read than a wide line is.
   */
  function wrap(text, max) {
    const out = [];
    let line = '';
    for (const word of text.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > max) { out.push(line); line = word; }
      else line = next;
    }
    if (line) out.push(line);
    return out;
  }

  function drawSays(ox, oy, zoom) {
    if (!says.size) return;
    const now = performance.now();
    ctx.save();
    // Out of the board transform and into screen pixels.
    ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const [i, s] of says) {
      if (s.until <= now) { says.delete(i); continue; }
      const p = world.players[i];
      if (!p || !p.alive) { says.delete(i); continue; }

      const bx = (ox + (p.rx / UNITS_PER_TILE) * TILE_PX) * zoom;
      const by = (oy + (p.ry / UNITS_PER_TILE) * TILE_PX - TILE_PX * 0.95) * zoom;

      // In fast, out slow, and it rises as it goes - the same shape as the floating pickup
      // text, so everything that appears over a player behaves the same way.
      const left = s.until - now;
      const age = SAY_MS - left;
      const inT = Math.min(1, age / 110);
      const outT = Math.min(1, left / 420);
      const a = inT * outT;
      if (a <= 0.01) continue;
      const rise = (1 - outT) * 10;

      // Emoji need a slightly bigger box than words do; a single glyph in a word-sized bubble
      // looks like a mistake. Both are measured rather than guessed.
      const emoji = s.emoji;
      ctx.font = emoji
        ? '19px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", system-ui, sans-serif'
        : '600 10px ui-sans-serif, system-ui, sans-serif';
      /* Wrapped NARROW - 92px, about three words a line.
       *
       * A bubble is read out of the corner of your eye while something is chasing you, and a
       * wide one spreads across the board covering the two tiles either side of the speaker,
       * which is exactly where the thing chasing you is. Taller is cheap; wider is not. */
      const lines = emoji ? [s.text] : wrap(s.text, 92);
      let tw = 0;
      for (const ln of lines) tw = Math.max(tw, ctx.measureText(ln).width);
      const LINE = 12;
      const w = tw + (emoji ? 14 : 16);
      const h = emoji ? 28 : lines.length * LINE + 8;
      const x = bx, y = by - rise;

      ctx.globalAlpha = a;
      // The bubble, then the tail, as one path - a tail drawn separately shows its own outline
      // where it meets the body.
      ctx.beginPath();
      ctx.roundRect(x - w / 2, y - h, w, h, 7);
      ctx.moveTo(x - 5, y - 1);
      ctx.lineTo(x, y + 6);
      ctx.lineTo(x + 5, y - 1);
      ctx.closePath();
      /* An emote gets a DARK bubble; words keep the white one.
       *
       * An emoji is a picture, not a glyph: it brings its own colours, and most of them are
       * bright - a yellow face on near-white is two light things on top of each other and the
       * shape disappears at the size this is drawn. Tinting or outlining it is not an option
       * either, because the glyph is a bitmap the font owns. So the background moves instead.
       * Words go the other way: dark text on white is what makes them readable. */
      ctx.fillStyle = emoji ? '#131a24f2' : '#f4f7fbee';
      ctx.fill();
      ctx.strokeStyle = emoji ? '#ffffff44' : '#0b0f16aa';
      ctx.lineWidth = 1;
      ctx.stroke();

      ctx.fillStyle = '#16202b';
      if (emoji) ctx.fillText(s.text, x, y - h / 2 + 1);
      else for (const [n, ln] of lines.entries()) {
        ctx.fillText(ln, x, y - h + 4 + LINE * (n + 0.5));
      }
    }
    ctx.restore();
  }

  function drawSunShadows(alive, ox, oy) {
    const set = baked.playerShadows;
    if (!set || !set.length) return;
    const { dx, dy } = sunVec();
    ctx.save();
    clipToFloor(ox, oy);
    ctx.globalAlpha = SHADOW_ALPHA * 0.8;
    for (const p of alive) {
      if (!p.alive) continue;
      if ((p.status & STATUS.INVISIBLE) && p.i !== world.you) continue;
      const frame = p.moving ? ((world.tick >> 2) & 1) : 0;
      const img = set[p.dir * 2 + frame];
      if (!img) continue;
      const px = ox + (p.rx / UNITS_PER_TILE) * TILE_PX - TILE_PX / 2;
      const py = oy + (p.ry / UNITS_PER_TILE) * TILE_PX - TILE_PX / 2;
      ctx.save();
      // Anchored at the feet - a shadow is attached to where the thing touches the ground, so
      // the squash has to happen about that point rather than about the sprite's middle.
      ctx.translate(px + dx, py + TILE_PX * 0.72 + dy);
      ctx.scale(1, 0.55);
      ctx.drawImage(img, 0, -TILE_PX * 0.72);
      ctx.restore();
    }
    ctx.restore();
  }

  /* Shields, as a glowing blue border round the pirate: one ring per shield held.
   *
   * Counted, not just flagged. With two to hold, "has a shield" is not the question anyone
   * needs answered - "how many hits will it take" is, about yourself and about whoever you are
   * chasing. None is no ring at all; one is a single ring; two is a second, wider ring outside
   * it, turning slowly the other way so the pair never reads as one thick line. Each ring is a
   * soft glow under a thin bright edge, added rather than painted, and both breathe slowly.
   * Blue, not the green of the HUD pip, because it has to stand off every player colour and the
   * green is too close to half of them. */
  function drawShields(c, p, cx, cy) {
    const n = Math.min(MAX_SHIELDS, p.shields | 0);
    if (n <= 0) return;
    const breathe = 0.78 + 0.22 * Math.sin(seaT * 3.1 + p.i * 1.7);
    c.save();
    c.globalCompositeOperation = 'lighter';
    for (let k = 0; k < n; k++) {
      // Tight round the sprite: the first ring just clears it, the second sits a few pixels out.
      const r = TILE_PX * (0.5 + 0.11 * k);
      const turn = seaT * (k ? -0.9 : 0.6) + p.i;
      // The second ring is broken into arcs, so two rings read as two at a glance.
      const arcs = k ? 6 : 1;
      const gap = k ? 0.32 : 0;
      for (const [width, colour, alpha] of [
        [5, '64,150,255', 0.16], [2.5, '90,175,255', 0.3], [1.2, '190,228,255', 0.85],
      ]) {
        c.lineWidth = width;
        c.strokeStyle = `rgba(${colour},${alpha * breathe})`;
        c.beginPath();
        for (let a = 0; a < arcs; a++) {
          const from = turn + (a / arcs) * Math.PI * 2;
          const to = from + (Math.PI * 2) / arcs - gap;
          c.moveTo(cx + Math.cos(from) * r, cy + Math.sin(from) * r);
          c.arc(cx, cy, r, from, to);
        }
        c.stroke();
      }
    }
    c.restore();
  }

  /* Friend or foe, always on: half a pixel of white round the edge of your own pirate and half a
   * pixel of red round everybody else's. Sixteen coat colours tell you WHO; this tells you the
   * one thing that matters in the half second before a bomb goes down - is that me.
   *
   * It follows the sprite's own silhouette rather than sitting on a circle: a flat copy of the
   * sprite in the outline colour, drawn half a pixel out in each of the four directions behind
   * it, so only a hairline shows past the edge. The flat copies are made once per sprite and
   * colour and cached. Nothing while spectating, where nobody is an enemy. */
  /* The foe edge is the same maroon as their blips on the rim (FOE_RED), so the red round a pirate
   * and the red on the frame are visibly one signal. Both edges are 0.8 px now rather than half a
   * pixel, and fully opaque: at half a pixel they vanished at the zoom floor. */
  const ALLY_EDGE = '#ffffff', FOE_EDGE = FOE_RED;
  const EDGE_PX = 0.8;
  const silhouettes = new Map();      // sprite canvas -> { [colour]: canvas }
  function silhouette(sprite, colour) {
    let set = silhouettes.get(sprite);
    if (!set) silhouettes.set(sprite, set = {});
    if (set[colour]) return set[colour];
    const el = document.createElement('canvas');
    el.width = sprite.width; el.height = sprite.height;
    const g = el.getContext('2d');
    g.drawImage(sprite, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = colour;
    g.fillRect(0, 0, el.width, el.height);
    return (set[colour] = el);
  }

  /** The outline, at (x, y) in the same space and size the sprite is about to be drawn in. */
  function drawEdge(c, sprite, x, y, isMe) {
    if (world.you < 0) return;
    const sil = silhouette(sprite, isMe ? ALLY_EDGE : FOE_EDGE);
    for (const [dx, dy] of [[EDGE_PX, 0], [-EDGE_PX, 0], [0, EDGE_PX], [0, -EDGE_PX]]) {
      c.drawImage(sil, x + dx, y + dy, TILE_PX, TILE_PX);
    }
  }

  /* ─── half health, on the body ───
   *
   * Only two states exist (see MAX_HP), so the indicator is not a bar - a bar for two states is a
   * light switch drawn as a gauge. It is the pirate himself: at half health the LOWER HALF of him
   * is charred. The picture is the number - half of him is burned, so he has half left - and
   * because it is on the sprite it reads on every player at once, in the crowd, without anyone
   * looking anywhere but at the fight. Smoke curls off his head and a few embers glow along the
   * burn line, so a scorched pirate is visible from across the board even when he stands still.
   *
   * The hit itself is the char sweeping UP from the boots to the waist in a third of a second,
   * with a flare along the edge as it goes. After that it holds, until the next hit ends him or a
   * respawn makes him whole.
   */
  /* Multiplied, not painted over: the coat is how sixteen players tell each other apart, so the
   * char darkens and browns it while its own hue still shows through. A flat black overlay took
   * the bottom half of the colour away, which is the one thing the sprite must never lose. */
  const SCORCH = '#94735b';
  const SCORCH_EDGE = 'rgba(16,8,3,0.85)';
  const SCORCH_LINE = 15.5;             // tile pixels from the top: the belt, half way down him
  const SCORCH_FOOT = 26;               // where the sweep starts, at the boots
  const SCORCH_SWEEP_MS = 340;
  const hurtAt = new Map();             // seat -> performance.now() of the hit

  function drawScorch(c, sprite, x, y, seat) {
    const since = performance.now() - (hurtAt.get(seat) ?? -1e9);
    const k = Math.min(1, since / SCORCH_SWEEP_MS);
    const ease = 1 - (1 - k) ** 3;
    const line = SCORCH_FOOT - (SCORCH_FOOT - SCORCH_LINE) * ease;
    c.save();
    c.beginPath();
    c.rect(x - 2, y + line, TILE_PX + 4, TILE_PX - line + 2);
    c.clip();
    c.globalCompositeOperation = 'multiply';
    c.drawImage(silhouette(sprite, SCORCH), x, y, TILE_PX, TILE_PX);
    c.restore();
    // The burn line itself: a ragged dark edge, so it reads as burned rather than as shaded.
    c.save();
    c.beginPath();
    for (let s = 0; s < 8; s++) {
      const jag = ((s * 7 + seat * 3) % 5) * 0.35;
      c.rect(x + 4 + s * 3, y + line - 0.6 + jag, 3, 1.4);
    }
    c.clip();
    c.drawImage(silhouette(sprite, SCORCH_EDGE), x, y, TILE_PX, TILE_PX);
    c.restore();
    // The burning edge: a flare while it sweeps, then two embers that breathe.
    c.save();
    c.globalCompositeOperation = 'lighter';
    if (k < 1 || since < 700) {
      const flare = k < 1 ? 1 : 1 - (since - SCORCH_SWEEP_MS) / (700 - SCORCH_SWEEP_MS);
      c.globalAlpha = 0.85 * flare;
      c.fillStyle = '#ff8a3a';
      c.fillRect(x + 8, y + line - 1, 16, 2);
      c.globalAlpha = 0.35 * flare;
      c.fillRect(x + 6, y + line - 3, 20, 6);
    }
    for (let e = 0; e < 2; e++) {
      const glow = 0.5 + 0.5 * Math.sin(seaT * (5 + e * 2.3) + seat * 1.7 + e * 2);
      c.globalAlpha = 0.35 + 0.55 * glow;
      c.fillStyle = e ? '#ffb347' : '#ff6a2a';
      c.fillRect(x + 11 + e * 7, y + line - 0.5, 1.5, 1.5);
    }
    c.restore();
  }

  /** Smoke off a scorched pirate's head, in world space so it rises straight up whatever he does. */
  // Not `drawSmoke`: that name is the blast smoke's, further up, and a second function
  // declaration silently replaced it - every frame then crashed calling the wrong one.
  function drawHurtSmoke(c, cx, top, seat) {
    c.save();
    /* Two-tone puffs - a dark body with a pale cap offset toward the light - because the board
     * is both pale sand and dark stone, and a single grey vanishes into one or the other. */
    for (let n = 0; n < 4; n++) {
      const t = (seaT * 0.5 + n / 4 + seat * 0.13) % 1;
      const a = 0.6 * (1 - t) * Math.min(1, t * 6);
      if (a < 0.02) continue;
      const sx = cx + Math.sin(t * 5 + n * 2 + seat) * (1.5 + t * 3);
      const sy = top - 2 - t * 18;
      const r = 2.2 + t * 4.4;
      c.globalAlpha = a * 0.75;
      c.fillStyle = '#3c3f45';
      c.beginPath(); c.arc(sx, sy, r, 0, 7); c.fill();
      c.globalAlpha = a * 0.6;
      c.fillStyle = '#c9ccd2';
      c.beginPath(); c.arc(sx - r * 0.25, sy - r * 0.25, r * 0.62, 0, 7); c.fill();
    }
    c.restore();
  }

  function drawOne(c, p, ox, oy, isMe) {
    if (!p.alive) return;
    const px = ox + (p.rx / UNITS_PER_TILE) * TILE_PX - TILE_PX / 2;
    const py = oy + (p.ry / UNITS_PER_TILE) * TILE_PX - TILE_PX / 2;
    const frame = p.moving ? ((world.tick >> 2) & 1) : 0;

    // Invisible: gone to everyone else, a ghost to yourself, so you can still steer.
    if ((p.status & STATUS.INVISIBLE) && !isMe) return;

    // Invulnerable players flash, so "I am safe" and "I am about to not be" are readable at a
    // glance in a crowd. Four hertz: fast enough to notice, slow enough not to hurt.
    if (p.status & STATUS.INVULN) c.globalAlpha = (world.tick >> 2) % 2 ? 0.45 : 1;
    if (p.status & STATUS.INVISIBLE) c.globalAlpha = 0.35;

    // Baked per colour, not per seat; see bake() and COLOUR_PREFERENCE.
    const sprite = baked.players[seatSlot(p.i)][p.dir * 2 + frame];
    const flipped = (p.status & STATUS.CHANGELING) !== 0;
    const small = (p.status & STATUS.REDUCTION) !== 0;

    /* Out of breath, on the sprite itself.
     *
     * The meter beside the player is precise and easy to miss; this is the opposite. The figure
     * heaves - scaled on one axis only, so it reads as breathing rather than as a zoom - and
     * once genuinely exhausted it flashes amber on the beat of the breath.
     *
     * Deliberately on the SPRITE rather than only in the HUD: at the moment you need to know
     * you are about to be slow, you are looking at your pirate, not at a bar.
     */
    let pant = 0, gasp = 0;
    if (p.stamina !== undefined) {
      const frac = Math.max(0, Math.min(1, p.stamina / staminaMaxFor(p)));
      if (frac < STAMINA_SHOW_AT || p.tired) {
        // Breathing gets faster and deeper the emptier it gets.
        const depth = p.tired ? 1 : (STAMINA_SHOW_AT - frac) / STAMINA_SHOW_AT;
        const rate = 0.22 + depth * 0.3;
        pant = Math.sin(world.tick * rate) * 0.07 * depth;
        gasp = p.tired ? 0.5 + 0.5 * Math.sin(world.tick * rate) : 0;
      }
    }

    // Arriving. A player who simply appears at full size in a sixteen-player scrum is invisible,
    // so they land enormous and collapse to size.
    //
    // Quintic ease-out, not cubic: at twenty times scale a cubic curve is still four tiles wide
    // a third of the way through, which covers the fight. The fifth power dumps almost all of
    // the shrink into the first few frames, so it reads as something LANDING rather than as a
    // slow zoom - and then overshoots slightly below 1 and settles, which is the squash that
    // sells the impact.
    let pop = 1;
    if (p.spawnAt !== undefined) {
      const age = (world.tick - p.spawnAt) / SPAWN_POP_TICKS;
      if (age >= 0 && age < 1) {
        pop = 1 + (SPAWN_POP_SCALE - 1) * Math.pow(1 - age, 5);
        // The last fifth of the window is a small squash-and-settle, under a tenth of a tile.
        if (age > 0.8) pop -= Math.sin((age - 0.8) * 5 * Math.PI) * 0.12;
      } else p.spawnAt = undefined;
    }

    if (pop > 1) drawSpawnRing(c, px + TILE_PX / 2, py + TILE_PX / 2, pop, p.i);

    // Exhausted: a warm pulse on the ground under them. Under, not over - it says "slow" without
    // obscuring the one thing you are aiming at.
    if (gasp > 0) {
      c.save();
      c.globalAlpha = 0.18 + gasp * 0.3;
      c.fillStyle = '#ff9b4a';
      c.beginPath();
      c.ellipse(px + TILE_PX / 2, py + TILE_PX * 0.72, TILE_PX * (0.34 + gasp * 0.12),
        TILE_PX * (0.16 + gasp * 0.05), 0, 0, 7);
      c.fill();
      c.restore();
      c.globalAlpha = 1;
    }

    const sx = (small ? 0.55 : 1) * pop * (1 - pant * 0.5);
    const sy = (small ? 0.55 : 1) * pop * (flipped ? -1 : 1) * (1 + pant);
    const scorched = p.hp === 1 && pop < 1.5;
    if (sx !== 1 || sy !== 1) {
      c.save();
      c.translate(px + TILE_PX / 2, py + TILE_PX / 2);
      c.scale(sx, sy);
      drawEdge(c, sprite, -TILE_PX / 2, -TILE_PX / 2, isMe);
      c.drawImage(sprite, -TILE_PX / 2, -TILE_PX / 2);
      if (scorched) drawScorch(c, sprite, -TILE_PX / 2, -TILE_PX / 2, p.i);
      c.restore();
    } else {
      drawEdge(c, sprite, Math.round(px), Math.round(py), isMe);
      c.drawImage(sprite, Math.round(px), Math.round(py));
      if (scorched) drawScorch(c, sprite, Math.round(px), Math.round(py), p.i);
    }
    c.globalAlpha = 1;
    if (scorched) drawHurtSmoke(c, px + TILE_PX / 2, py + TILE_PX / 2 - 9 * Math.abs(sy), p.i);

    // Not while they are still landing at twenty times their size: the rings would sit inside.
    if (pop < 1.5) drawShields(c, p, px + TILE_PX / 2, py + TILE_PX / 2);
    drawStatusPips(c, p, px, py);

    // Your own name too, in your own colour. It was the interface gold, which is the orange of the
    // fire and of the orange seat - so a red or blue pirate walked round under an orange name and
    // the label disagreed with the sprite it sat on. The rim, the chevrons and the spawn ring
    // already say which one is you; the name's job is to say what colour you are.
    const label = nameLabel(p.name, playerShades(p.i).light, !!p.isBot, p.i === world.host);
    c.drawImage(label.el, px + TILE_PX / 2 - label.w / 2, py - 3 - LABEL_BASE, label.w, LABEL_H);
  }

  /* Names over heads, baked.
   *
   * A stroked-then-filled line of text per player per frame is sixteen pairs of font
   * rasterisations sixty times a second, for strings that change once a round. Each name is
   * rendered once into a small canvas at the device scale it is shown at, and blitted after
   * that - the same pixels for a drawImage each. Keyed on scale too, so a zoom change re-bakes
   * rather than blurring; cleared wholesale if it ever grows past what a room could need. */
  const LABEL_H = 16, LABEL_BASE = 12;
  const labels = new Map();
  /* The host's crown, as canvas paths, on the same 16-unit grid the scoreboard's mask uses - and
   * it is the SAME path data as `--crown` in style.css. One shape, three places it appears: the
   * live list, the TAB table, and here over the pirate's head. Copied rather than imported
   * because a CSS custom property holding a data: URL is not something canvas can draw. */
  const CROWN = typeof Path2D === 'function'
    ? new Path2D('M2 12h12l1-7-3.5 2.5L8 3 4.5 7.5 1 5zM2 13h12v2H2z') : null;
  const CROWN_PX = 9;
  // The scoreboard's robot head (--robot in style.css), as canvas paths, on a 16-unit grid.
  const ROBOT = typeof Path2D === 'function' ? new Path2D(
    'M7.2 0h1.6v2.4H7.2zM2.6 4h10.8a1 1 0 011 1v7a1 1 0 01-1 1H2.6a1 1 0 01-1-1V5a1 1 0 011-1z'
    + 'm2.3 2.6a1.5 1.5 0 100 3 1.5 1.5 0 000-3zm6.2 0a1.5 1.5 0 100 3 1.5 1.5 0 000-3z'
    + 'M9.3 1.1a1.3 1.3 0 10-2.6 0 1.3 1.3 0 002.6 0zM0 6.6h1.3v3.8H0zM14.7 6.6H16v3.8h-1.3z') : null;
  const ROBOT_PX = 9;

  function nameLabel(text, colour, bot = false, host = false) {
    const k = view.zoom * view.dpr;
    const key = `${text}|${colour}|${k}|${bot ? 1 : 0}|${host ? 1 : 0}`;
    let l = labels.get(key);
    if (l) return l;
    if (labels.size > 96) labels.clear();
    const el = document.createElement('canvas');
    const font = '10px ui-monospace, monospace';
    const probe = el.getContext('2d');
    probe.font = font;
    const tw = Math.ceil(probe.measureText(text).width);
    const icon = bot && ROBOT ? ROBOT_PX + 3 : 0;
    // The crown goes AFTER the name, matching the scoreboard; the robot goes before it. So the
    // text is centred in what is left between the two rather than in the whole label.
    const crown = host && CROWN ? CROWN_PX + 3 : 0;
    const w = tw + 6 + icon + crown;
    el.width = Math.ceil(w * k);
    el.height = Math.ceil(LABEL_H * k);
    const c = el.getContext('2d');
    c.scale(k, k);
    c.font = font;
    c.textAlign = 'center';
    c.lineJoin = 'round';
    const tx = icon + (w - icon - crown) / 2;
    if (crown) {
      // Outlined like the text, in the interface gold rather than the player's colour: the crown
      // means "this one is in charge", which is not a fact about which pirate they are.
      c.save();
      c.translate(w - CROWN_PX - 1, LABEL_BASE - CROWN_PX + 1);
      c.scale(CROWN_PX / 16, CROWN_PX / 16);
      c.lineWidth = 3 * 16 / CROWN_PX;
      c.strokeStyle = 'rgba(0,0,0,0.75)';
      c.stroke(CROWN);
      c.fillStyle = PALETTE.gold;
      c.fill(CROWN);
      c.restore();
    }
    if (icon) {
      // The robot, outlined like the text so it reads on any floor.
      c.save();
      c.translate(3, LABEL_BASE - ROBOT_PX + 1);
      c.scale(ROBOT_PX / 16, ROBOT_PX / 16);
      c.lineWidth = 3 * 16 / ROBOT_PX;
      c.strokeStyle = 'rgba(0,0,0,0.75)';
      c.stroke(ROBOT);
      c.fillStyle = colour;
      c.fill(ROBOT, 'evenodd');
      c.restore();
    }
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(0,0,0,0.75)';
    c.strokeText(text, tx, LABEL_BASE);
    c.fillStyle = colour;
    c.fillText(text, tx, LABEL_BASE);
    l = { el, w };
    labels.set(key, l);
    return l;
  }

  /**
   * Bubbles off a drunk. Theirs alone - it is a status on one player, and the only way to see
   * at a glance which of sixteen pirates has been at the rum.
   *
   * Stateless, like the sun glints: position and life come from a hash of the bubble's index
   * and a slowly advancing epoch, so each one rises for its whole short life and a new one
   * starts somewhere else. No arrays, no allocation, nothing to clean up when a player dies.
   */
  function drawTipsy(c, p, ox, oy) {
    if (!(p.status & STATUS.DRUNK) || !p.alive) return;
    const bx = ox + (p.rx / UNITS_PER_TILE) * TILE_PX;
    const by = oy + (p.ry / UNITS_PER_TILE) * TILE_PX;

    c.save();
    for (let i = 0; i < TIPSY_BUBBLES; i++) {
      const phase = seaT / TIPSY_LIFE_S + i * 0.41 + p.i * 0.17;
      const epoch = Math.floor(phase);
      const f = phase % 1;
      const seed = i * 2654 + epoch * 7919 + p.i * 31;
      // Drifting up and sideways, wider as it rises, the way a bubble actually goes.
      const rise = 6 + f * 22;
      const sway = Math.sin(f * 4 + seed) * (2 + f * 5);
      const r = 1.1 + hash01(seed) * 1.8;
      c.globalAlpha = (1 - f) * 0.5;
      c.fillStyle = '#cfe7f5';
      c.beginPath();
      c.arc(bx + sway + (hash01(seed + 1) - 0.5) * 10, by - rise, r, 0, 7);
      c.fill();
      // A highlight on the bigger ones, which is what makes a dot read as a bubble.
      if (r > 2) {
        c.globalAlpha = (1 - f) * 0.7;
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.arc(bx + sway + (hash01(seed + 1) - 0.5) * 10 - r * 0.3, by - rise - r * 0.3, r * 0.35, 0, 7);
        c.fill();
      }
    }
    c.restore();
    c.globalAlpha = 1;
  }

  /**
   * The tile your next bomb would land on.
   *
   * Bombs go where you are facing, which makes placing one an aimed action - and an aimed
   * action with no sight on it is a guess. This is the sight: a bracket on the target tile, in
   * your own colour so sixteen of them never get confused, breathing slowly so it reads as live
   * rather than as part of the terrain.
   *
   * Corners only, not a full outline. A closed box on a 32-pixel tile covers the tile; four
   * corner marks say exactly the same thing while leaving the middle - where the bomb, the
   * wall, or the person you are aiming at actually is - completely clear.
   */
  function drawAim(ox, oy, dtMs) {
    const me = world.me();
    if (!me || !me.alive || world.observing) { aimSeen = false; return; }
    const { tx, ty } = bombTile(world, me);
    // Nothing to show if you are out of bombs: a sight on a shot you cannot take is a lie.
    const live = world.bombs.reduce((n, b) => n + ((b.o ?? b.owner) === world.you ? 1 : 0), 0);
    if (live >= me.bombs) { aimSeen = false; aimIn = 0; return; }
    // Nor while standing in a puddle with nowhere dry in front: the bomb would not go down.
    if (!bombable(world, tx, ty)) { aimSeen = false; aimIn = 0; return; }

    /* Fade in when it comes back.
     *
     * The bracket vanishes the instant you place your last bomb and reappears the instant that
     * bomb goes off - which is a hard pop in the corner of your eye at the exact moment the
     * screen is already full of fire. Easing it in over about a sixth of a second turns an
     * event into an arrival.
     *
     * In only. Going OUT stays instant, and that asymmetry is deliberate: the bracket
     * disappearing is information - you have no bombs - and information must never lag. */
    aimIn += (1 - aimIn) * (1 - Math.pow(1 - 0.22, (dtMs || 16) / 16.7));
    if (aimIn < 0.02) return;

    /* Chase the target tile instead of appearing on it.
     *
     * Exponential approach on real elapsed time, not a fixed step per frame, so it looks the
     * same at 60 and at 144 Hz. AIM_TAU_MS is the time constant: about three frames at 60 Hz,
     * which is enough to read as a movement and short enough that the bracket has arrived
     * before you could have pressed the key. Longer than this and it stops being a flourish
     * and starts being a question about where your bomb is going.
     *
     * Two cases skip the glide entirely:
     *   - the first frame it is shown, or it slides in from wherever it was last round;
     *   - a jump of more than two tiles, which is a respawn, a map change or a camera cut, and
     *     a bracket sailing across the whole board is a bug with an animation on it.
     */
    const AIM_TAU_MS = 52, AIM_SNAP_TILES = 2;
    if (!aimSeen || Math.abs(tx - aimTx) > AIM_SNAP_TILES || Math.abs(ty - aimTy) > AIM_SNAP_TILES) {
      aimTx = tx; aimTy = ty; aimSeen = true;
    } else {
      const a = 1 - Math.exp(-(dtMs || 16) / AIM_TAU_MS);
      aimTx += (tx - aimTx) * a;
      aimTy += (ty - aimTy) * a;
      // Below a thousandth of a tile it is on the target for drawing purposes, and leaving it
      // asymptotic forever means the brackets sit a fraction of a pixel off true for good.
      if (Math.abs(tx - aimTx) < 0.001) aimTx = tx;
      if (Math.abs(ty - aimTy) < 0.001) aimTy = ty;
    }

    const k = playerShades(world.you);
    const x = ox + aimTx * TILE_PX, y = oy + aimTy * TILE_PX;
    // How far it still has to go, 0 at rest. Used to lean into the move below.
    const travel = Math.min(1, Math.hypot(tx - aimTx, ty - aimTy));
    // Brighter while it is moving, so the glide reads as intent rather than as lag, and the
    // resting pulse is what you see the other 99% of the time. Multiplied by the fade, so the
    // whole bracket arrives together rather than one layer at a time.
    const pulse = Math.min(1, 0.55 + 0.25 * Math.sin(world.tick / 7) + travel * 0.45) * aimIn;
    // The arms pull IN as it travels and spring back out when it lands - the same trick a
    // camera reticle uses, and it is what makes a 50 ms move feel deliberate.
    const arm = TILE_PX * (0.3 - 0.1 * travel), inset = 3 + travel * 2;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // A dark pass underneath, so the bracket survives being drawn over pale sand or bright fire.
    // The dark backing pass fades in with the rest, or the outline arrives before the bracket.
    for (const [colour, width, alpha] of [['#0b0f16', 4, 0.5 * aimIn], [k.light, 2, pulse]]) {
      ctx.strokeStyle = colour;
      ctx.lineWidth = width;
      ctx.globalAlpha = alpha;
      for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        const cx = x + (sx > 0 ? inset : TILE_PX - inset);
        const cy = y + (sy > 0 ? inset : TILE_PX - inset);
        ctx.beginPath();
        ctx.moveTo(cx + sx * arm, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + sy * arm);
        ctx.stroke();
      }
    }
    // A faint wash inside, which is what makes the tile read as selected rather than framed.
    ctx.globalAlpha = 0.1 * pulse;
    ctx.fillStyle = k.base;
    ctx.fillRect(x + 2, y + 2, TILE_PX - 4, TILE_PX - 4);
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* Stamina: a wind gauge under the boots.
   *
   * It used to be a vertical sliver beside the right shoulder, and the two things wrong with it
   * were its shape and its place. Vertical, at three and a half pixels wide, it could show you
   * roughly how much was left and nothing more precise than that; and sitting where it did it
   * fought the name label and the shield rings for the same few pixels. Under the feet is empty
   * space on every map, and horizontal is the orientation a quantity belongs in.
   *
   * The hard part is that a horizontal bar under a character IS a health bar in every game
   * anybody has played, and this game has no health - you die to one blast whatever the gauge
   * says. Reading it as health would be actively dangerous information. Four things stop it:
   *
   *   THE BOLT   a small lightning glyph in front of it. One glyph does most of this work. It
   *              used to be a row of six segments instead, and the segments were the wrong answer
   *              twice over: six gaps across twenty-five pixels is a stack of vertical lines
   *              rather than a gauge, and they quantised a continuous reading into sixths - the
   *              one thing the bar must not do, because the question it answers ("can I still
   *              slide?") is about a threshold a segment boundary knows nothing about.
   *   THE NOTCH  a tick mark at what a slide costs, so the bar answers "can I slide?" - a
   *              question no health bar has ever been asked.
   *   THE COLOUR normal is the interface's own amber, not green. Nothing in this game is ever
   *              green-to-red, which is the colour grammar of health specifically.
   *
   * Low is a red GRADIENT along the bar and a flash, because the thing that matters at the bottom
   * of the gauge is not the number, it is "you are about to be slow". Still drawn for everyone:
   * seeing that the pirate chasing you is blown is as useful as knowing you are.
   */
  function drawStamina(c, p, ox, oy) {
    if (!p.alive || p.stamina === undefined) return;
    const max = staminaMaxFor(p);
    const frac = Math.max(0, Math.min(1, p.stamina / max));
    if (frac >= STAMINA_SHOW_AT && !p.tired) return;

    // Under the feet, centred. The sprite's own shadow is at 0.72 of a tile, so this sits just
    // below it and never on top of the figure.
    const cx = ox + (p.rx / UNITS_PER_TILE) * TILE_PX;
    // Just under the boots, not a gap below them: at 0.62 of a tile the bar floated clear of the
    // figure and read as belonging to the floor rather than to the pirate standing on it.
    const cy = oy + (p.ry / UNITS_PER_TILE) * TILE_PX + TILE_PX * 0.5;
    // Two pixels thinner than it was, on request. At 4.5 it was a bar; at 2.5 it is a line with
    // a reading in it, which is the right weight for something that is on screen while you are
    // being chased and is never the thing you are looking at.
    const w = TILE_PX * 0.78, h = 2.5;
    // +4.5 rather than +2.5: the bolt sits in that margin, and two of those pixels are now a GAP
    // between the glyph and the track. Touching, the bolt read as the bar's end cap rather than
    // as a label for it.
    const x = cx - w / 2 + 4.5, y = cy;

    // Fades in over the top quarter of the visible range rather than appearing at a hard edge,
    // which would read as a glitch on the frame it crossed the threshold.
    const appear = Math.max(0, Math.min(1, (STAMINA_SHOW_AT - frac) / (STAMINA_SHOW_AT * 0.25)));
    /* The flash, and it is a flash of the FILL, not of the whole gauge.
     *
     * Blinking the entire thing - track, border and all - is what a health bar does when you are
     * about to die, and it also hides the reading at exactly the moment you want it. Here the
     * frame stays solid and only the light inside it pulses, faster the emptier it gets, so the
     * bar is still legible while it is shouting.
     */
    const low = frac <= STAMINA_LOW_AT || p.tired;
    const urgency = p.tired ? 1 : Math.max(0, Math.min(1, (STAMINA_LOW_AT - frac) / STAMINA_LOW_AT));
    // Gentler than it was (0.72 + 0.28 of a swing): a bar pulsing through nearly a third of its
    // brightness at eight hertz is an alarm, and the thing it is reporting - you are nearly out of
    // wind - is not an emergency, it is information you want to read while being chased.
    const flash = low ? 0.84 + 0.16 * Math.sin(seaT * (5.5 + 6 * urgency)) : 1;

    c.save();
    c.globalAlpha = appear;

    // The track, with the thin black border round it. One stroke, inside the shape, so the
    // border is exactly a pixel at every zoom rather than straddling the edge.
    c.beginPath();
    c.roundRect(x, y, w, h, 2);
    c.fillStyle = 'rgba(8,11,16,0.72)';
    c.fill();
    c.lineWidth = 1;
    c.strokeStyle = 'rgba(0,0,0,0.95)';
    c.stroke();

    /* The fill, clipped to the track.
     *
     * The gradient runs along the BAR rather than along the filled part, so a colour at a given
     * position means the same thing however full it is - the left end is always the colour of
     * "nearly out". That is what makes the red read as a zone you are entering rather than as a
     * bar that has changed colour.
     */
    c.save();
    c.beginPath();
    c.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 1.5);
    c.clip();
    const g = c.createLinearGradient(x, 0, x + w, 0);
    if (low) {
      g.addColorStop(0, '#ff3b2f');
      g.addColorStop(0.45, '#ff7a3c');
      g.addColorStop(1, '#ffc65a');
    } else {
      g.addColorStop(0, '#ffb13c');
      g.addColorStop(1, '#ffe877');
    }
    c.globalAlpha = appear * flash;
    c.fillStyle = g;
    // One continuous bar. The reading is continuous, so the bar is.
    c.fillRect(x + 0.5, y + 0.5, (w - 1) * frac, h - 1);
    c.restore();

    /* No marks on the track, of any kind.
     *
     * There was a black notch here at what a slide costs - genuinely useful information, and
     * still the wrong thing on this object: at two and a half pixels tall, any vertical line
     * across the bar is read as a gauge division rather than as a threshold, and a bar that looks
     * divided looks like segments however it is drawn. The slide's cost is legible where it
     * matters anyway: a slide you cannot afford simply does not launch, and the bar is amber
     * above the line and red below it.
     */
    // The bolt, so a horizontal bar under a character is not mistaken for health. Small, and in
    // the fill's own colour, so it dims and flashes with the gauge.
    c.globalAlpha = appear * flash;
    c.fillStyle = low ? '#ff5a3c' : '#ffe04a';
    c.translate(x - 6.4, y - 2.6);          // 2px clear of the track's left edge
    c.scale(0.4, 0.4);
    c.beginPath();
    c.moveTo(9.5, 0); c.lineTo(3, 9); c.lineTo(7.5, 9);
    c.lineTo(5.5, 17); c.lineTo(12, 7); c.lineTo(7.5, 7);
    c.closePath();
    c.fill();
    c.restore();
    c.globalAlpha = 1;
  }

  /* ─── the slide ──────────────────────────────────────────────────────────────
   *
   * Drawn entirely from `slideV`, which is on the wire for everybody - so a remote pirate's slide
   * looks like yours, and your own looks right the instant you double-tap rather than one
   * round trip later. No event, no bookkeeping that can get out of step with the simulation:
   * while the velocity is above zero there is a slide, and when it is zero there is not.
   *
   * Three things, and they are doing different jobs:
   *
   *   the kick-off   one ring and a shove of dust at the moment of launch. This is the frame that
   *                  tells you the input registered, and it has to be unmissable.
   *   the dust       thrown off the heels, backwards and sideways, growing and fading. Dust is
   *                  what makes speed legible on a flat top-down board - the sprite itself is
   *                  the same eight frames it always was.
   *   the streaks    two short lines trailing the shoulders, at an alpha that follows the
   *                  velocity, so the effect thins out as the slide runs down rather than
   *                  switching off. That taper is the part that reads as physics.
   */
  const dust = [];                 // slide dust and death dust share one pool and one draw
  const DUST_MAX = 220;
  const slideSeen = new Map();     // seat -> last velocity, for spotting the launch frame

  function addDust(x, y, vx, vy, { r = 2.4, life = 0.5, tone = '#c9b89c', rise = 0 } = {}) {
    if (dust.length >= DUST_MAX) return;
    dust.push({ x, y, vx, vy, r, life: 1, span: life, tone, rise, spin: Math.random() * 6 });
  }

  /* Dust off the heels of anybody actually walking, and more of it the faster they are.
   *
   * Boots are the perk with the least to show for themselves: a booted pirate is simply somewhere
   * sooner, which you can only perceive by comparison with how long you expected it to take. A
   * puff of sand at the feet makes the speed itself visible - on your own player it is the
   * feedback the pickup never had, and on somebody else's it is a warning.
   *
   * Scaled rather than switched on, so every boot reads: a fresh pirate kicks up the occasional
   * speck and a fully booted one leaves a trail. Nothing at all while standing still - the dust
   * is the movement, not the pirate.
   */
  /* BOARD space, not screen space - see drawDust, which adds the board offset itself.
   *
   * This is the "my dust is over there" bug: the foot and slide particles were spawned with the
   * offset already added and then drawn with it added again, so every mote appeared one board
   * origin away from the heel that kicked it up. It moved as the offset moved (a resize, a zoom,
   * a different map size), which is why it looked intermittent rather than simply wrong - and
   * why the death dust, the only emitter that stored board coordinates, always landed right. */
  function footDust(p, dt) {
    if (!p.alive || !p.moving) return;
    // A couple a second at base pace, a dozen fully booted. Below that it is invisible; above it,
    // sixteen players turn the board into a sandstorm.
    const rate = 2 + (p.speed || 0) * 2.6;
    const n = Math.floor(rate * dt) + (Math.random() < (rate * dt) % 1 ? 1 : 0);
    if (!n) return;
    const px = (p.rx / UNITS_PER_TILE) * TILE_PX;
    const py = (p.ry / UNITS_PER_TILE) * TILE_PX + TILE_PX * 0.3;
    // Thrown BACKWARD from the way they are going, which is what makes it read as being kicked
    // up rather than as a cloud the player is standing in.
    const v = [[1, 0], [0, -1], [-1, 0], [0, 1]][p.dir] ?? [0, 1];
    for (let i = 0; i < n; i++) {
      const a = Math.atan2(-v[1], -v[0]) + (Math.random() - 0.5) * 1.3;
      const s = 8 + Math.random() * (10 + (p.speed || 0) * 8);
      addDust(px + (Math.random() - 0.5) * 8, py + (Math.random() - 0.5) * 3,
        Math.cos(a) * s, Math.sin(a) * s,
        { r: 1 + Math.random() * 1.5, life: 0.3 + Math.random() * 0.22 });
    }
  }

  function trackSlides(ox, oy, dtMs) {
    const dt = dtMs / 1000;
    for (const p of world.players) {
      if (!p) continue;
      const was = slideSeen.get(p.i) || 0;
      const now = p.alive ? (p.slideV || 0) : 0;
      slideSeen.set(p.i, now);
      if (!now) { footDust(p, dt); continue; }
      // Board space for everything that goes into a particle pool; the streaks below are the
      // only thing here drawn straight to the context, and they add the offset themselves.
      const px = (p.rx / UNITS_PER_TILE) * TILE_PX;
      const py = (p.ry / UNITS_PER_TILE) * TILE_PX;
      // Which way the slide is going, in screen pixels.
      const v = [[1, 0], [0, -1], [-1, 0], [0, 1]][p.slideDir] ?? [0, 1];

      if (!was) {
        // The launch. A ring on the floor where the push came from, and a fan of dust behind.
        pops.push({ x: px, y: py + TILE_PX * 0.3, life: 1 });
        for (let i = 0; i < 10; i++) {
          const a = Math.atan2(-v[1], -v[0]) + (Math.random() - 0.5) * 1.5;
          const s = 40 + Math.random() * 70;
          addDust(px + (Math.random() - 0.5) * 6, py + TILE_PX * 0.28 + (Math.random() - 0.5) * 4,
            Math.cos(a) * s, Math.sin(a) * s, { r: 2.2 + Math.random() * 2.6, life: 0.5 });
        }
      }

      // The trail, while it runs. Rate follows the velocity, so the dust thins as it slows.
      const rate = 26 * Math.min(1, now / 50);
      const n = Math.floor(rate * dt) + (Math.random() < (rate * dt) % 1 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        const a = Math.atan2(-v[1], -v[0]) + (Math.random() - 0.5) * 1.1;
        const s = 20 + Math.random() * 45;
        addDust(px - v[0] * 5 + (Math.random() - 0.5) * 7,
          py + TILE_PX * 0.3 - v[1] * 3 + (Math.random() - 0.5) * 4,
          Math.cos(a) * s, Math.sin(a) * s, { r: 1.6 + Math.random() * 2.2, life: 0.42 });
      }

      // Two streaks off the shoulders, across the direction of travel.
      ctx.save();
      ctx.globalAlpha = 0.3 * Math.min(1, now / 45);
      ctx.strokeStyle = '#eaf4ff';
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      for (const s of [-1, 1]) {
        const offx = ox - v[1] * s * TILE_PX * 0.22, offy = oy + v[0] * s * TILE_PX * 0.22;
        const len = TILE_PX * (0.5 + 0.5 * Math.min(1, now / 60));
        ctx.beginPath();
        ctx.moveTo(px + offx, py + offy);
        ctx.lineTo(px + offx - v[0] * len, py + offy - v[1] * len);
        ctx.stroke();
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  /* ─── dust, and dying in it ──────────────────────────────────────────────────
   *
   * A death used to be the sprite simply ceasing to exist: `drawOne` returns early for anybody
   * not alive, so one frame they are there and the next they are not, and in a sixteen-player
   * scrum you cannot tell whether somebody died or walked behind a wall.
   *
   * So: the figure comes apart. A grid of motes is sampled over the sprite's footprint, each
   * given the upward kick and outward drift of something collapsing, and the pile then blows
   * away on the sea breeze over DEATH_DUST_S. The motes are coloured from the player's own
   * shades, so you can still tell WHOSE death you are watching while it happens - which is the
   * only information a death animation owes anybody.
   */
  const DEATH_DUST_S = 3;

  function addDeathDust(seat, x, y) {
    const px = (x / UNITS_PER_TILE) * TILE_PX, py = (y / UNITS_PER_TILE) * TILE_PX;
    const k = playerShades(seat % 16);
    const tones = [k.dark, k.base, k.light, '#b9a98f', '#7d7362'];
    /* Sampled over the body rather than sprayed from its centre: the first half second is
     * recognisably a pirate coming apart, because the motes start where the pirate was. */
    for (let i = 0; i < 46; i++) {
      const a = Math.random() * Math.PI * 2;
      const rr = Math.sqrt(Math.random());
      const ox2 = Math.cos(a) * rr * TILE_PX * 0.34;
      const oy2 = Math.sin(a) * rr * TILE_PX * 0.42 - TILE_PX * 0.1;
      addDust(px + ox2, py + oy2,
        ox2 * 2.1 + (Math.random() - 0.5) * 18,
        oy2 * 1.2 - 14 - Math.random() * 26, {
          r: 1.4 + Math.random() * 2.8,
          // Spread over the whole window so the pile keeps letting go of motes for three
          // seconds instead of all of it fading at once.
          life: DEATH_DUST_S * (0.45 + Math.random() * 0.55),
          tone: tones[(Math.random() * tones.length) | 0],
          rise: 6 + Math.random() * 14,
        });
    }
    // The puff at the moment it goes, so the collapse has a beat to it.
    pops.push({ x: px, y: py + TILE_PX * 0.25, life: 1 });
  }

  /**
   * One pool, one pass: slide dust, death dust, everything.
   *
   * Carried on the real current like the bioluminescence is - dust over an island in a sea breeze
   * does not fall straight - plus its own slow rise, drag, and a shrink as it thins out. Drawn
   * under the players and over the floor, which is where airborne dust belongs.
   */
  function drawDust(ox, oy, dtMs) {
    if (!dust.length) return;
    const dt = dtMs / 1000;
    ctx.save();
    for (let i = dust.length - 1; i >= 0; i--) {
      const d = dust[i];
      d.life -= dt / d.span;
      if (d.life <= 0) { dust.splice(i, 1); continue; }
      const drag = Math.exp(-dt * 3.4);
      d.vx *= drag; d.vy *= drag;
      if (d.rise) {
        // The breeze, from the same flow field the sea uses, so dust and water agree.
        flowAt(d.x, d.y, seaT, flow);
        d.vx += flow.x * 0.12 * dt * d.rise;
        d.vy += (flow.y * 0.12 * d.rise - d.rise * 2.2) * dt;
      }
      d.x += d.vx * dt; d.y += d.vy * dt;
      // Fades out early and grows as it goes: a mote of dust disperses, it does not land.
      ctx.globalAlpha = Math.min(1, d.life * 1.6) * 0.55;
      ctx.fillStyle = d.tone;
      const r = d.r * (1 + (1 - d.life) * 0.9);
      ctx.beginPath();
      ctx.ellipse(ox + d.x, oy + d.y, r, r * 0.82, d.spin, 0, 7);
      ctx.fill();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /**
   * Seeing stars: a question mark over the head of anybody a slide went through.
   *
   * A status with no picture is a status nobody learns. This one has to say three things at once
   * - that pirate is confused, cannot bomb, and it is about to wear off - so the mark bobs,
   * tilts, and shrinks away over the last third of the status rather than vanishing.
   */
  function drawConfused(c, p, ox, oy) {
    if (!(p.status & STATUS.CONFUSED) || !p.alive) return;
    const x = ox + (p.rx / UNITS_PER_TILE) * TILE_PX;
    const y = oy + (p.ry / UNITS_PER_TILE) * TILE_PX - TILE_PX * 0.95;
    const t = seaT * 2.4 + p.i;
    const bob = Math.sin(t) * 2.2;

    c.save();
    c.translate(x, y + bob);
    c.rotate(Math.sin(t * 0.8) * 0.22);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = 'bold 15px ui-monospace, monospace';
    c.lineJoin = 'round';
    c.lineWidth = 3.5;
    c.strokeStyle = 'rgba(0,0,0,0.8)';
    c.strokeText('?', 0, 0);
    c.fillStyle = '#ffe04a';
    c.fillText('?', 0, 0);
    // Two little stars going round it, because one glyph alone reads as a HUD hint rather than
    // as something that happened to the pirate.
    c.fillStyle = '#fff6c8';
    for (const s of [0, Math.PI]) {
      const a = t * 1.6 + s;
      c.globalAlpha = 0.55 + 0.45 * Math.sin(a * 2);
      c.beginPath();
      c.arc(Math.cos(a) * 8, Math.sin(a) * 4, 1.5, 0, 7);
      c.fill();
    }
    c.restore();
    c.globalAlpha = 1;
  }

  /**
   * Rising pickup labels. Drawn last of the world layer so nothing can cover them, in map
   * space, so they travel with the camera.
   */
  function drawFloaters(ox, oy, dtMs) {
    if (!floaters.length) return;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = 'bold 11px ui-monospace, monospace';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    for (let i = floaters.length - 1; i >= 0; i--) {
      const f = floaters[i];
      f.life -= dtMs / 1100;
      if (f.life <= 0) { floaters.splice(i, 1); continue; }
      // Rises fast and then slows: the motion is what catches the eye, the hang is what makes
      // it readable. 1 - life^2 eases out, so most of the travel is in the first third.
      const rise = 26 * (1 - f.life * f.life);
      // Only fades over the last 40%, or it is translucent before you have noticed it.
      ctx.globalAlpha = Math.min(1, f.life / 0.4);
      const x = ox + f.x, y = oy + f.y - rise;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(f.text, x, y);
      ctx.fillStyle = f.colour;
      ctx.fillText(f.text, x, y);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  resize();
  const api = {
    frame, resize, invalidateAll, invalidateTile, mapChanged, addMelt, gullHit, addSmoke,
    /** Somebody died here: the figure comes apart and blows away. See addDeathDust. */
    addDeathDust,
    /**
     * Something just hit you. Turns the island's rim red and beats it for a second.
     *
     * Called for a lost shield as well as a death, because the rim is the one place a hit can be
     * reported that is still saying so when you look up. See drawRadarRim.
     */
    alertRim(strength = 1) { rimAlert = Math.max(rimAlert, Math.min(1, strength)); },
    /** Somebody just lost half their health: starts the scorch sweeping up them. See drawScorch. */
    markHurt(seat) { if (seat >= 0) hurtAt.set(seat, performance.now()); },

    /** Hooks for the gulls' sounds, in tiles: `onGullCry(tx, ty)` and `onGullDown(tx, ty)`. */
    onGullCry: null, onGullDown: null,

    /**
     * Somebody said something short. Shown over their head for a few seconds.
     *
     * Whether it is an emote is decided HERE rather than by the caller: the renderer is what
     * knows it needs a bigger glyph and a taller bubble for one, and asking main.js to classify
     * a string it is only forwarding would put that knowledge in two places.
     */
    say(i, text) {
      const t = String(text).slice(0, 24);
      /* An emote has to actually contain a picture.
       *
       * "No letters or digits" was the old test and it caught `***` - a censored word - which
       * then got the emoji font and the dark bubble, and the asterisks have no glyph in an emoji
       * font, so the room saw an empty black box over somebody's head. A letter or digit still
       * makes it speech; so does anything else that is not pictographic.
       */
      const emoji = !/[\p{L}\p{N}]/u.test(t) && /\p{Extended_Pictographic}/u.test(t);
      says.set(i, { text: t, emoji, until: performance.now() + SAY_MS });
    },
    /** Where the sea gets its music from: `dtMs => analysis`, called once a frame. */
    setSound(fn) { soundOf = fn; },
    /**
     * A line of text that floats up off a player and fades.
     *
     * Position is captured ONCE, at the moment it is added, rather than following the player.
     * Text stuck to a moving sprite is unreadable - it is the one thing on screen that has to
     * hold still long enough to be read, and the pickup it describes already happened here.
     */
    addFloater(x, y, text, colour = PALETTE.gold) {
      floaters.push({ x, y, text, colour, life: 1 });
      if (floaters.length > 24) floaters.shift();
    },
    /** @param amount 0..1. Clamped and saturating: ten bombs at once must not throw the camera off. */
    addShake(amount) { shake = Math.min(1, shake + Math.max(0, amount)); },
    addFlash(amount, colour = '255,255,255') { flash = Math.min(1, flash + amount); flashColour = colour; },
    get chunkRedraws() { return redrawsThisSecond; },
  };
  return api;
}
