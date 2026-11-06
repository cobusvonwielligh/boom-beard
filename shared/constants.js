// Boom Beard - tuning constants and enums.
//
// FROZEN FILE. Both developers import this. Agree before changing it.
// Every magic number in the project lives here; see docs/RULES.md for the rationale.
// Values marked TUNE are first guesses to be adjusted in playtesting (PLAN task TUNE-1).

// ─── World ────────────────────────────────────────────────────────────────────

export const TILE_PX = 32;
export const UNITS_PER_TILE = 256; // integer sub-tile resolution; never use floats in the sim
export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;
export const SNAP_EVERY_TICKS = 2; // → 15 Hz snapshots

export const ROUND_TICKS = 6 * 60 * TICK_HZ; // 10800

// What /roundtime will accept, in minutes. The floor is a tenth of a minute - six seconds - which
// is short enough to be useless for a real round and exactly right for testing the round-end
// path without waiting ten minutes for it.
export const ROUNDTIME_MIN_MIN = 0.1;
export const ROUNDTIME_MAX_MIN = 60;

/* Tiles of open sea kept visible on every side of the island.
 *
 * The board is scaled so the map plus this margin fits exactly - without it an island can sit
 * flush against the panel edge and stop reading as an island.
 *
 * Three rather than two, now that the shallows are drawn: the sand shelf reaches about a tile
 * and a half out from the coast (see SHELF_TILES in client/render.js), and at a two-tile margin
 * the far side of the shelf was the first thing the panel edge cut off - which is exactly the
 * part that makes the island look like it is standing in water rather than floating on it. */
export const SEA_MARGIN_TILES = 3;
/* How much of that the board is SCALED to fit, which is a tile less than it reaches.
 *
 * The two numbers do different jobs and used to be one. The margin above is how far the scenery
 * goes - the shelf, the shallows, the boulders - and the fit is how much of it has to be on
 * screen. They are not the same question: the far edge of the shelf is the faintest thing on the
 * board, and spending a whole tile of scale on both sides of the island to guarantee it is in
 * frame makes everything that matters smaller. The shelf is allowed to run off; the island and a
 * clear two tiles of water around it are not. */
export const SEA_FIT_MARGIN_TILES = 2;
/* And the most sea there may ever be between the island and the frame, on any side.
 *
 * The fit above is for the TIGHTER axis; the other one used to get whatever the window's shape
 * left over, five or six tiles of open water on a wide screen. The canvas is cut down to the
 * island plus this much and centred, so the frame - and the radar riding on it - is never more
 * than four tiles from the coast. See applyBoardSize in client/render.js. */
export const SEA_MAX_MARGIN_TILES = 4;

// The board is never drawn smaller than this, whatever the window. Below about two thirds a
// 32-pixel tile is 21 pixels and a player is a smudge; past that point a camera that follows you
// is strictly better than a whole map you cannot read. Maps are sized so this floor is never hit
// on a normal window - it exists for the laptop somebody opens at 1280x720 with the panel up.
export const MIN_ZOOM = 0.68;
export const MAX_ZOOM = 2;
export const ROUND_INTERMISSION_MS = 16_000;

/* The count-in: five seconds at the top of every round, and NOBODY MOVES.
 *
 * Shared rather than a client constant, because it is a rule now and not a caption. The room
 * zeroes every input - people and bots alike - until `state.tick` reaches this, and the client
 * neither predicts nor sends over the same window, so the digit on screen and the frozen board
 * are two views of one fact.
 *
 * The round clock is pushed out by the same amount (see `roundEndsAtTick`), so a ten-minute round
 * is still ten minutes of play rather than nine minutes and fifty-five seconds of it.
 *
 * It exists because a round used to begin with sixteen people arriving on a map none of them had
 * seen, already live: the first second was spent working out where you were, and anybody who
 * already knew the map had a free head start. Five seconds of looking is the fairest thing a
 * round can start with.
 */
export const COUNT_IN_TICKS = 5 * TICK_HZ;

export const CHUNK_TILES = 8; // renderer chunk size

export const MAX_PLAYERS = 16;

// ─── Movement ─────────────────────────────────────────────────────────────────

/* Index = skate count.
 *
 * Ten percent faster across the board: [27, 33, 38, 44] became [30, 36, 42, 48]. The whole curve
 * moved, so the shape of the boost progression is unchanged and only the pace is.
 *
 * Rails are what made the room for it. Under free movement the limit was how fast a corner could
 * be judged - at speed you arrived at a junction already past the line you needed and the turn
 * was luck - so pace had to be held back to keep corners fair. A queued turn removes that
 * entirely: the corner is taken for you at the junction, from anywhere in the tile, so going
 * faster no longer costs accuracy. A tile is 8.5 ticks at base pace now, down from 9.5.
 */
export const SPEED_UNITS_PER_TICK = [30, 36, 42, 48];
export const MAX_SKATES = SPEED_UNITS_PER_TICK.length - 1; // 3
export const SLOWDOWN_NUM = 1, SLOWDOWN_DEN = 2; // speed * 1/2, integer division

export const HITBOX_UNITS = 20 * (UNITS_PER_TILE / TILE_PX); // 20 px → 160 units
export const HITBOX_REDUCED_UNITS = 10 * (UNITS_PER_TILE / TILE_PX);

/* The corner cut: the hitbox's own corners are chamfered.
 *
 * A tile is only solid to you if you are into it by more than this on BOTH axes at once, which
 * turns the 160-unit square box into an octagon. 96 units is twelve pixels of chamfer on a
 * twenty-pixel box - most of the way to the middle of each side, which is as far as it can
 * usefully go: at 80 the corners meet, the hitbox is a diamond, and a diamond slides off
 * everything including the walls you meant to stop against.
 *
 * ORDINARY TRAVEL NEVER REACHES IT any more. It was there for diagonals, which the rails
 * removed - a lane-centred hitbox is 160 units inside a 256-unit lane, so it only ever touches
 * the tiles its own lane passes through and the chamfer has nothing to forgive. What still asks
 * is `unstick`'s seatbelt and the bots, who reason about the SQUARE box precisely because a
 * corner a person may glance off is not a corner a bot may plan through.
 *
 * It lives in `blocked`, so the shape is the same shape for everything that asks. A hitbox that
 * is one shape when moving and another when being pushed ends in a desync.
 */
export const CORNER_CUT_UNITS = 96;

// Fire forgives a sliver of the sprite. The hitboxes above are what geometry collides with; fire
// kills on this fraction of them, so a player tucked behind a wall with two or three pixels of
// shoulder past its edge lives. Without the grace the lethal box reached exactly as far as the
// sprite, and the most careful hiding spot on the map was decided by one pixel of alignment.
// 13/20 of 160 units is 104 - three and a half pixels of mercy on each side, a shade more than
// the 7/10 it started at. TUNE
export const HITBOX_FIRE_NUM = 13, HITBOX_FIRE_DEN = 20;

// Input bitmask
export const IN_RIGHT = 1, IN_UP = 2, IN_LEFT = 4, IN_DOWN = 8, IN_BOMB = 16, IN_SLIDE = 32;
// Everything a client is allowed to assert. `input` masks with this, so a crafted packet with
// high bits set cannot reach the simulation carrying anything the keyboard cannot produce.
export const IN_MASK = IN_RIGHT | IN_UP | IN_LEFT | IN_DOWN | IN_BOMB | IN_SLIDE;

// Facing
export const DIR_R = 0, DIR_U = 1, DIR_L = 2, DIR_D = 3;

/* "No direction", for anything that stores an optional DIR_*.
 *
 * NOT zero, and this is the reason the constant exists at all: DIR_R IS zero, so `if (dir)` is
 * false for a perfectly good direction. The rails' buffered turn (see turnWant in sim/state.js)
 * was written with 0 as its empty value and the result was that turning RIGHT never worked at
 * all - every truthiness test read it as "nothing asked for". It cost a map-wide wander test to
 * find, because every targeted test happened to turn upward.
 */
export const DIR_NONE = -1;

