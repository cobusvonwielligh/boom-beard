# Rails, Kicking, Nightly Restart and Round Tuning — Design

6 November 2026

## Intent

One pass over eleven items raised after last week's games. They are not one feature, but they
share a single theme: the round should be **shorter, busier, and more legible**, and the machine
it runs on should not get slower the longer the day goes on.

The two large items are **rail-lane movement** and **kicking a bomb off the board with a slide**.
Everything else is tuning, two real bugs, and one piece of operations work.

## Goals

- Movement that never refuses a turn and never drifts off a lane.
- A slide becomes defensive: it can remove a bomb that was about to kill you.
- A six-minute round that stays dense from start to finish.
- No perk pickup that the player believes should have worked and did not.
- An empty server comes up fresh each night without anybody logging in.

## Non-goals

- Battle-royale map shrinking. Explicitly deferred.
- Pick-up-and-carry items. Explicitly deferred.
- Escalators and portals. Explicitly deferred.
- Artillery / crosshair strike. Explicitly deferred.
- Mobile layouts, a bundler, or any build step. The project is no-build and stays no-build.

## Anti-goals

Things that would make this a failure even if every item shipped:

- **Rails that feel like being driven.** If a player ever presses a direction and the pirate does
  something other than what they asked, the movement work has failed, however correct it is.
- **A desync.** `shared/sim/movement.js` is imported unchanged by both the server and the client's
  prediction. Any rail state that lives on only one side turns reconciliation from a no-op into a
  visible rubber-band. New state goes in the player record and on the wire, or it does not exist.
- **A restart that eats a round.** A restart during play, even a single player's play, is worse
  than the lag it was meant to clear.

## Constraints

- Integer-only simulation. One tile is 256 units; positions are integers. No floats anywhere in
  `shared/sim/`.
- `shared/sim/movement.js` is the one movement function, shared by server and client prediction.
- The tick order in `shared/sim/round.js` is part of the rules. New steps go in a considered place,
  not at the end.
- Node 20, no new dependencies.
- `infra/boom-beard.service` runs with `NoNewPrivileges=true`, so the server cannot escalate or
  call `systemctl`. Anything restart-shaped must work by exiting and letting `Restart=always` do it.

---

## 1. Rail-lane movement

**Decided:** rails with queued turns. Replaces free 2D movement and diagonals.

A pirate is always exactly on the centre line of either a row or a column — there is no
off-lane position to be in. Travel is along that lane. A direction press that is not along the
current lane is a **turn request**, which is buffered and spends the moment the pirate reaches a
tile centre where that turn is legal.

```
  ┌───┬───┬───┐
  │   │   │   │     pirate is always on a lane centre line
  ├───●───┼───┤     ● junction: a buffered turn fires here
  │   │   │   │
  └───┴───┴───┘
```

Behaviour that has to hold:

- **Holding a direction never stalls.** Running a row at full pace, the pirate stays dead centre
  in that row for its whole length.
- **An early turn press is kept, not dropped.** Pressing UP a few tiles before the junction turns
  you at the junction. This is what replaces corner assist, and it is why corners can no longer
  refuse a move the player can see they fit through.
- **A turn request expires.** A buffered turn that has not been spendable for a short window is
  discarded, so a stray press cannot fire a turn ten tiles later. The window is a tuned constant.
- **Reversing is immediate.** A press directly back down the lane you are on needs no junction.
- **No diagonals.** Facing is always one of four. Pressing two directions at once registers the
  cross-lane one as the turn request and keeps travelling.

Interactions that must be re-settled, not left to fall out:

| Existing mechanic | How it behaves on rails |
| --- | --- |
| Slide (`startSlide`/`stepSlide`) | Still a velocity with drag, but strictly along the current lane. It cannot turn. |
| Puddle slide | Carries you further along the lane; cannot push you off it. |
| Drunk sway | A sway that moves you off a lane is impossible. Becomes a *rendered* wobble plus the occasional missed or reversed turn — the cost stays, the mechanism changes. |
| Corner assist (`ASSIST_*`) | Deleted. Queued turns are strictly better and the constants become dead. |
| Lane centring (`ALIGN_*`) | Deleted. Lanes are exact, not approached. |
| `unstick` | Kept. A wall regrowing on you still has to ease you out, now along the lane. |

