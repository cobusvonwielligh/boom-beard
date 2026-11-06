# Rails, Kicking, Nightly Restart and Round Tuning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship eleven post-playtest items — rail-lane movement, slide-kicks-bomb, a nightly restart, a client fill-rate cap, two bug fixes, and five tuning changes.

**Architecture:** Twelve independent tasks against an existing no-build Node 20 + vanilla-JS game. Tuning, bugs and ops land first; the two `shared/sim/` changes (rails, kicking) land last so a desync can never be confused with a tuning regression. `shared/sim/movement.js` is imported unchanged by both the server tick and the client's prediction — that sharing is what makes reconciliation a no-op, and nothing may break it.

**Tech Stack:** Node 20 (`node --test`), ES modules, vanilla JS, canvas 2D. No dependencies, no build step.

**Spec:** [docs/superpowers/specs/2026-11-06-rails-kick-and-tuning-design.md](../specs/2026-11-06-rails-kick-and-tuning-design.md)

## Global Constraints

- Integer-only simulation. One tile is `UNITS_PER_TILE = 256`; positions are integers. No floats anywhere under `shared/sim/`.
- Randomness inside the simulation uses the seeded `state.next` / `randInt(state.next, n)`. `Math.random` in `shared/sim/` is a desync.
- `shared/sim/movement.js` keeps its exported signature `step(state, p, mask)` and stays importable by `public/client/world.js` unchanged.
- The tick order in `shared/sim/round.js` is part of the rules. A new step goes in a justified position with a comment saying why.
- No new npm dependencies. Node 20. No bundler, minifier or transpiler.
- Every task ends with `npm test` green and a commit.
- Commit format `<type>(<scope>): <subject>`, max 100 chars.
- 2-space indent, LF, UTF-8, no trailing whitespace, newline at EOF.

## Review Focus

Input classes the spec implies but no task's own tests would otherwise exercise. Each has its test assigned to the task that owns the code:

1. **A buffered turn into a wall that never opens** — the turn request must expire rather than fire ten tiles later when a wall finally breaks. (Task 11)
2. **A slide that reaches a bomb on the same tick it is placed** — the kick and `place()` run in the same tick in a fixed order; the bomb must either exist and be kickable or not exist, never be half-placed. (Task 12)
3. **A nightly restart firing at 23:00 with one disconnected-but-reserved seat** — `stats().reserved > 0` means a human may return; the restart must still be driven only by *connected* humans, and must not fire twice in the same minute. (Task 9)
4. **`landing()` returning null with no living player anywhere** — the gull coin fallback must not crash or loop when the board is full and every player is dead. (Task 6)
5. **A death bomb on a tile that already holds a bomb or a puddle** — 1-in-10 must become 0-in-10 for that death rather than stacking two bombs on one tile. (Task 7)

---

### Task 1: Round length 10 → 6 minutes

**Files:**
- Modify: `shared/constants.js:15`
- Test: `test/round-length.test.js` (create)

**Interfaces:**
- Produces: `ROUND_TICKS === 6 * 60 * TICK_HZ` (10800).

- [ ] **Step 1: Write the failing test**

```js
// test/round-length.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUND_TICKS, TICK_HZ, GULL_RAID_AT_MIN, GULL_RAID_AT_MAX,
  GULL_RAID_LATE_JOIN_FRACTION, GULL_FIRST_TICK,
} from '../shared/constants.js';

test('round length', async t => {
  await t.test('a round is six minutes', () => {
    assert.equal(ROUND_TICKS, 6 * 60 * TICK_HZ);
  });

  // Everything scheduled as a fraction of the round has to still fit inside a shorter one.
  await t.test('the first gull arrives well before the round ends', () => {
    assert.ok(GULL_FIRST_TICK < ROUND_TICKS / 4);
  });

  await t.test('the raid window lands inside the round and after the late-join cutoff', () => {
    const earliest = ROUND_TICKS * GULL_RAID_AT_MIN;
    const latest = ROUND_TICKS * GULL_RAID_AT_MAX;
    const cutoff = ROUND_TICKS * GULL_RAID_LATE_JOIN_FRACTION;
    assert.ok(cutoff < earliest, 'late joiners must be settled before the raid picks a target');
    assert.ok(latest < ROUND_TICKS, 'the raid must land before the round ends');
  });
});
```

- [ ] **Step 2: Run it and watch the first case fail**

Run: `node --test test/round-length.test.js`
Expected: FAIL — `ROUND_TICKS` is 18000, expected 10800.