/* The slide. Double-tap a direction and go.
 *
 * It exists because the game had exactly one verb for distance - walking - and the whole fight is
 * about whether you can be somewhere before a fuse ends. A slide is the answer to "I am two tiles
 * from cover and the bomb has half a second left", and the reason it is not simply free speed is
 * the price: a fifth of the bar per slide, so three of them is most of your wind.
 *
 * The physics, and all three parts matter:
 *
 *   SLIDE_PEAK_NUM/DEN  the launch, as a multiple of your walking pace. Three times, so the first
 *                       tick is unmistakably not running. It scales with 90% of the extra pace
 *                       from boots, preserving the perk while keeping a fully booted slide from
 *                       becoming disproportionately long.
 *   SLIDE_DRAG_NUM/DEN  friction, applied to the velocity every tick. Ninety-four percent - the slide
 *                       decelerates the whole way out, which is what makes it read as momentum
 *                       rather than as a teleport, and it is the reason you can be carried past
 *                       the turn you wanted if you start it too late. That mistake is the cost of
 *                       using the mechanic badly, and it is a cost you can see coming.
 *   SLIDE_EXIT_UNITS    below this pace it is over, so it ends by running out of speed rather
 *                       than by a timer expiring. A timer gives every slide the same length
 *                       whatever the surface or the boots; drag gives each one its own.
 *
 * SLIDE_MAX_TICKS is a seatbelt against a tuning accident, not the mechanic. At base pace the
 * slide ends after about sixteen ticks and covers just over three tiles, against about 1.7 tiles
 * walking the same time. Boots still extend the slide, but only 90% of their bonus pace counts.
 * The first pass was a 2.5x launch against a tenth of drag a tick, which decayed so fast that the
 * whole slide was worth about a sixth of a tile more than walking: a stamina cost for nothing.
 * The lesson is that the DRAG, not the launch, decides what a dash is worth.
 */
export const SLIDE_PEAK_NUM = 3, SLIDE_PEAK_DEN = 1;
export const SLIDE_SKATE_BONUS_SHAVE_NUM = 1, SLIDE_SKATE_BONUS_SHAVE_DEN = 10;
export const SLIDE_DRAG_NUM = 47, SLIDE_DRAG_DEN = 50;
export const SLIDE_EXIT_UNITS = 26;
export const SLIDE_MAX_TICKS = 30;
/* Taken in full at the launch rather than per tick: a slide you can abort halfway through for half
 * price is a slide nobody ever commits to. Scaled with STAMINA_MAX for the same reason the Stim
 * is.
 *
 * 940, a third less than the 1400 it was. A fifth of a fresh bar made the slide something you
 * spent the round saving up for, and a mechanic that is also the only way to kick a bomb cannot
 * be rationed that hard - at a third less it is about seven slides to a bar instead of five, which
 * is often enough to learn the kick with.
 */
export const SLIDE_STAMINA_COST = 940;
// You may not chain them. Long enough that the second slide is a decision rather than the rest of
// the first one, short enough to still be the answer to a chase.
export const SLIDE_COOLDOWN_TICKS = 18;
/* The slide is bound to CONTROL and goes the way you are facing. There is no gesture any more.
 *
 * It was a double-tap of a direction inside a 160 ms window, and no window worked: tapping a
 * direction twice while lining up on a gap is ordinary corridor play, so slides fired by accident
 * all round - and a mechanic that costs a fifth of your wind and takes your steering away for
 * half a second must never happen by accident. The binding lives in client/input.js; the server
 * still only ever sees one bit in the mask, so this is local feel and not a rule.

/* Rails: how far a turn request is carried before it is forgotten.
 *
 * A press across your lane cannot always be obeyed on the tick it arrives - you have to reach a
 * tile centre first. So the press is REMEMBERED and spent at the first junction where it is
 * legal, which is what makes a corner impossible to miss by pressing slightly early. It is the
 * mechanism that replaces corner assist, and it is strictly better: assist needed you to already
 * be nearly lined up, and this does not.
 *
 * IN UNITS OF TRAVEL, not in ticks, and that is the whole point of the number.
 *
 * It was ticks first - eight of them - and that is a promise about time pretending to be a
 * promise about distance. The promise players actually feel is "a press anywhere in the tile
 * before a junction lands", and the ticks a tile takes depends on your boots, your stamina, moss,
 * water and whether somebody just slid through you: 9.5 ticks at base pace, 5.8 with four skates,
 * and up to 256 for a tired and slowed pirate. Eight ticks was therefore slightly SHORT of one
 * tile at base pace - a tap one tile out expired 13 units before the corner - and several tiles
 * long for anybody limping. One number cannot be both.
 *
 * A tile and a half. One tile is the worst case within the guarantee (press immediately after
 * leaving a junction, arrive at the next one), and the extra half is margin so it reads as
 * reliable rather than as exactly-just-barely. At most two junctions are reached inside 384
 * units, so a stray press can be tried at the next corner and the one after, and never at the
 * "ten tiles and several seconds later" that makes a game feel like it is driving.
 *
 * A HELD key is re-stamped every tick, so holding a direction never expires - the buffer is only
 * ever about a press you have already let go of.
 */
export const TURN_BUFFER_UNITS = UNITS_PER_TILE + (UNITS_PER_TILE >> 1);

/* Rum, on rails. See DRUNK_SWAY_UNITS for what this replaces.
 *
 * Swaying a drunk pirate sideways is meaningless when there is no sideways to sway into, so the
 * cost moves to the one place a rail pirate makes a decision: the turns. One turn in this many is
 * fumbled - dropped, as if you missed the corner. Deterministic in (tick, seat), like the sway it
 * replaces, so the client predicts the fumble instead of being corrected into it.
 *
 * Three is hard enough to be felt threading a maze and not so hard that the controls read as
 * broken. A reversal was tried and rejected for the same reason the old stagger never reversed:
 * going the opposite way to the one you asked for reads as a bug, where missing a corner reads as
 * being too drunk to take it.
 */
export const DRUNK_FUMBLE_EVERY = 3;

// ─── Bombs & fire ─────────────────────────────────────────────────────────────

export const FUSE_TICKS = 72;      // 2.4 s. TUNE
export const FUSE_TICKS_FAST = 36; // Fast Detonation
export const FIRE_TICKS = 15;      // 0.5 s - how long a blast is DRAWN

/* How long a blast actually kills for, as a fraction of how long it is drawn.
 *
 * Fire that is visibly dying should not still be lethal. The tail of the animation is a puff of
 * smoke and a few embers, and dying to it feels like the game cheating - you watched the
 * explosion finish and then died anyway. Lethal for the first two thirds, decorative for the
 * last third, which is about five ticks of grace at the end of every blast.
 *
 * The other direction is worse and is why this is a fraction rather than a flat subtraction: if
 * the kill window ever outlived the drawing, people would die to fire that was not on screen. */
export const FIRE_LETHAL_NUM = 2, FIRE_LETHAL_DEN = 3;
export const FIRE_LETHAL_TICKS = Math.round((FIRE_TICKS * FIRE_LETHAL_NUM) / FIRE_LETHAL_DEN);
export const MAX_BOMBS = 16;        // hard ceiling on bombs alive anywhere, a safety valve

/* What one player can have out at once, and how far one reaches. Eight and five.
 *
 * Eight bombs is deliberate, and spam is the point: a flurry is meant to be a thing you can
 * actually throw. Nothing else was needed to make it spammable - placement is one bomb per key
 * PRESS with no cooldown (see place()), so the cap was the only thing ever limiting a flurry.
 *
 * It was briefly five, on the argument that eight bombs is most of a corridor at once and leaves
 * a kitted player with nothing to aim at. That argument is answered by the RADIUS cap rather than
 * by the bomb count: five bombs of reach five cover far more floor than eight of reach five, and
 * it is reach, not count, that decides whether position still matters. So the count goes up and
 * the radius stays where it is - a player with eight bombs still has to place them somewhere.
 *
 * MAX_BOMBS above is NOT a second cap on this. It is declared and never read by anything; do not
 * mistake it for a live safety valve that needs raising alongside this number.
 *
 * A powder keg is deliberately above the radius cap (POWDER_RADIUS), which is how the renderer
 * and the sound both identify one without a flag on the wire. MAX_RADIUS not moving is what keeps
 * that gap intact, and test/bombs.test.js asserts it.
 */