Hitboxes, blocking, bomb solidity and fire overlap are unchanged — they already work from
position and do not care how the position was reached.

**Left to the builder:** whether the rail position is stored as the existing `x`/`y` pair with an
invariant that one of them is always tile-centred, or as an explicit lane + offset. Either is fine
provided the wire format and `movement.js`'s signature stay shared, and the choice is written down
where the next person will find it.

## 2. Kicking a bomb off the board

**Decided:** a slide that reaches a bomb removes it from the game. It never explodes and never
damages anyone. The owner's bomb slot is **not** refunded immediately — it frees at the tick the
original fuse would have ended.

That asymmetry is the whole point: kicking denies the blast, but the bomber is not instantly
rearmed, so a kick is a save rather than a free reset.

- The bomb leaves on a short arc toward the nearest map edge, over roughly half a second, and is
  gone. Cute and readable, not a physics simulation.
- While it is in the air it is not solid, not detonatable, and not chainable. It is scenery.
- No score, no kill credit, no stat. A kick is its own reward.
- A kick cannot be chained into other bombs — the arc leaves the board, it does not travel the lane.
- The bomb's own tile stops being solid the moment it is kicked, so the kicker's slide continues
  through rather than stopping dead on the square it just cleared.

On rails this reads naturally: you are sliding along a lane, there is a bomb on that lane, you
reach it, it goes.

**Left to the builder:** the arc's exact shape and the sound. One new wire event carrying the bomb
id and the direction is expected; a kicked bomb must disappear identically on every client, so the
event is authoritative and the client does not predict it.

## 3. Round length

Ten minutes to **six**. `ROUND_TICKS` only. Everything scheduled as a fraction of the round —
the gull raid window, the late-join cutoff — follows automatically and must be checked rather than
assumed.

## 4. Block regeneration scales with round progress

Walls already regrow faster as the map empties (`REGEN_PER_CYCLE` scaled by wall fill). Add a
second, independent multiplier on **how far into the round it is**, so the back half of a round
closes up faster than the front half even when the fill is the same.

The two scalings multiply. Emptiness answers "is there cover left"; progress answers "should this
round be tightening". A six-minute round needs the second one, because the first only reacts after
the map is already bare.

`REGEN_MAX_FILL` stays as the hard stop, and the spawn-ring and quiet-tile exclusions are
untouched — no amount of progress may entomb a player or block a spawn.

## 5. Bombs carried: 5 → 8

`MAX_BOMBS_CARRIED` to 8, spammable, which it already is — placement is one bomb per key *press*
with no cooldown, so nothing else is needed for spam.

Notes the builder needs:

- `MAX_BOMBS = 16` is declared and **never read**. It is not a live cap and must not be mistaken
  for one.
- `POWDER_RADIUS` is deliberately above `MAX_RADIUS`, which is how the renderer and the sound
  identify a powder keg without a wire flag. This change does not touch radius, so that gap is
  safe — but it is why the two caps are not symmetrical.
- `shared/shop.js` sizes its bomb bundle from `MAX_BOMBS_CARRIED - START_BOMBS`, so the shop
  follows automatically. The HUD reads the same constant.
- The comment above the constant explains at length why eight was *reduced* to five. That reasoning
  is now overridden by the request. The comment must be rewritten to say what is true, not left
  arguing against the code beneath it.

## 6. Bug: a bomb perk that does not get picked up

Reported as: a Bomb pickup sometimes does nothing even though the HUD shows room.

This has **not** been root-caused and will not be fixed by guessing. What is already established:

- Pickups are server-authoritative. The client predicts movement only — `collect()` never runs in
  prediction — so there is a round trip between standing on a perk and gaining it.