- [ ] **Step 3: Change `ROUND_TICKS` to `6 * 60 * TICK_HZ` in `shared/constants.js`**

Update the trailing comment to the new tick count.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. Any test that hard-codes a ten-minute round is a real break — fix the test to read `ROUND_TICKS` rather than re-asserting the old number.

- [ ] **Step 5: Commit**

```bash
git add shared/constants.js test/round-length.test.js
git commit -m "feat(round): shorten a round to six minutes"
```

---

### Task 2: Respawn delay 11s → 5s

**Files:**
- Modify: `shared/constants.js:693`
- Test: `test/respawn-countdown.test.js`

**Interfaces:**
- Produces: `RESPAWN_DELAY_TICKS === 5 * TICK_HZ`.

- [ ] **Step 1: Add the failing cases to `test/respawn-countdown.test.js`**

```js
test('respawn delay is five seconds', () => {
  assert.equal(RESPAWN_DELAY_TICKS, 5 * TICK_HZ);
});

// The countdown is drawn over the tail of the wait, so it must be strictly shorter than it.
test('the countdown still fits inside the wait', () => {
  assert.ok(RESPAWN_COUNTDOWN_TICKS < RESPAWN_DELAY_TICKS);
});
```

Add `RESPAWN_DELAY_TICKS`, `RESPAWN_COUNTDOWN_TICKS` and `TICK_HZ` to the file's existing import from `../shared/constants.js` if absent.

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/respawn-countdown.test.js`
Expected: FAIL — 330 ticks, expected 150.

- [ ] **Step 3: Change `RESPAWN_DELAY_TICKS` to `5 * TICK_HZ`**

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/constants.js test/respawn-countdown.test.js
git commit -m "feat(respawn): shorten the respawn wait to five seconds"
```

---

### Task 3: Root-cause the bomb perk that does not get picked up

This task is a diagnosis, and it lands **before** Task 4 because raising the cap would hide the symptom. Use **superpowers:systematic-debugging**: reproduce first, then fix the cause the reproduction exposes.

**Files:**
- Test: `test/perkdrop.test.js` (extend)
- Modify: whichever file the reproduction indicts — `shared/sim/perks.js` is the leading suspect

**Interfaces:**
- Consumes: nothing.
- Produces: no interface change. `collect(state)` keeps its signature.

- [ ] **Step 1: Write a test that walks a player with room to spare onto a Bomb perk**

Name it `a bomb perk below the cap is always taken`. Build a player with `p.bombs = START_BOMBS`, `drop()` a `PERK.BOMB` on a floor tile, walk the player onto it with `step()` and `collect()` for enough ticks to cross the tile, and assert `p.bombs === START_BOMBS + 1` and that the perk is gone from `state.perks`.

- [ ] **Step 2: Run it**

Run: `node --test test/perkdrop.test.js`
Expected: unknown. If it PASSES, the bug is not in `collect()`'s cap logic and the reproduction has to widen before anything is changed. Work outward in this order, writing the case that fails before fixing anything:

1. **Hitbox vs. reduced hitbox** — `collect()` sizes its pickup box from `HITBOX_UNITS` while `blocked()` and `killInFire()` use `HITBOX_REDUCED_UNITS` under `STATUS.REDUCTION`. Try a reduced player.
2. **Two players on one perk** — the player loop runs seat-ascending and a capped seat 0 `continue`s; check seat 1 still gets it on the same tick.
3. **`drop()`'s same-tile guard** — `drop()` silently returns if any perk already sits on that tile. Check a `scatterOnDeath` or regen drop cannot shadow a tile the player is standing on.
4. **The cap itself** — a player already at `MAX_BOMBS_CARRIED` correctly leaves the perk (`b2aead9`). If the reproduction only fires at the cap, then the bug is the HUD or the player's expectation, not `collect()` — say so plainly and fix the display rather than the rule.

- [ ] **Step 3: Fix the cause the failing case exposes**

Minimal change at the indicted line. No speculative hardening of the paths that were already correct.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS, including the new case.

- [ ] **Step 5: Commit**

```bash
git add test/perkdrop.test.js shared/sim/perks.js
git commit -m "fix(perks): <the cause, named>"
```

If Step 2 proves there is no defect — every widened case passes — commit the tests alone as regression cover with `test(perks): pin bomb pickup below the cap`, and report that the symptom was the cap being invisible, which Task 4 then resolves.

---

### Task 4: Bombs carried 5 → 8