export const MAX_BOMBS_CARRIED = 8;
export const MAX_RADIUS = 5;
/* Two, not one.
 *
 * One bomb is a tutorial: with a single fuse out you cannot break a wall and threaten anybody in
 * the same breath, so the opening of every round was spent farming crates in silence. Two is the
 * smallest number that lets you commit one and still answer with the other, which is where the
 * game actually starts. The carry cap is 8, so this is a head start rather than a ceiling.
 *
 * `scatterOnDeath` drops the bombs you collected ABOVE this number, so raising it also means the
 * two you always have are never scattered - you respawn able to play rather than able to farm.
 */
export const START_BOMBS = 2;
export const START_RADIUS = 1;
export const CHAIN_CAP_PER_TICK = 64; // safety valve, see docs/RULES.md §3

/* Kicking a bomb. See `kick` and `slideBombs` in sim/bombs.js.
 *
 * Game of Bombs rules, which is the genre's: sliding into a bomb SENDS IT SKATING across the
 * floor in the direction you were going. It keeps its fuse the whole way and stops the moment it
 * meets anything - a wall, the sea, another bomb, or a person. Then it sits there, still ticking,
 * and whoever it stopped against can kick it straight back.
 *
 * This replaces a first version that removed the bomb from the game entirely. That was simpler
 * and strictly defensive; this is the real mechanic, and it is better because it has
 * COUNTERPLAY - a kicked bomb is a thrown weapon the target can throw back, rather than a save
 * with no answer. It also means a kick no longer needs any bookkeeping about the owner's bomb
 * slot: the bomb is still on the board, so the slot is still spent, by the ordinary rule.
 *
 * THIRTEEN FIFTHS of a tick a tile - 2.6, so 11.5 tiles a second. Six ticks was the first number
 * and it was far too slow: a bomb you can stroll away from is not a weapon. Three was the second,
 * and this is that 15% faster again.
 *
 * A RATIO rather than a count, because the tick is an integer and 2.6 is not. A hop is scheduled
 * for a whole number of ticks and the fraction left over is carried into the next one, so the
 * hops run 3, 3, 2, 3, 2 and five of them take exactly thirteen ticks. Rounding instead - 3, or
 * 2 - is the only alternative, and it is a 15% error in the pace of the headline mechanic in a
 * game where the same arithmetic has to come out identically on two machines. Carrying the
 * remainder costs one small integer on the bomb and is exact.
 *
 * Every hop therefore has its own length - 3, 3, 2, 3, 2 - which is one of the reasons the client
 * does not draw the motion from the hop schedule at all. It dead-reckons at this pace and treats
 * the bomb's tile as a leash; three attempts at deriving the drawn position from (tile, clock)
 * stepped, because the tile arrives in bursts and the clock does not. See client/render.js.
 *
 * KICK_MAX_TILES is the range. Eight tiles, then it stops wherever it got to and sits there
 * ticking. Unbounded travel made a kick a way to post a bomb to the far side of the map, which is
 * neither aimable nor answerable; eight is far enough to clear a room and short enough that the
 * person who kicked it is still part of what happens next.
 */
export const KICK_TILE_NUM = 13, KICK_TILE_DEN = 5;
export const KICK_MAX_TILES = 8;

/* A parting shot. One death in ten leaves a live bomb on the tile where it happened.
 *
 * Owned by the player who died, so a kill it gets is credited to them: dying is the one moment in
 * the game you have no agency at all, and a one-in-ten chance of taking somebody with you is a
 * reason to look at a fresh corpse with suspicion rather than walking over it for the perks.
 *
 * It costs the dead player no bomb slot - `placeable` counts live bombs by owner, and a dead
 * player is not placing anything, so there is nothing to account for. Rolled from `state.next`
 * like every other chance in the simulation; `Math.random` here would desync.
 */
export const DEATH_BOMB_ONE_IN = 10;
export const SHRUB_RADIUS_PENALTY = 1;

// ─── Blocks ───────────────────────────────────────────────────────────────────

export const BLOCK = {
  FLOOR: 0,
  SOFT: 1,
  REINFORCED: 2,
  MONOLITH: 3,
  IRON: 4,
  COLUMN: 5,
  SHRUB_WALK: 6,
  SHRUB_SOLID: 7,
  // Everything outside the island. Behaves exactly like IRON to the simulation - not walkable,
  // not destructible, stops fire - and exists only so the renderer can tell "the sea" from "a
  // wall" and so a map can be any shape it likes inside its bounding rectangle.
  WATER: 8,
  // A powder keg. Destructible like a soft wall, but detonating one sets off a blast several
  // times the size of the bomb that lit it. Rare on purpose - see POWDER_* below.
  POWDER: 9,
  // Ice. Breaks in one hit like a soft wall, but melts instead of breaking: it floods its own
  // tile and the four next to it with a short-lived puddle. See ICE_* and PUDDLE_* below.
  ICE: 10,
};

export const BLOCK_HP = {
  [BLOCK.FLOOR]: 0,
  [BLOCK.SOFT]: 1,
  [BLOCK.REINFORCED]: 6,
  [BLOCK.MONOLITH]: 9,
  [BLOCK.IRON]: 0,        // 0 = indestructible
  [BLOCK.COLUMN]: 0,
  [BLOCK.SHRUB_WALK]: 0,
  [BLOCK.SHRUB_SOLID]: 0,
  [BLOCK.WATER]: 0,
  [BLOCK.POWDER]: 1,      // one hit, like a soft wall: the point is the explosion, not the siege
  [BLOCK.ICE]: 1,
};

export const BLOCK_DESTRUCTIBLE = b => BLOCK_HP[b] > 0;
export const BLOCK_WALKABLE = (b, reduced) =>
  b === BLOCK.FLOOR || b === BLOCK.SHRUB_WALK || (reduced && b === BLOCK.COLUMN);

/* How often walls grow back. Fifteen percent faster: every 17 s, down from 20.
 *
 * The PERIOD, not the amount - the two scalings in `regenerate` decide how many walls each cycle
 * places, and this decides how often it asks. Shortening the period tightens the map everywhere
 * evenly, including early, where the emptiness scaling still has nothing to react to.
 */
export const REGEN_EVERY_TICKS = 17 * TICK_HZ; // 510
export const REGEN_PER_CYCLE = 3;
export const REGEN_CLEAR_RADIUS_TILES = 4;

/* How much the regrowth rate rises over the course of a round, independently of the map's fill.
 *
 * There are two reasons for a wall to grow back and they answer different questions. The fill
 * scaling in `regenerate` answers "is there cover left" - and it can only answer it AFTER the
 * cover is gone, because bareness is its input. These answer "should this round be tightening",
 * off the clock, which is knowable from the first tick.
 *
 * It matters now because the round is six minutes rather than ten: by the time the fill term has
 * noticed an arena has been chewed open, the round is nearly over, so the cover it grants arrives
 * for a fight that has already finished. Doubling by the final minute is felt without being
 * chaotic, and the two terms multiply - a late round on a bare map tightens hard, a late round on
 * a map that is still mostly walls stays capped by REGEN_MAX_FILL and barely changes.
 *
 * Interpolated linearly across `state.tick / state.roundTicks`. A state with no `roundTicks` -
 * a bot bench, most tests - reads as the start of the round and is therefore unscaled.
 */
export const REGEN_PROGRESS_AT_START = 1;
export const REGEN_PROGRESS_AT_END = 2;

/* Powder kegs.
 *
 * A capped number in a round, and at least one guaranteed - a map event you can plan around is
 * worth far more than a random one you might never see. Placement rides on the existing regrowth
 * cycle (every 20 s) because that function already knows which tiles are quiet: dropping a keg
 * next to a player would be a free kill nobody could read coming.
 *
 * The blast is a bomb with a much larger radius, detonating on the tick the keg breaks. Nothing
 * special in the blast code - a keg IS a bomb, which is why it chains through other kegs, bombs
 * and walls exactly the way you would expect.
 */