- Perk lists arrive wholesale in each snapshot, so a client-side ghost perk is not possible.
- The pickup hitbox is generous: 160 units against a 256-unit tile, so near-boundary misses are not
  it.
- Commit `b2aead9` ("Prevent capped and active perk pickups") is recent and is exactly the code
  that makes a refused pickup leave the perk on the floor. It is the leading suspect and may have
  turned a previously silent cap into a visible one.

The work is: reproduce it in a test first, then fix the cause the test exposes. Raising the cap to
8 will make the symptom much rarer, which is a reason to write the test *before* item 5 lands
rather than a reason to skip it.

## 7. Bug: the gull's 9 gold sometimes does not arrive

Two distinct paths can swallow a gull payout, and both are fixed.

**The raid (9 coins).** `strikeRaid` marks the targeted player as gulled, then returns early
without paying if that player is already dead when the birds arrive. The player was publicly
targeted, the room watched it happen, and they get nothing. They should be paid regardless — the
9 coins are for having been chosen, not for being alive at impact.

**A gull shot down (3 coins).** The payout resolves the fire's owner, and when there is no living
owner — a powder keg, or a player who left — it falls back to dropping a coin on the floor via
`landing()`. `landing()` searches rings 0–3 and returns null if every tile there is wall, sea or
already occupied. On a null, nothing is dropped and nothing is paid: the gull dies for free. The
coin must never silently vanish.

## 8. Respawn delay: 11s → 5s

`RESPAWN_DELAY_TICKS` from 11 seconds to 5. `RESPAWN_COUNTDOWN_TICKS` is 3 seconds and must stay
strictly under the delay, so it still fits — but the countdown UI will now cover most of the wait
rather than a quarter of it, and wants a look.

## 9. A bomb where you died, one death in ten

On death, a one-in-ten chance of a live bomb on the tile where it happened.