**Files:**
- Modify: `shared/constants.js:218-234`
- Test: `test/bombs.test.js`

**Interfaces:**
- Produces: `MAX_BOMBS_CARRIED === 8`.

- [ ] **Step 1: Add the failing cases to `test/bombs.test.js`**

```js
test('a player can hold eight bombs', () => {
  assert.equal(MAX_BOMBS_CARRIED, 8);
});

// Spam is one bomb per press with no cooldown. Eight presses on eight tiles is eight bombs.
test('eight bombs can be placed back to back', () => {
  // walk-and-place across a clear run, releasing IN_BOMB between presses,
  // then assert the owner has eight live bombs and the ninth press is refused.
});

// A powder keg is identified by having a radius above the carry caps rather than by a wire flag.
test('a powder keg still out-reaches the radius cap', () => {
  assert.ok(POWDER_RADIUS > MAX_RADIUS);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node --test test/bombs.test.js`
Expected: FAIL — 5, expected 8.

- [ ] **Step 3: Set `MAX_BOMBS_CARRIED = 8` and rewrite its comment**

The current comment argues at length for cutting eight to five. It now contradicts the code. Replace that reasoning with what is true: eight is deliberate, spam is the point, `MAX_RADIUS` stays at 5 so a loaded player still has to aim, and `MAX_BOMBS = 16` above it is declared and never read — note that so the next reader does not take it for a live cap.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS. `shared/shop.js` sizes its bomb bundle from `MAX_BOMBS_CARRIED - START_BOMBS` and the HUD reads the same constant, so both follow; `test/shop-protocol.test.js` and `test/shop-room.test.js` confirm it.

- [ ] **Step 5: Commit**

```bash
git add shared/constants.js test/bombs.test.js
git commit -m "feat(bombs): raise the carry cap to eight"
```

---

### Task 5: Block regeneration scales with round progress

**Files:**
- Modify: `shared/constants.js` (new constants), `shared/sim/blocks.js:93-150`
- Test: `test/levels.test.js` or `test/placeable.test.js` — whichever already covers `regenerate`; otherwise create `test/regen-progress.test.js`

**Interfaces:**
- Consumes: `state.roundTicks` (already set by the room; `gulls.js` reads it the same way).
- Produces: `REGEN_PROGRESS_AT_START = 1`, `REGEN_PROGRESS_AT_END = 2`, and `regenerate(state)` unchanged in signature.

- [ ] **Step 1: Write the failing test**

```js
test('regeneration', async t => {
  await t.test('a late cycle wants more walls than an early one at the same fill', () => {
    // Two identical states, same map and same wall fill, one at tick 0 of the round and one at
    // 90% through. Run a regen cycle on each and assert the late one placed strictly more.
  });

  await t.test('progress never beats the hard fill ceiling', () => {
    // A state above REGEN_MAX_FILL, at the very end of the round, places nothing.
  });

  await t.test('progress never places on a spawn or its neighbours', () => {
    // At the end of the round, assert every spawn tile and its eight neighbours stay walkable.
  });

  await t.test('a state with no roundTicks behaves as the start of a round', () => {
    // state.roundTicks of 0 or undefined must not produce NaN or a divide-by-zero.
  });
});
```

- [ ] **Step 2: Run it**

Run: `node --test test/<file>`
Expected: FAIL — the early and late cycles place the same number.

- [ ] **Step 3: Add the progress multiplier**

In `shared/constants.js`, add `REGEN_PROGRESS_AT_START = 1` and `REGEN_PROGRESS_AT_END = 2` with a comment saying why there are two scalings: emptiness answers "is there cover left", progress answers "should this round be tightening", and a six-minute round needs the second because the first only reacts once the map is already bare.