// Twelve a round, and the per-cycle chance is set high to match - the cap alone would only have
// meant the same six kegs with room for more that never arrived. Over a six-minute round that is
// a keg every thirty seconds or so: terrain you plan around rather than an event you remember.
export const POWDER_MAX_PER_ROUND = 12;
export const POWDER_RADIUS = 7;
export const POWDER_CHANCE_PER_CYCLE = 0.72;
/* Three fifths of the way in, the first one stops being optional. A round must never pass
 * without one.
 *
 * A FRACTION of the round, not a wall-clock time. It was `0.6 * 10 * 60 * TICK_HZ` - six minutes,
 * written out, from when a round was ten. Shortening the round to six left the guarantee landing
 * on the final tick, so a round could and did end with the roll still never having been forced.
 * Expressed against ROUND_TICKS it survives the next change to the round length too. */
export const POWDER_GUARANTEE_TICK = Math.round(0.6 * ROUND_TICKS);

/* Ice, and the puddle it leaves.
 *
 * One soft wall in twenty is ice, at map generation and when walls grow back. Rare enough that a
 * patch of water is an event, common enough that every map has a few.
 *
 * A blast that reaches ice melts it - no perk, the water IS the drop - and floods the ice tile
 * plus its four neighbours, wherever those are walkable. Five tiles at most. The puddle lasts
 * EIGHT seconds, the last PUDDLE_FADE_TICKS of them visibly drying up.
 *
 * Eight, up from four. At four a puddle was gone before anybody but the person who made it
 * could do anything about it: ice is one soft wall in twenty, so a patch of water is a rare
 * thing to find, and a rare thing that evaporates before you can cross the map to use it is a
 * rare thing nobody ever uses. Eight seconds is long enough for the fight to move INTO the
 * water, which is the point of having it - it is terrain, not a side effect.
 *
 * Standing in water halves your pace and makes you slide: let go of the keys and you carry on
 * the way you were going for PUDDLE_SLIDE_TICKS before you stop. Momentum, not ice-rink chaos -
 * at half pace that is about a third of a tile, enough to overshoot a corner you were braking
 * for and not enough to carry you into a blast you were standing clear of. */
/* Seagulls.
 *
 * Now and then a gull crosses the island - a couple at a time usually, four at most - on a straight
 * line with a lazy weave in it, entering and leaving well outside the board. It is scenery right
 * up until somebody catches one in a blast, and then it drops a gold coin.
 *
 * Catching one is meant to be HARD, and three things make it so:
 *   - it is only low enough to hit during a dive: a short dip every few seconds, the bottom
 *     GULL_LOW_TICKS of it, which you can read coming from its shadow closing in under it;
 *   - only fire still in its lethal window counts, the same window that kills players;
 *   - it is quick - about four tiles a second - and over water there is nothing to burn it with.
 * So it is a timing shot against a moving target, which is the most satisfying thing a bomb can
 * do in a game about standing still in the right place.
 *
 * The coins do not count against GOLD_MAX_PER_ROUND. That cap is about the floor paying out
 * by luck; these were earned.
 */
export const GULL_FIRST_TICK = 25 * TICK_HZ;         // the first one comes early, so people see it
// Twice as often as it was, which was 40-90 s. At that spacing most rounds saw three or four
// birds and a player who wanted to try the shot had to wait a minute for a second attempt; a
// trick shot nobody gets to practise is a trick shot nobody lands.
export const GULL_GAP_MIN_TICKS = 10 * TICK_HZ;      // one every 10-22 s
export const GULL_GAP_MAX_TICKS = 22 * TICK_HZ;
// Twice the birds, and the gap above is halved to match - the cap alone would only have meant
// four gulls arriving at the old spacing, which is the same sky with a longer queue.
export const GULL_MAX = 4;
/* Each bird gets its own height, and that is where the depth comes from.
 *
 * Looking straight down, height has only three tells: how big the bird is, how far its shadow
 * sits from it, and how fast it seems to cross. One altitude for every gull spends all three at
 * once and the sky reads as a sticker sheet. A band does the opposite: a low bird is big, sharp,
 * quick, with its shadow close; a high one is small, hazy, slow, trailing a soft shadow a long
 * way off. Same flight description, four layers of sky.
 *
 * Purely presentational - nothing about the shot changes, because the hit rule stopped caring
 * about altitude when GULL_LOW_ALT stopped being a defence. A high bird is exactly as catchable
 * as a low one; it just looks further away.
 */
export const GULL_DEPTH_MIN = 0.8, GULL_DEPTH_MAX = 1.3;
// A fifth slower than the 34 it was: about three tiles a second. Speed was doing too much of the
// difficulty on its own - at four tiles a second the window over any one tile was shorter than a
// fuse, so the only way to land it was to have already had a bomb there.
export const GULL_SPEED_UNITS = 27;
export const GULL_OFFMAP_TILES = 4;                  // how far outside the map it enters and leaves
/* It dawdles over the island and hurries over the sea.
 *
 * The flight is a straight line at a constant pace, and the pace that makes the middle of it
 * - the part over the board, the only part you can do anything about - worth aiming at is much
 * slower than the pace that keeps the empty sea crossing from being dull. So progress along the
 * line is eased rather than linear: `f + k·sin(2πf)/2π`, which leaves both ends where they were
 * and runs at (1 + k·cos 2πf) of the average pace - a little over half speed across the middle,
 * half again as fast on the way in and out. Total flight time is unchanged, so nothing else has
 * to know. Closed form and monotonic for k < 1, which is what keeps `gullAt` a description of a
 * flight rather than a simulation of one.
 */
export const GULL_LOITER = 0.45;
export const GULL_WEAVE_UNITS = 300;                 // the side-to-side drift, a little over a tile
export const GULL_WEAVE_TICKS = 170;                 // ...over about six seconds
export const GULL_DIVE_EVERY_TICKS = 105;            // a dive every three and a half seconds
export const GULL_DIVE_TICKS = 27;                   // each lasting a bit under one
// The bottom of the dive, when it is low enough to burn: the middle two fifths of each dive,
// about eleven ticks, which is one tick in nine of its flight.
export const GULL_LOW_ALT = 0.22;
/* What one is worth, and it goes straight to whoever lit the fire.
 *
 * It used to drop a single coin on the nearest clear floor tile, which was the wrong shape for
 * the thing it was rewarding: the hard part is the shot, and a coin on the ground after it turns
 * the hard part into a race to the spot - often won by somebody who had nothing to do with it,
 * and sometimes by nobody at all when the only floor nearby was about to be on fire. Three,
 * because it is the rarest thing in the game and a reward you can lose by half a second is not a
 * reward. A blast with no owner - a powder keg - still leaves a coin on the floor; see gulls.js.
 */
export const GULL_COINS = 3;
// A gull raid is a rough day, but it still pays the person who survived the story nine coins.
export const GULL_RAID_COINS = 9;
/* The raid: once a round, two gulls pick somebody and kill them.
 *
 * Late in the round, two birds come in fast and low from opposite sides, cross over one player
 * and that player is dead. No shield saves them, nothing they can do about it, nobody gets the
 * kill. It is the island's own joke at somebody's expense, and the scoreboard remembers who.
 *
 * Why it is fair even though it cannot be dodged: it is ONE death, at the far end of the round,
 * credited to nobody, and everyone in the room watches it happen. A death you could have avoided
 * is a mistake; this is weather. Both are funny, and only one of them is your fault.
 *
 * Only a real person - a bot being claimed by the gull raid is nobody's story. Between 70% and 90% of
 * the round, so it always lands while people are still playing but never at the whistle, where
 * it would read as a bug in the scoring rather than as a bird.
 */
export const GULL_RAID_AT_MIN = 0.7, GULL_RAID_AT_MAX = 0.9;
// Protect players who arrive once the final 70% of the round has begun.
export const GULL_RAID_LATE_JOIN_FRACTION = 0.3;
export const GULL_RAID_SPEED_UNITS = 105;            // about four times a cruising gull
export const GULL_RAID_RUN_TILES = 11;               // how far out they turn and start the run
export const GULL_RAID_RETRY_TICKS = 20;             // nobody alive to pick on: look again shortly