- **Owned by the player who died.** Kills it gets are credited to them, posthumously.
- Normal fuse. Its radius is the dead player's radius at the moment of death — their bomb, their
  loadout. *(Builder's call, flagged: only ownership was specified.)*
- It does not consume a bomb slot; the dead player has none.
- Rolled from the simulation's seeded RNG (`state.next`), never `Math.random`, or server and
  client disagree.

It goes down where `scatterOnDeath` already runs, so the corpse's perks and its parting gift are
decided in one place and one order.

## 10. Escape confirms before leaving

Escape currently closes the scoreboard, and a *held* Escape leaves the game. A tapped Escape with
nothing open should raise a confirmation dialog — leave, or stay — rather than acting.

The existing tap/hold machinery (`createTap`, `tapEscape`) stays; only the terminal action
changes. While the dialog is open, Escape must not re-trigger it, and the dialog must not swallow
gameplay input from a player who chooses to stay. The game keeps running behind it: this is a
browser game and a modal that pauses nothing is honest about that.

## 11. Nightly restart, and the lag it is meant to clear

### The restart

**Decided:** in-process, server's own local clock.

Each minute the server checks: is the local hour 23, 00 or 01, are there zero human players
connected, and has it been up long enough to be worth restarting. If so it shuts down cleanly —
banking the round exactly as the existing `SIGTERM` path does — and `Restart=always` brings it back
in about two seconds.

- Local time, so the Johannesburg and US boxes each restart in their own night.
- A config knob under `[server]`, blank by default, so a laptop never does this.
- Zero *humans*. Bots must not hold the server open all night.
- An uptime floor, so a crash loop cannot become a restart loop.
- It reuses the existing clean-shutdown path. It does not add a second way to stop the server.

### Why it lagged, which is the part worth being honest about

The restart is a janitor. It is not the fix, because **nothing found so far says the server is
what was slow.** The lag described is client-side, and two things in the renderer explain it:

1. **There is no quality scaling at all.** Nothing in `public/client/render.js` or `main.js`
   adapts to the machine — no device tier, no detail reduction, no frame-budget feedback. A 2019
   laptop and a current desktop are asked for exactly the same work. The client already *measures*
   itself (`sampleLocalPerformance` reports FPS, main-thread busy percentage and heap), so the
   signal to adapt on exists and is simply unused.

2. **The canvas pixel count is unbounded.** `devicePixelRatio` is capped at 2, but the backing
   store is still CSS size × DPR with no ceiling on the product. On a large or high-DPI display
   that is several million pixels, and every one of them is paid for more than once per frame:
   there is a **full-canvas light layer** (`lightLayer`) that is cleared, drawn into, and composited
   over the whole board every frame, on top of 24 `globalCompositeOperation` passes and the water.
   Fill rate, not JavaScript, is the likely ceiling — which is exactly the shape of "lags a little
   on a big screen and is fine on a small one".

The fix in this pass is deliberately the smallest one that addresses the cause: **cap the canvas
backing-store pixel budget** and let CSS scale the result up. One number, no restructuring, and it
cuts the per-frame fill cost on exactly the machines that were struggling. Smoothing is already
enabled at non-integer scales, so an upscaled board will not look wrong.

What this pass deliberately does **not** do: add a device-tier system, cut effects, move work to a
worker, or restructure the light layer. Those need before-and-after measurement on the machine that
actually lagged, and guessing at them would risk the look of the game for an unproven gain.

**Left to the builder:** the budget's value, measured rather than picked, and whether it is exposed
as a setting. If a measurement shows the cap is not enough, say so and stop rather than
escalating into the deferred work above.

## Builder's calls

Values and details that were not specified. These are settled here so the builder is not blocked,
and are called out so they can be overridden on sight:

| Thing | Call | Why |
| --- | --- | --- |
| Turn-buffer window | ~8 ticks (about a quarter second) | Long enough to press early into a junction, short enough that a stray press cannot fire a turn a lane later. Tune on feel. |
| Progress regen multiplier | 1.0 at the start rising to 2.0 at the end, linear | Doubling by the final minute is felt without being chaotic, and it multiplies cleanly with the existing emptiness scaling. |
| Respawn delay | 5 seconds | The request said 5 or 6; 5 is the shorter and the request's direction was "shorter". |
| Death bomb radius | the dead player's radius at death | Only ownership was specified, and their own loadout is the reading that matches "their bomb". |
| Kick arc | ~0.5 s to the nearest map edge | Long enough to read as an event, short enough not to delay the slide it belongs to. |
| Restart config | `nightly_restart = 23-2` under `[server]`, blank = off | An hour range reads as what it is, and blank-by-default keeps laptops out of it. |
| Escape dialog | does not pause the game | A browser arena cannot pause for one player; a modal that pretends otherwise gets people killed. |

## Risk

Items 1 and 2 are the whole risk. Both touch `shared/sim/`, which means both can desync, and a
desync does not announce itself — it shows up as rubber-banding a minute into a round. They want
simulation-level tests (same inputs, same outputs, server and prediction agreeing over hundreds
of ticks), not just unit tests of the new helpers. `test/movement.js`, `test/slide.test.js`,
`test/interp.test.js` and `test/bombs.test.js` are the existing shape to follow.

Items 3–11 are small and independent, and can land in any order. Items 1 and 2 should land last,
behind the rest, so a problem with the rails is never tangled up with a problem in the tuning.

## Verification

Each item lands with a test and a commit. Beyond the per-item tests:

- Movement and slide tests re-derived for rails, including the queued-turn window and the
  "holding a direction never stalls" invariant.
- A desync test: identical input streams through the server tick and through client prediction,
  asserting identical positions over a long run.
- A kicked bomb is proven never to produce fire, damage, or a chain.
- `docs/RULES.md`, `docs/DESIGN.md` and `docs/NETCODE.md` updated where this changes what they
  describe. Stale rules documentation on a game whose rules are its product is a defect, not a
  loose end.
- `npm test` green before each commit.