In `regenerate()` in `shared/sim/blocks.js`, compute progress as `state.roundTicks ? min(1, state.tick / state.roundTicks) : 0`, lerp the two constants across it, and multiply that into the existing `want` expression alongside the `bare` term. Keep `want` integer and at least 1. The `REGEN_MAX_FILL` early return and the spawn-ring and quiet-tile exclusions stay exactly where they are.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/constants.js shared/sim/blocks.js test/<file>
git commit -m "feat(blocks): regrow walls faster later in the round"
```

---

### Task 6: The gull's gold always arrives

**Files:**
- Modify: `shared/sim/gulls.js:150-196` and `:250-283`
- Test: `test/gulls.test.js`

**Interfaces:**
- Produces: no signature change. `gulls(state)` and `strikeRaid(state)` as they are.

- [ ] **Step 1: Write the two failing tests**

```js
test('gull payouts', async t => {
  await t.test('the raid pays its nine coins even if the target died first', () => {
    // Schedule a raid at a seat, kill that player before the strike tick, run to the strike.
    // Assert p.coins increased by GULL_RAID_COINS and p.gulled is true.
  });

  await t.test('a shot gull with no living owner never loses its coin', () => {
    // A keg's fire (owner null) downs a gull on a board where every tile in rings 0-3 of the
    // impact already holds a perk, so landing() returns null.
    // Assert a coin still reaches the board or a living player - state.perks grew, or some
    // player's coins grew. Never both, never neither.
  });

  await t.test('a shot gull with no living player anywhere does not throw', () => {
    // Same board, every player dead. Assert gulls(state) completes and the gull is removed.
  });
});
```

- [ ] **Step 2: Run them**

Run: `node --test test/gulls.test.js`
Expected: FAIL on the first two — the raid pays nothing, and the coin vanishes.

- [ ] **Step 3: Fix both paths**

In `strikeRaid`, pay `GULL_RAID_COINS` and the matching `SCORE.GOLD` before the `if (!p || !alive) return;`, and emit the `gullkill` event for that case too. The 9 coins are for having been chosen, not for being alive at impact — replace the comment that says otherwise.

In the shot-gull payout, make the fallback exhaustive: when `landing()` returns null, widen the search before giving up, and if there is genuinely nowhere, credit `GULL_COINS` to the nearest living human instead of dropping. With no living player at all, the coin is forfeit — that case is unreachable in play and must simply not throw. Rewrite the comment to state the new guarantee: a downed gull always pays somebody or something.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/sim/gulls.js test/gulls.test.js
git commit -m "fix(gulls): never swallow a gull's gold"
```

---

### Task 7: A bomb where you died, one death in ten

**Files:**
- Modify: `shared/constants.js` (new constant), `shared/sim/round.js:165-170`
- Test: `test/bombs.test.js` or `test/damage.test.js`

**Interfaces:**
- Consumes: `bombable(state, tx, ty)` from `shared/sim/bombs.js`, `randInt(state.next, n)` from `shared/util/rng.js`.
- Produces: `DEATH_BOMB_ONE_IN = 10`.

- [ ] **Step 1: Write the failing tests**

```js
test('death bomb', async t => {
  await t.test('one death in ten leaves a live bomb on the tile', () => {
    // Kill a player repeatedly with a seeded state; assert at least one death produced a bomb
    // at the death tile and that most did not.
  });

  await t.test('it belongs to the player who died and carries their radius', () => {
    // A player with radius 4 at death: assert the bomb's owner is their seat and r is 4.
  });

  await t.test('a kill it gets is credited to the dead player', () => {
    // Let the bomb detonate onto another player; assert the dead player's kills went up.
  });

  await t.test('it is never placed on an occupied or wet tile', () => {
    // Die on a tile that already holds a bomb, then on a puddle. Assert no second bomb,
    // and that no error is thrown.
  });

  await t.test('the roll comes from the seeded rng', () => {
    // Two states with the same seed and the same deaths produce identical bomb lists.
  });
});
```

- [ ] **Step 2: Run them**

Run: `node --test test/<file>`
Expected: FAIL — no bomb is ever left.

- [ ] **Step 3: Drop the bomb at the death site**

Add `DEATH_BOMB_ONE_IN = 10` to `shared/constants.js`.

In `round.js`, immediately beside the existing `scatterOnDeath(state, p)` call and **before** the `p.radius = START_RADIUS` reset below it — the bomb carries the dead player's radius, so it has to read it first. Roll `randInt(state.next, DEATH_BOMB_ONE_IN) === 0`, check `bombable(state, tx, ty)`, and push a bomb owned by `p.i` with the normal `FUSE_TICKS` and `p.radius`, emitting the same `bomb` event a placed bomb does so clients draw it. It consumes no bomb slot: the dead player has none, and `placeable()` counts live bombs by owner, so this is naturally handled by the player being dead — note that in a comment.

Builder's call to record in the code: this fires at the fire-death site only, not at the gull raid in `gulls.js` — a bird carries you off and leaves no corpse to booby-trap.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/constants.js shared/sim/round.js test/<file>
git commit -m "feat(death): one death in ten leaves a live bomb behind"
```

---

### Task 8: Escape confirms before leaving

**Files:**
- Modify: `public/index.html` (new `<dialog>`), `public/client/main.js:2907-2912`, `public/style.css`
- Test: `test/password-ui.test.js` style — create `test/leave-confirm-ui.test.js`

**Interfaces:**
- Consumes: the existing `leave()` and `tapEscape`/`createTap` machinery in `main.js`.
- Produces: `#leaveDialog` with `#leaveConfirm` and `#leaveCancel` buttons.