export const ICE_CHANCE = 0.05;
export const PUDDLE_TICKS = 8 * TICK_HZ;
// The drying-up, scaled with the lifetime so the tail is still the same share of it - a puddle
// that sits full for six and a half seconds and then vanishes in a blink reads as a bug.
export const PUDDLE_FADE_TICKS = Math.round(3 * TICK_HZ);   // render only
export const PUDDLE_SPEED_NUM = 1, PUDDLE_SPEED_DEN = 2;
export const PUDDLE_SLIDE_TICKS = 8;

/* Stamina.
 *
 * Running flat out for ten seconds empties it; once empty you move at half pace until you have
 * recovered a third of it back. The hysteresis is the important part - a bare "zero means slow"
 * rule flips the speed on and off every single tick at the boundary, which is unplayable and
 * looks like lag.
 *
 * It regenerates whether you are moving or not, just twice as fast when you stand still. That
 * makes stopping a real tactical choice rather than a punishment, and it means an exhausted
 * player is never stuck: limping still refills, slowly.
 */
/* Counted in TWENTIETHS of a unit, so every rate stays a whole number.
 *
 * The sim is integers only - floats in a shared simulation are a determinism bug waiting for a
 * platform that rounds differently. Each time these rates want a percentage change, the unit has
 * to be fine enough to express it: wanting 15% off rates of 1 and 2 made the unit tenths, and
 * wanting another 15% off a drain of 10 made it twentieths, because 8.5 is not a whole number
 * either. Doubling the resolution is free - nothing reads these as anything but a ratio against
 * STAMINA_MAX - and it leaves room for the next tweak.
 *
 * The numbers, in seconds, which is the only unit anybody can feel:
 *
 *   running     6900 at 17 a tick is 13.5 s, up from 11.5. The drain is 15% slower, so the bar
 *               takes 15% longer to reach the end.
 *   standing    6900 at 53 a tick is 4.3 s from empty to full, down from 5. Regen is 15% faster,
 *               so catching your breath is quicker than it was.
 *   limping     28 a tick while exhausted - the same 15% on the slower of the two regens, so
 *               the relationship between them is untouched: standing is still about twice as
 *               good as limping, which is what makes stopping a decision.
 */
export const STAMINA_MAX = 6900;
// 11, down from 17: a third less drain, so a bar lasts half again as long and sliding is a tool
// you reach for rather than a budget you nurse.
export const STAMINA_DRAIN_PER_TICK = 11;
export const STAMINA_REGEN_MOVING = 28;            // only while exhausted; see movement.js
export const STAMINA_REGEN_IDLE = 53;
export const STAMINA_RECOVER_UNITS = Math.round(STAMINA_MAX / 3);
export const STAMINA_TIRED_NUM = 1, STAMINA_TIRED_DEN = 2;   // half pace when exhausted
// Below this fraction the indicator appears beside the player. Above it nothing is drawn: a
// meter that is always on screen is a meter nobody looks at. Raised from a half to seven tenths
// - at a half the warning and the limp arrived almost together, which is a notification rather
// than a warning.
export const STAMINA_SHOW_AT = 0.7;
// Below this the gauge goes red and flashes. A third, which is also STAMINA_RECOVER_UNITS - the
// point the exhausted latch lets go - so the warning zone and the recovery line are the same
// line, and the red means one thing: from here, running out is a live possibility.
export const STAMINA_LOW_AT = 1 / 3;
// Each Stim adds this much to your ceiling, up to MAX_STAMINA_LEVELS of them. Four of them takes
// thirteen and a half seconds of running to twenty-seven. Scaled with STAMINA_MAX, so a Stim is
// still worth two and a bit seconds rather than quietly becoming worth one.
export const STAMINA_PER_LEVEL = 1500;
export const MAX_STAMINA_LEVELS = 4;
export const staminaMaxFor = p => STAMINA_MAX + Math.min(p?.staminaLevel ?? 0, MAX_STAMINA_LEVELS) * STAMINA_PER_LEVEL;

// ─── Perks ────────────────────────────────────────────────────────────────────

export const PERK = {
  BOMB: 1, FIRE: 2, SKATE: 3, SHIELD: 4,
  // 5 was the Gift, a random perk that sometimes handed out a disease. Removed; the number stays
  // retired so an old client never mistakes a new perk for it.
  // Reserved - designed for, not implemented in v1. Give one a weight to turn it on.
  KICK: 6, JELLY: 7, DETONATOR: 8, BAT: 9, JETPACK: 10,
  NUKE: 11, BLUE_FIRE: 12, HEART: 13, KEY: 14,
  // Raises your maximum stamina, so you can run for longer before the limp.
  STAMINA: 15,
  // Rum: tough and useless. See STATUS.DRUNK.
  RUM: 16,
  /* A gold coin. Changes nothing about how you play and is the rarest thing on the board.
   *
   * Every other perk is a capability. This is a COLLECTIBLE: it makes no difference to the
   * round you are in, it survives the round you are in, and it is the only thing here that
   * accumulates. Currency later; for now it is a number that goes up, which is most of what
   * currency is anyway. */
  GOLD: 17,
   // A rare, temporary ghost state. It is not a permanent stat or a shop upgrade.
   INVISIBLE: 18,
  /* A pocket watch: every bomb you place for the next twenty seconds has half a fuse.
   *
   * Temporary and timed, like the Rum and the Veil, rather than a stat you keep - it is a window
   * you have to spend, not a loadout you accumulate. It grants STATUS.FAST_DET, which the bomb
   * code already honoured (see FUSE_TICKS_FAST): the mechanic was built and had nothing that
   * handed it out.
   *
   * Not PERK.DETONATOR, which stays reserved. A detonator is remote detonation - you choose the
   * moment - and this is the opposite bargain: the fuse is shorter whether that suits you or
   * not, which is what makes it double-edged rather than simply better.
   */
  CLOCK: 19,
};

/* Gold coins. 2% of drops and never more than five a round.
 *
 * Two limits, not one, and they do different jobs. The WEIGHT makes any given coin a surprise.
 * The CAP makes the surprise finite: without it a long round on a map full of soft walls pays
 * out far more than a short one on a sparse map, so the reward would be a function of the map
 * rather than of the player. Five is about one every two minutes at the top end.
 *
 * Worth enough XP to be noticed, but less than one fifth of a kill.
 */
export const GOLD_MAX_PER_ROUND = 5;

/* What actually drops.
 *
 * Bombs and Fire are the backbone of the game - without them everybody is stuck on one bomb at
 * radius one for ten minutes, and there is no way to build a turn around anything. Everything
 * below the live row is reserved and has always been zero. A perk at zero weight costs nothing
 * and switches back on with one number.
 */
export const PERK_WEIGHTS = {
  /* 9 of 431 is 2.1%, slightly rarer than either special status drop. */
  [PERK.GOLD]: 9,
  /* The two special status drops share a rare weight: 11 of 422 non-gold rolls each. */
  [PERK.BOMB]: 108, [PERK.FIRE]: 100, [PERK.SKATE]: 72, [PERK.SHIELD]: 48,
  [PERK.STAMINA]: 72, [PERK.RUM]: 11, [PERK.INVISIBLE]: 11, [PERK.CLOCK]: 11,
  [PERK.KICK]: 0, [PERK.JELLY]: 0, [PERK.DETONATOR]: 0, [PERK.BAT]: 0, [PERK.JETPACK]: 0,
  [PERK.NUKE]: 0, [PERK.BLUE_FIRE]: 0, [PERK.HEART]: 0, [PERK.KEY]: 0,
};

export const PERK_DROP_CHANCE_SOFT = 0.35; // TUNE - the baseline, before supply and demand
// Ordinary rolled powerups are thinned after selection. Gold bypasses this entirely, so its
// absolute chance and round cap stay exactly as tuned above rather than inheriting the spare 20%.
export const NON_GOLD_DROP_KEEP_CHANCE = 0.8;

/* How the drop rate responds to the board.
 *
 * A flat chance is wrong at both ends of a round. Early on sixteen players open walls at once,
 * perks pile up faster than anyone can walk to them, and the floor turns into a buffet. Late on,
 * with the soft walls gone and everyone fully kitted, nothing drops for minutes. Both ends are
 * the same bug: the rate ignores how many perks are actually lying around and how fast they are
 * being taken.
 *
 * Supply: count what is on the floor against a target that scales with the number of players
 * alive, because that is who is competing for them.
 * Demand: an exponential moving average of pickups, so a board being cleared quickly refills
 * quickly. HALFLIFE is in ticks; DECAY is derived from it so the two cannot drift apart. */
export const PERK_TARGET_PER_PLAYER = 0.9;
export const PERK_TARGET_MIN = 3;
export const PERK_SCARCE_BOOST = 2.2;      // empty floor: more than double the base rate
export const PERK_GLUT_FLOOR = 0.25;       // at or past target: a quarter of it
export const PERK_TAKE_HALFLIFE_TICKS = 8 * TICK_HZ;
export const PERK_TAKE_DECAY = Math.pow(0.5, 1 / PERK_TAKE_HALFLIFE_TICKS);
export const PERK_DEMAND_BOOST = 0.8;      // at most +80% when the board is being stripped
export const PERK_DROP_ALWAYS = [BLOCK.REINFORCED, BLOCK.MONOLITH];
/* Two minutes on the floor, not forty-five seconds.
 *
 * A perk you can see across the board and cannot reach yet is a reason to go there, and at
 * forty-five seconds the answer to "is that worth crossing for" was usually no: it had gone by
 * the time you arrived, which turns a decision into a dice roll. */
export const PERK_EXPIRE_TICKS = 120 * TICK_HZ;
/* How long a perk spends visibly dying before it is removed.
 *
 * A drop that vanishes between two frames reads as a bug, or as somebody else having taken it
 * from across the map. Fading it out turns the same event into information you can act on: a
 * perk you can see going translucent is one you have a few seconds left to reach. Purely a
 * render concern - the sim still removes it on the exact tick.
 *
 * Five seconds of it, and it used to be fifteen - a third of the perk's whole life spent dying,
 * which meant the normal state of a perk on this board was "leaving". Five is long enough to
 * sprint for and short enough that a perk standing there looks like it is staying. */
export const PERK_FADE_TICKS = 5 * TICK_HZ;
export const PERKS_DROPPED_ON_DEATH = 3;
// Two, so a shield can be stacked: each one survives one hit, and a second is worth walking to
// rather than a capped pickup. Drawn on the player as a blue ring per shield - see drawShields.
export const MAX_SHIELDS = 2;

/* One shield per hit, and a moment's grace after it. Never two shields in one instant.
 *
 * The rule before this was "every blast that reaches you costs a shield the tick it arrives, and
 * two at once cost two". That is defensible and it played terribly: a chain reaction or a
 * crossfire is ONE event as far as the player is concerned, and walking into it with two shields
 * and coming out with none - having survived, having done nothing wrong, with no chance to react
 * in between - made the second shield feel like it had never existed. The whole reason to walk
 * across the map for a second shield is that it is a second chance, and a second chance you can
 * lose in the same frame as the first is not one.
 *
 * So a shield that absorbs a blast also buys this many ticks in which nothing can touch you:
 * further blasts in the window are simply shrugged off, and the NEXT one after it comes out of
 * the next shield. Eighteen ticks, six tenths of a second - comfortably longer than a blast's
 * lethal window (FIRE_LETHAL_TICKS), so one explosion can never reach past the grace it just
 * triggered, and short enough that it is a flinch rather than a free run through a fire.
 *
 * ─── and then back, for blasts that land on the same tick ───
 *
 * With health in the game (MAX_HP), "one shield for any number of blasts" made a crossfire the
 * safest place to stand. So blasts that reach you on the SAME tick - a chain whose flames cross
 * on you - are each paid for: two shields, a shield and a half, or both halves. The grace still
 * covers everything AFTER that tick, so a blast arriving a moment later is shrugged off and no
 * explosion can come back for more. See killInFire in sim/round.js.
 */
export const SHIELD_GRACE_TICKS = 18;

/* Health: two hits, and only two states - whole, or one hit from dead.
 *
 * Everybody spawns whole. The first fire that gets past your shields takes you to half; the
 * second kills. Shields are spent first, whatever your health, so a shield is always a whole hit
 * saved and never a top-up. A hit opens the same grace a shield does, so a blast a moment later
 * cannot finish you - but two blasts crossing on you in the same instant are two hits (see
 * SHIELD_GRACE_TICKS). No regeneration: half stays half until you die, which is what makes "he
 * is a ghost" worth chasing. See killInFire in sim/round.js. */
export const MAX_HP = 2;

/* Password length, shared so the hint text and the rule cannot drift apart.
 *
 * The floor is the only composition rule there is: length is the one requirement that survives
 * contact with people, and "must contain a digit" produces "password1". The CEILING is the
 * security-relevant half - scrypt's cost grows with its input, so an unbounded password field is
 * an invitation to burn a core for as long as somebody holds a socket open. The enforcement lives
 * on the server (badPassword in server/accounts.js); the client only quotes these.
 */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

// ─── Statuses ─────────────────────────────────────────────────────────────────

export const STATUS = {
  INVULN: 1, PACIFISM: 2, SLOWDOWN: 4, INVISIBLE: 8,
  CHANGELING: 16, REDUCTION: 32, FAST_DET: 64,
  // Rum. Blast arms stop hurting you; only the tile the bomb was on still does. In exchange
  // you cannot walk straight.
  DRUNK: 128,
  /* Knocked about by somebody sliding into you. A question mark over your head, no bombs, and a
   * quarter off your pace - for a moment. See CONFUSED_TICKS.
   *
   * The three together are the point. Taking the bombs away is what makes a slide a MOVE rather
   * than a faster walk: you can barge through the pirate holding a doorway and they cannot answer
   * by dropping one at your feet. The slowdown is small and short because it is a stumble, not a
   * disease - and it is not CONTAGIOUS, because it did not come from a bottle.
   */
  CONFUSED: 256,
};

export const STATUS_TICKS = {
  [STATUS.INVULN]: 90,        // 3 s from respawn
  [STATUS.PACIFISM]: 300,
  [STATUS.SLOWDOWN]: 300,
  [STATUS.INVISIBLE]: 600,     // 20 s: 25% longer than its former 16 s duration
  [STATUS.CHANGELING]: 300,
  [STATUS.REDUCTION]: 450,
  // Twenty seconds, matching the Veil. Was 10 s, from before anything granted it.
  [STATUS.FAST_DET]: 600,
  // 389 ticks, just under 13 s: an 8% extension of the former 360-tick duration.
  [STATUS.DRUNK]: 389,         // 13 s: 8% longer than its former 12 s duration
  // 45 ticks, a second and a half. Short on purpose: it is there to buy the slider the doorway,
  // not to take somebody out of the fight. Long enough to matter, over before it is annoying.
  [STATUS.CONFUSED]: 45,
};

// A quarter off your pace while you are seeing stars. Integer division like every other
// multiplier here, so the sim stays float-free.
export const CONFUSED_NUM = 3, CONFUSED_DEN = 4;

/* How drunk is drunk.
 *
 * The sway is a slow wander added to your heading, in units, applied across the axis you are
 * walking along. Not a random walk and not an input inversion: inversion is just broken
 * controls, and randomness cannot be predicted by the client, which would make every step a
 * reconciliation. It is a sum of two sines on the tick, seeded per player, so both machines
 * compute the same stagger and it still never repeats in a way anybody notices.
 */
/* The sway and the stagger are GONE; see DRUNK_FUMBLE_EVERY, which replaced them.
 *
 * Both moved you across the line you were walking along, and on rails there is no across to be
 * moved into - the invariant is that you are on a lane centre, so a sideways nudge is not a cost,
 * it is an impossibility. The cost had to stay, because a defensive perk with no downside is just
 * a better perk, so it moved to the one place a rail pirate makes a decision: the turns.
 */