The project's UI tests assert against the served HTML and JS as text, as `test/password-ui.test.js` and `test/region-picker-ui.test.js` do. Follow that pattern rather than introducing a DOM harness.

- [ ] **Step 1: Write the failing test**

```js
test('leave confirmation', async t => {
  await t.test('the dialog exists with both choices', () => {
    // index.html contains a <dialog id="leaveDialog"> with #leaveConfirm and #leaveCancel,
    // and is labelled by its own heading.
  });

  await t.test('escape opens the dialog instead of leaving', () => {
    // main.js's onEscape no longer calls leave() directly; the running branch opens the dialog.
  });

  await t.test('only the confirm button leaves', () => {
    // leave() is wired to #leaveConfirm; #leaveCancel closes the dialog and nothing else.
  });
});
```

- [ ] **Step 2: Run it**

Run: `node --test test/leave-confirm-ui.test.js`
Expected: FAIL — no `#leaveDialog`.

- [ ] **Step 3: Add the dialog and rewire Escape**

Add a `<dialog id="leaveDialog">` to `public/index.html` following `#regionDialog`'s markup conventions: `aria-labelledby` pointing at its own heading, a real `<h2>`, and two buttons. Copy: heading "Leave the game?", a line saying the round carries on without you, and buttons "leave" and "keep playing".

In `main.js`, change `onEscape`'s last branch from `leave()` to opening the dialog, and add a branch above it that closes the dialog when it is already open — so Escape is symmetric and cannot stack dialogs. Wire `#leaveConfirm` to `leave()` and `#leaveCancel` to closing it. Do not pause or mute the game: a browser arena cannot pause for one player, and a modal that pretends otherwise gets people killed.

Style `#leaveDialog` in `public/style.css` reusing the `.regionDialog` visual language.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS. `test/client-modules.test.js` parses the client modules and will catch a syntax error.

- [ ] **Step 5: Commit**

```bash
git add public/index.html public/client/main.js public/style.css test/leave-confirm-ui.test.js
git commit -m "feat(ui): confirm before escape leaves the game"
```

---

### Task 9: Nightly restart when the server is empty

**Files:**
- Modify: `server/config.js:48-80`, `server/index.js:596-650`, `config.example.ini`, `docs/DEPLOY.md`
- Test: `test/nightly-restart.test.js` (create)

**Interfaces:**
- Consumes: `hub.health()` → `{ players, bots, reserved, ... }` from `room.stats()`; the existing `SIGTERM` handler.
- Produces: `config.nightlyRestart` as `{ from: number, to: number } | null`, and an exported pure predicate `shouldRestartNow({ hour, humans, uptimeMs, window })` from a new `server/nightly-restart.js`.

The decision is a pure function in its own file so it can be tested without a clock, a socket or a server. The wiring in `index.js` is three lines.

- [ ] **Step 1: Write the failing test**

```js
// test/nightly-restart.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWindow, shouldRestartNow } from '../server/nightly-restart.js';

test('nightly restart', async t => {
  await t.test('parses an hour window that wraps midnight', () => {
    assert.deepEqual(parseWindow('23-2'), { from: 23, to: 2 });
    assert.equal(parseWindow(''), null);
    assert.equal(parseWindow('nonsense'), null);
  });

  await t.test('fires inside the window with nobody connected', () => {
    const window = { from: 23, to: 2 };
    for (const hour of [23, 0, 1]) {
      assert.equal(shouldRestartNow({ hour, humans: 0, uptimeMs: 3_600_000, window }), true);
    }
  });

  await t.test('never fires outside the window', () => {
    const window = { from: 23, to: 2 };
    for (const hour of [2, 3, 12, 22]) {
      assert.equal(shouldRestartNow({ hour, humans: 0, uptimeMs: 3_600_000, window }), false);
    }
  });

  await t.test('never fires with a human connected', () => {
    assert.equal(shouldRestartNow({
      hour: 23, humans: 1, uptimeMs: 3_600_000, window: { from: 23, to: 2 },
    }), false);
  });

  await t.test('never fires before the uptime floor', () => {
    assert.equal(shouldRestartNow({
      hour: 23, humans: 0, uptimeMs: 60_000, window: { from: 23, to: 2 },
    }), false);
  });

  await t.test('is off without a window', () => {
    assert.equal(shouldRestartNow({ hour: 23, humans: 0, uptimeMs: 3_600_000, window: null }), false);
  });
});
```