/* The death-screen cooldown happens before SPACE is accepted. Once requested, a separate
 * countdown gives the player a clear 3, 2, 1 before the server places them.
 *
 * Five seconds, down from eleven. Eleven was tuned against a ten-minute round, where sitting out
 * a sixtieth of it was a real cost; in a six-minute round it is a thirty-sixth, and the thing that
 * actually makes a death expensive is losing the loadout, not the wait. The three-second countdown
 * now covers most of the wait rather than a quarter of it, which is why the two are tested against
 * each other rather than only against themselves. */
export const RESPAWN_DELAY_TICKS = 5 * TICK_HZ;
export const RESPAWN_COUNTDOWN_TICKS = 3 * TICK_HZ;

export const CONTAGIOUS = STATUS.PACIFISM | STATUS.SLOWDOWN |
                          STATUS.CHANGELING | STATUS.REDUCTION | STATUS.FAST_DET;
export const CONTAGION_COOLDOWN_TICKS = TICK_HZ; // 1 s per pair

// ─── Scoring & ranks ──────────────────────────────────────────────────────────

export const SCORE = {
  KILL: 450,
  SUICIDE: -35,
  PERK: 5,
  PERK_CAPPED: 15,
  BLOCK: 2,
  SURVIVE_ROUND: 50,
  // A gold coin, 2% of drops and capped at five a round.
  GOLD: 65,
};

// ─── Levels ───────────────────────────────────────────────────────────────────
//
// XP is lifetime score. The curve is calibrated against the real scoring table rather than
// guessed: a decent player in a ten-minute round takes roughly 20 kills (9000), 150 blocks (300),
// 40 perks (200) and the survival bonus, minus about ten suicides (350), for ~9200 a round.
// Round 55 200 per hour down to 48 000 to be honest about the average session.
//
// From there the only free parameters are where level 1 lands and where Veteran does. Level 1 at
// 200 XP is about a minute, which is the right feel for a first level; Veteran at 20 is pinned to
// 100 hours by the brief, and the exponent is DERIVED from those two rather than tuned by hand -
// so changing the hours or the scoring table moves the whole curve correctly instead of silently
// making the target wrong.
export const XP_PER_HOUR = 48_000;
export const HOURS_TO_VETERAN = 100;
export const VETERAN_LEVEL = 20;
export const XP_LEVEL_BASE = 200;
export const XP_LEVEL_EXP =
  Math.log((XP_PER_HOUR * HOURS_TO_VETERAN) / XP_LEVEL_BASE) / Math.log(VETERAN_LEVEL);

/** Total XP needed to have reached a level. Level 0 is where everybody starts. */
export const xpForLevel = n =>
  (n <= 0 ? 0 : Math.round(XP_LEVEL_BASE * Math.pow(n, XP_LEVEL_EXP)));

export const levelForXp = xp => {
  if (!(xp > 0)) return 0;
  // Invert the curve directly rather than looping: levels are unbounded above Veteran, and a
  // loop would be the one place a very long-lived leaderboard could stall.
  const n = Math.floor(Math.pow(xp / XP_LEVEL_BASE, 1 / XP_LEVEL_EXP));
  return xp >= xpForLevel(n + 1) ? n + 1 : n;
};

// The ladder. Four names, because a name you reach in an afternoon is not a rank.
export const TIERS = [
  { from: 0, name: 'Rookie' },
  { from: 11, name: 'Been around the block' },
  { from: 16, name: 'Pro' },
  { from: VETERAN_LEVEL, name: 'Veteran' },
];

export const tierForLevel = level => {
  let name = TIERS[0].name;
  for (const t of TIERS) if (level >= t.from) name = t.name;
  return name;
};

/**
 * Everything the UI needs to draw a progress bar, in one place so the server and the client can
 * never disagree about how far along somebody is.
 */
export function progressFor(xp) {
  const total = Math.max(0, xp | 0);
  const level = levelForXp(total);
  const floor = xpForLevel(level);
  const next = xpForLevel(level + 1);
  const span = Math.max(1, next - floor);
  return {
    xp: total,
    level,
    tier: tierForLevel(level),
    into: total - floor,          // XP earned since this level started
    need: span,                   // XP this level is worth
    nextAt: next,
    fraction: Math.min(1, (total - floor) / span),
  };
}

// ─── Net ──────────────────────────────────────────────────────────────────────

export const INTERP_DELAY_TICKS = 4;     // ≈133 ms behind, for remote players only
export const CLOCK_SAFETY_MS = 50;       // added to rtt/2 when computing the client's lead
export const PING_EVERY_MS = 2000;
export const RTT_SAMPLES = 5;            // rolling minimum, see docs/NETCODE.md §2
export const PING_BURST_GAP_MS = 100;
export const MAX_MESSAGE_BYTES = 4096;
export const CHAT_MAX_CHARS = 140;
export const CHAT_MIN_INTERVAL_MS = 1000;
export const NAME_MAX_CHARS = 20;

// A backgrounded tab stops being a player. Browsers throttle rAF in hidden tabs to about once a
// second, so a background tab cannot play - it can only hold a seat other people want and drift
// its clock. Input is cut the moment it hides; the socket goes after this.
export const IDLE_DISCONNECT_MS = 45_000;

// The server's own version, for the cases the client cannot report: a slept laptop, a killed
// renderer process, a tab the browser froze outright. A seat that has sent no input at all for
// this long is not being played and is given back.
export const IDLE_KICK_TICKS = 90 * TICK_HZ; // 90 s

// ─── Presentation ─────────────────────────────────────────────────────────────
// Here rather than in art.js because the sim's tracer sampling rate must match the renderer's.

// How long a freshly spawned player is drawn oversized, shrinking to normal. Appearing out of
// nowhere in a sixteen-player scrum is invisible otherwise, and you need to know instantly
// whether the thing that just materialised is next to you.
/* Arriving. The sprite lands at SPAWN_POP_SCALE times its size and collapses to normal.
 *
 * Twenty is absurd on purpose - at a zoomed-out map that is a pirate the height of the island,
 * which is exactly the point: in a sixteen-player scrum the question "where did I just come
 * back" has to be answerable in one frame, from the far corner of the screen. The quintic
 * ease-out below is what keeps it from being obnoxious: it is past 20x within three frames and
 * spends most of the window near normal size. */
export const SPAWN_POP_TICKS = 30;   // 1 s - 0.8 s slowed by a quarter, on request

/* Joining, or coming back: held off the board for three seconds, then placed.
 *
 * Appearing on the board the instant you join is appearing while the menu is still fading and
 * your eyes are still on the button you pressed - the arrival animation, the one thing that says
 * where you are, played to nobody. So a joining or rejoining player is ARRIVING for this long:
 * not on the board, not dead (no death card, no respawn timer, no score), just not placed yet.
 * Then they are placed through the ordinary respawn, and the arrival plays as they land. */
export const ARRIVE_DELAY_TICKS = 3 * TICK_HZ;
export const SPAWN_POP_SCALE = 20;

export const TRACER_SAMPLES = 8;
export const TRACER_EVERY_TICKS = 3;
export const VOLUME_MUSIC_DEFAULT = 0.10;
export const VOLUME_SFX_DEFAULT = 0.75;

// Applied to every bus, on top of the sliders. A persisted slider value in localStorage would
// survive a change to the defaults above, so halving the output has to happen somewhere the
// user's stored preference cannot override.
export const VOLUME_MASTER = 0.5;

/* Per-bus trim, on top of VOLUME_MASTER.
 *
 * The two buses carried the identical master trim, which is only right if the two want the
 * same headroom - and they do not. Effects are transients with a 12:1 limiter on them and sit
 * under the music more than they should; the music is a continuous mastered mix and arrives
 * hotter than anything synthesised next to it.
 *
 * These multiply the ceiling, not the default: somebody with a stored slider value gets the
 * change too, which a default could never do. */
export const VOLUME_TRIM_SFX = 1.2;     // +20%
// Halved again (was 0.75) at the user's request: the music sat on top of the game.
export const VOLUME_TRIM_MUSIC = 0.375; // -62.5% in all