- [ ] **Step 2: Run it**

Run: `node --test test/nightly-restart.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `server/nightly-restart.js`**

Export `parseWindow(text)` returning `{ from, to }` for a `H-H` string with both hours in 0–23, and `null` for blank or unparseable input. Export `shouldRestartNow({ hour, humans, uptimeMs, window })` returning a boolean: false without a window, false with any human, false below a one-hour uptime floor, and otherwise whether `hour` is inside the window — which must handle wrapping past midnight, since `23-2` is the default.

Name the uptime floor as a module constant with a comment: it is what stops a crash loop becoming a restart loop.

- [ ] **Step 4: Run it and watch it pass**

Run: `node --test test/nightly-restart.test.js`
Expected: PASS.

- [ ] **Step 5: Wire it up**

In `server/config.js`, add `nightlyRestart: parseWindow(pick('NIGHTLY_RESTART', 'server', 'nightly_restart', ''))`. Blank by default so a laptop never does this.

In `server/index.js`, after the `SIGTERM` handler is installed, add a one-minute `setInterval` — `.unref()`'d — that computes `humans` as connected seats minus bots from `hub.health()`, and on a true answer logs one line and sends itself `SIGTERM`. Reuse the existing handler; do not add a second shutdown path. Note in a comment that reserved seats are already-disconnected players and deliberately do not hold the server open.

Document the knob in `config.example.ini` under `[server]` and in `docs/DEPLOY.md`: local time on each box, so Johannesburg and the US each restart in their own night.

- [ ] **Step 6: Run the suite**

Run: `npm test`
Expected: PASS. `test/config.test.js` and `test/bootstrap-config.test.js` cover the loader.

- [ ] **Step 7: Commit**

```bash
git add server/nightly-restart.js server/config.js server/index.js config.example.ini docs/DEPLOY.md test/nightly-restart.test.js
git commit -m "feat(server): restart nightly while the room is empty"
```

---

### Task 10: Cap the canvas pixel budget

**Files:**
- Modify: `public/client/render.js:176-191`
- Test: `test/performance.test.js`

**Interfaces:**
- Produces: a module constant `MAX_CANVAS_PIXELS` in `render.js`, applied inside `resize()`.

`resize()` currently sets `dpr = Math.min(2, devicePixelRatio || 1)` with no ceiling on `width × height × dpr²`. Every one of those pixels is paid for more than once per frame: the full-canvas `lightLayer` is cleared, drawn into and composited over the board each frame on top of 24 composite passes. The cap trades resolution for fill rate on exactly the machines that were struggling.

- [ ] **Step 1: Add the failing test**

```js
test('the renderer caps its backing-store pixel count', () => {
  const src = text('public/client/render.js');
  assert.match(src, /MAX_CANVAS_PIXELS/);
  // The cap is applied where the DPR is chosen, not merely declared.
  assert.match(src, /function resize\(\)[\s\S]{0,800}MAX_CANVAS_PIXELS/);
});
```

- [ ] **Step 2: Run it**

Run: `node --test test/performance.test.js`
Expected: FAIL — no such constant.

- [ ] **Step 3: Apply the cap in `resize()`**

Declare `MAX_CANVAS_PIXELS` with a comment naming the ceiling and the upgrade path, in the style the file already uses — that the real cost is fill rate on a full-canvas light layer, and that the next step if this is not enough is a measured device-tier system rather than a bigger guess.

In `resize()`, after measuring `w` and `h`, reduce the effective `dpr` so `w * h * dpr * dpr` stays within the budget, floored so the canvas never ends up below 1 device pixel per CSS pixel on a small window. Everything downstream already reads `view.dpr`, and `view.smooth` is already set for non-integer scales, so an upscaled board will not look wrong.

Measure before and after on the machine that lagged and record the two numbers in the commit body. If the cap does not move the frame time, say so and stop — the deferred work in the spec needs measurement, not escalation.

- [ ] **Step 4: Run the suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Verify in the real client**

Use the **run** skill to start the server and open the game. Check the HUD's own `FPS` and `CPU %` readouts on a maximised window before and after. Confirm the board still fills its box and the lighting still reads.

- [ ] **Step 6: Commit**

```bash
git add public/client/render.js test/performance.test.js
git commit -m "perf(render): cap the canvas backing-store pixel budget"
```

---

### Task 11: Rail-lane movement

The large one. Read the spec's §1 table of mechanic interactions before starting — six existing mechanics change behaviour and two sets of constants are deleted.

**Files:**
- Modify: `shared/constants.js` (turn-buffer constant; retire `ALIGN_*`/`ASSIST_*`/`CORNER_ASSIST_UNITS`/`DIAG_*` as they fall out of use), `shared/sim/movement.js`, `shared/sim/state.js` (new player fields), `shared/wire.js` (if the turn request crosses the wire)
- Test: `test/movement.test.js`, `test/slide.test.js`, `test/rails.test.js` (create), `test/interp.test.js`

**Interfaces:**
- Consumes: `blocked(state, p, x, y, bombsCount, chamfer)`, `tileCentre`, `walkable` — all unchanged.
- Produces: `step(state, p, mask)` with its signature unchanged; new player fields for the queued turn, named and initialised in `createPlayer` so `hashState` covers them.

- [ ] **Step 1: Write the rail invariants as failing tests in `test/rails.test.js`**

```js
test('rails', async t => {
  await t.test('a pirate is always on a lane centre line', () => {
    // Walk a long random input stream through step() and assert after every tick that either
    // x or y is exactly tileCentre of its tile.
  });

  await t.test('holding a direction never stalls', () => {
    // Hold IN_RIGHT down a clear row and assert the position advances by speedOf(p) every
    // single tick, with no tick of zero movement.
  });

  await t.test('a turn pressed early fires at the junction', () => {
    // Press IN_UP three tiles before an opening, keep holding IN_RIGHT, and assert the pirate
    // turns up at the opening rather than running past it.
  });

  await t.test('a turn request expires', () => {
    // Press IN_UP against a solid wall that only opens long after the buffer window.
    // Assert the pirate does not turn when it finally opens. (Review Focus 1)
  });

  await t.test('reversing needs no junction', () => {
    // Mid-tile travelling right, press IN_LEFT, and assert the direction flips that tick.
  });

  await t.test('there are no diagonals', () => {
    // IN_RIGHT | IN_UP leaves p.dir one of the four and moves along exactly one axis.
  });

  await t.test('server and prediction agree over a long run', () => {
    // The same input stream through round.tick() and through a bare step() loop.
    // Assert identical positions and identical hashState() at the end.
  });
});
```

- [ ] **Step 2: Run them**

Run: `node --test test/rails.test.js`
Expected: FAIL — lane centring is approximate today, and diagonals exist.

- [ ] **Step 3: Replace free movement with rails in `shared/sim/movement.js`**

Hold the off-lane axis exactly at `tileCentre` rather than easing toward it, consume a cross-lane press as a buffered turn request that spends at the first tile centre where it is legal, and resolve two-axis input to travel plus a turn request. Delete `ALIGN_*` and `ASSIST_*` and the corner-assist branch in `moveAxis` — queued turns replace them and the constants become dead. Keep `unstick`: a wall regrowing on you still has to ease you out, now along the lane.

Record the storage decision the spec left open — `x`/`y` with a one-axis-centred invariant, or an explicit lane plus offset — in a comment at the top of the file, where the next reader will find it.

New player state goes in `createPlayer` so `hashState` sees it; if the client needs it to predict, it goes in `shared/wire.js` too. State on one side only is the desync the spec's anti-goals name.

- [ ] **Step 4: Re-derive the slide, puddle and drunk behaviour**

Slide stays a velocity with drag but strictly along the current lane and cannot turn. Puddle slide carries you further along the lane and cannot push you off it. Drunk sway becomes a rendered wobble plus an occasional missed or reversed turn — the cost stays, the mechanism changes. Update `test/slide.test.js` and `test/puddlebomb.test.js` to assert the rail versions.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS. `test/movement.test.js`, `test/unstick.test.js` and `test/interp.test.js` will need cases re-derived — a case that asserted off-lane drift or a diagonal is describing the old rules and should be rewritten, not deleted silently.

- [ ] **Step 6: Play it**

Use the **run** skill. Rails are a feel change and no test can sign them off. Walk corners at every speed, at base pace and with four skates, into and out of slides. A single tick where the pirate does something other than what was asked is the anti-goal in the spec — fix it before committing.

- [ ] **Step 7: Update the rules documentation**

`docs/RULES.md`, `docs/DESIGN.md` and `docs/NETCODE.md` describe free movement with corner assist. On a game whose rules are its product, stale rules documentation is a defect.

- [ ] **Step 8: Commit**

```bash
git add shared/constants.js shared/sim/movement.js shared/sim/state.js shared/wire.js test/ docs/
git commit -m "feat(movement): rail lanes with queued turns"
```

---

### Task 12: A slide kicks a bomb off the board

**Files:**
- Modify: `shared/constants.js` (kick arc constant), `shared/sim/bombs.js`, `shared/sim/movement.js` or `shared/sim/round.js` (the kick step), `public/client/render.js`, `public/client/main.js` (the event), `public/client/audio/`
- Test: `test/kick.test.js` (create), `test/bombs.test.js`

**Interfaces:**
- Consumes: `bombAt(state, tx, ty)`, the slide state from Task 11 (`p.slideV`, `p.slideDir`).
- Produces: a `kick` wire event carrying the bomb id and the direction; a bomb marked kicked is excluded from `detonate`, from `bombSolid` and from chains.

- [ ] **Step 1: Write the failing tests in `test/kick.test.js`**

```js
test('kicking a bomb', async t => {
  await t.test('a slide into a bomb removes it from the game', () => {
    // Assert the bomb is gone from state.bombs and a kick event was emitted.
  });

  await t.test('a kicked bomb never produces fire or damage', () => {
    // Run past the original fuse tick. Assert state.fires stayed empty and nobody lost health.
  });

  await t.test('a kicked bomb cannot chain', () => {
    // A second bomb adjacent to the kicked one detonates; assert the kicked one does not.
  });

  await t.test("the owner's slot frees at the original fuse, not on the kick", () => {
    // Immediately after the kick, placeable() still refuses an eighth bomb.
    // At the original fuse tick, it allows one.
  });

  await t.test('the kicked tile stops being solid at once', () => {
    // The kicker's slide continues through rather than stopping on the square it just cleared.
  });

  await t.test('a bomb placed and kicked on the same tick resolves one way or the other', () => {
    // Movement runs before place() in round.js. Assert the outcome is either a placed bomb or
    // no bomb, never a bomb in a half state. (Review Focus 2)
  });

  await t.test('no score, kill or stat is awarded for a kick', () => {
    // Assert the kicker's score and kills are unchanged.
  });
});
```

- [ ] **Step 2: Run them**

Run: `node --test test/kick.test.js`
Expected: FAIL — a slide into a bomb does nothing today.

- [ ] **Step 3: Implement the kick in the simulation**

The slide already detects overlap for `daze`, which runs as step 2b in `round.js` — put the kick beside it, before bombs are placed, and say in a comment why that position is the right one.

On a kick: remove the bomb from `state.bombs`, record its owner and its original fuse tick so the owner's slot frees then and not on the kick, and push the `kick` event with the bomb id and direction. The slot bookkeeping needs somewhere to live that `placeable()` consults — a list of pending expiries on the state, counted alongside live bombs. A kicked bomb is not solid, not detonatable and not chainable from the kick tick onward.

No score, no kill credit, no stat. The spec is explicit: a kick is its own reward.

- [ ] **Step 4: Animate it on the client**

The bomb leaves on a short arc toward the nearest map edge over roughly half a second and is gone. Cute and readable, not a physics simulation. Drive it from the authoritative `kick` event — the client must not predict a kick, so that a kicked bomb disappears identically everywhere. Add a sound in the style of the existing `sfx.play` call sites.

- [ ] **Step 5: Run the suite**

Run: `npm test`
Expected: PASS. `test/wire.test.js` covers the event shape.

- [ ] **Step 6: Play it**

Use the **run** skill. Slide into a bomb at every speed and from every direction, including into a bomb on the map edge and into one in a chain. Confirm the arc reads, the slide continues, and nothing explodes.

- [ ] **Step 7: Update the rules documentation**

`docs/RULES.md` gains the kick. The slide is now defensive and that is a rule, not a detail.

- [ ] **Step 8: Commit**

```bash
git add shared/ public/ test/ docs/
git commit -m "feat(slide): kick a bomb off the board"
```

---

## Verification

After Task 12, before the branch is finished:

- [ ] `npm test` green.
- [ ] The desync test from Task 11 passes over a long input stream.
- [ ] A real game played with bots: six-minute round, eight bombs, a kick, a death bomb, Escape, and the walls visibly tightening in the back half.
- [ ] Use **superpowers:requesting-code-review** for a whole-branch review.