export const SFX_MAX_DISTANCE_TILES = 12;

// ─── Kill streaks ─────────────────────────────────────────────────────────────
// A living player's kills escalate for the whole round; this window only controls how long the
// active streak power/glow remains visible after the latest kill. ACE is separate.

export const STREAK_WINDOW_TICKS = 22 * TICK_HZ;  // double the active streak duration: 22 s
export const STREAK_NAMES = { 2: 'DOUBLE KILL', 3: 'TRIPLE KILL', 4: 'ULTRA KILL', 5: 'RAMPAGE' };
export const STREAK_ACE = 'ACE';

// ─── Admin ────────────────────────────────────────────────────────────────────

export const GAMESPEED_MIN = 10, GAMESPEED_MAX = 200;   // percent of TICK_HZ
export const BAN_MAX_HOURS = 24;

/* The ZA room's automatic bot policy.
 *
 * The moment a person joins there are at least AUTO_BOTS_MIN bots, so one or two early arrivals
 * have something to fight instead of an empty island. Once no human has been present for
 * AUTO_BOTS_EMPTY_ROUNDS whole rounds the ZA bots are removed. US keeps its configured complement
 * while idle so players arriving there find a populated room.
 *
 * A host removing bots by hand (/kick bot N, or /bots lower than it is) switches the top-up off:
 * re-adding what somebody just deliberately took away is the server arguing with its host. In ZA
 * it comes back on after the room has emptied and stayed empty for those same two rounds. */
export const AUTO_BOTS_MIN = 5;
export const AUTO_BOTS_EMPTY_ROUNDS = 2;

// Wall regrowth stops once this much of the open floor is wall again, or a long round silts up
// into a maze nobody can cross.
export const REGEN_MAX_FILL = 0.55;

/* The sixteen player colours, by hand, each one a word somebody can say out loud.
 *
 * Sixteen hues evenly spaced is the mathematician's answer and it fails the only test that
 * matters: "I am light green" has to mean something to the fifteen other people in the room. At
 * 22.5° apart, four of the sixteen were greens nobody could name apart from each other, three
 * were oranges, and a round with twelve players in it had several pairs that were simply "the
 * two blue ones".
 *
 * So the spacing is uneven and deliberate, and the second and third axes do as much work as the
 * hue. Three rules, and each one came from a confusable pair:
 *
 *   NAMEABLE   every entry is one of the sixteen words below and reads as that word on the sand
 *              and on a dark panel. If it needs a qualifier beyond light/dark, it is out.
 *   SEPARATED  where two names are hue neighbours - cyan, sky, blue - they are pulled apart on
 *              lightness and saturation instead, which is how people tell them apart anyway: sky
 *              is the pale one, blue is the deep one.
 *   DESATURATED where it helps. Tan and white are the two that carry no hue identity at all, and
 *              they are the easiest of the sixteen to name because of it.
 *
 * Lightness never goes below 45: these are read as a 20-pixel sprite against dark sand and as
 * small text on a dark panel, and anything darker disappears into both.
 *
 * Handed out in an order that keeps the first joiners far apart, like the old bit-reversal did -
 * a two-player round should be red and cyan, not red and orange.
 */
const PLAYER_PALETTE = [
  { name: 'red', h: 2, s: 72, l: 56 },
  { name: 'cyan', h: 186, s: 68, l: 58 },
  { name: 'yellow', h: 48, s: 88, l: 62 },
  { name: 'violet', h: 262, s: 62, l: 66 },
  { name: 'green', h: 128, s: 50, l: 48 },
  { name: 'pink', h: 334, s: 78, l: 72 },
  { name: 'sky', h: 204, s: 82, l: 76 },
  { name: 'tan', h: 26, s: 38, l: 52 },
  { name: 'orange', h: 26, s: 92, l: 56 },
  { name: 'blue', h: 224, s: 72, l: 52 },
  { name: 'mint', h: 154, s: 58, l: 72 },
  { name: 'magenta', h: 304, s: 66, l: 56 },
  { name: 'lime', h: 84, s: 66, l: 60 },
  { name: 'teal', h: 174, s: 54, l: 45 },
  { name: 'purple', h: 282, s: 48, l: 47 },
  { name: 'white', h: 210, s: 14, l: 82 },
];

const seatOf = i => ((i % 16) + 16) % 16;

/* A colour belongs to the PLAYER now, not to the seat number.
 *
 * Seats are handed out lowest-free-first, so after a few joins and leaves a small room could be
 * sitting in seats 1, 6, 9 and 13 - cyan, sky, blue and teal, four players nobody could tell
 * apart. So the server picks each player's colour when they sit down and sends the seat-to-colour
 * table with every snapshot (`pal`, sixteen hex digits).
 *
 * The pick walks COLOUR_PREFERENCE and takes the first colour nobody in the room is wearing. Its
 * first eight are the eight most different colours in the palette - different in hue AND in
 * lightness and saturation, and each a plain word: red, cyan, yellow, magenta, green, white,
 * orange, blue. So while the room is DISTINCT_PLAYERS or fewer, everybody is one of those eight
 * and no two are alike. Past eight, the rest come in the palette's own spread-out order.
 *
 * Colours do not move under people. A player keeps theirs for as long as they hold the seat,
 * including across rounds; the only reshuffle is at the start of a round, when the room is down
 * to eight or fewer and somebody is still wearing one of the less distinct colours from a busier
 * stretch. They, and only they, are moved onto a free one of the eight. See server/room.js.
 */
export const DISTINCT_PLAYERS = 8;
const DISTINCT_COLOURS = [0, 1, 2, 11, 4, 15, 8, 9];    // red cyan yellow magenta green white orange blue
export const COLOUR_PREFERENCE = [
  ...DISTINCT_COLOURS,
  ...PLAYER_PALETTE.map((_, k) => k).filter(k => !DISTINCT_COLOURS.includes(k)),
];
export const isDistinctColour = slot => DISTINCT_COLOURS.includes(slot);

/** Seat -> palette slot. Identity until the server says otherwise; see setSeatColours. */
const seatColours = PLAYER_PALETTE.map((_, k) => k);

/** The table as it goes on the wire: one hex digit per seat. */
export const encodeSeatColours = slots => slots.map(k => (k & 15).toString(16)).join('');

/**
 * Adopt the server's table. Returns true when anything changed, so a caller holding colour-keyed
 * caches knows to drop them. Garbage is ignored rather than half-applied.
 */
export function setSeatColours(pal) {
  if (typeof pal !== 'string' || !/^[0-9a-f]{1,16}$/.test(pal)) return false;
  let changed = false;
  for (let i = 0; i < pal.length; i++) {
    const k = parseInt(pal[i], 16);
    if (seatColours[i] !== k) { seatColours[i] = k; changed = true; }
  }
  return changed;
}

/** Which palette slot a seat is wearing. Anything baked per colour is indexed by this. */
export const seatSlot = i => seatColours[seatOf(i)];
/** A palette slot's three numbers, for things baked per colour rather than per seat. */
export const paletteHsl = slot => PLAYER_PALETTE[slot & 15];

/** A palette slot's own colour, for the server, which knows slots rather than a table. */
export const paletteColor = slot => {
  const { h, s, l } = PLAYER_PALETTE[slot & 15];
  return `hsl(${h} ${s}% ${l}%)`;
};

/* ONE definition of what colour a seat is, as three numbers.
 *
 * Everything that paints a player reads this: the name in the chat, the row on the scoreboard,
 * the sprite's three shades, the crown, the rim blip, the fire its bombs make, the server's
 * welcome. They all agreed before - by all doing the same arithmetic in their own file - which is
 * the kind of agreement that holds until somebody adjusts one of them.
 */
export const playerHsl = i => PLAYER_PALETTE[seatColours[seatOf(i)]];
export const playerColor = i => {
  const { h, s, l } = playerHsl(i);
  return `hsl(${h} ${s}% ${l}%)`;
};
/** What to call it. "You are light green" is the whole feature. */
export const playerColorName = i => playerHsl(i).name;
/** Kept for the fire's hue; see fireTones in art.js. */
export const playerHue = i => playerHsl(i).h;
