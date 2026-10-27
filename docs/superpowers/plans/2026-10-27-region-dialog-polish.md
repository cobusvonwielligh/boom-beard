# Region Dialog Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the region dialog and make its ping match the in-game RTT estimator.

**Architecture:** Keep the existing region dialog and status endpoint. Render the provided PNG flags in equal-size boxes, count humans plus bots as occupied seats, and refresh both regions on demand. Measure latency using the same game WebSocket PING/PONG protocol and five-sample rolling minimum used by the game HUD.

**Tech Stack:** Node.js ES modules, browser WebSocket, native `<dialog>`, CSS variables/animations, Node test runner.

---

## File map

- `public/assets/img/flag-south-africa-round-xs.png`, `public/assets/img/flag-united-states-icons-round-64px.png`: user-provided local flags.
- `shared/regions.js`: flag paths and immutable region metadata.
- `shared/constants.js`: five-sample ping burst count and short sample interval.
- `public/client/ping-burst.js`: reusable ping-burst scheduling and RTT measurement.
- `public/client/region-picker.js`: status, refresh, samples, minimum, and dialog state.
- `public/client/net.js`: use the same ping-burst timing when a game transport opens and reset samples when switching regions.
- `public/client/main.js`: pass refresh and dialog controls into the picker; use the chosen region as before.
- `public/index.html`: refresh control and primary/cancel action order.
- `public/style.css`: bandana-maroon tagline, flag dimensions, cast-gold Continue, compact Cancel, refresh animation, and ping transitions.
- `test/region-picker.test.js`, `test/region-picker-ui.test.js`, `test/region-transport.test.js`, `test/client-ping-burst.test.js`: behavior and regression tests.

### Task 1: Use the supplied flags and count bots as occupied seats

**Files:**
- Modify: `shared/regions.js`
- Modify: `public/client/region-picker.js`
- Test: `test/region-picker.test.js`
- Test: `test/region-picker-ui.test.js`

- [ ] **Step 1: Add failing assertions for the PNG paths and total occupancy**

Use the actual shared `REGIONS` fixture and assert:

```js
assert.equal(REGIONS.find(region => region.id === 'za').flag,
  '/assets/img/flag-south-africa-round-xs.png');
assert.equal(REGIONS.find(region => region.id === 'us').flag,
  '/assets/img/flag-united-states-icons-round-64px.png');
assert.match(southAfrica.textContent, /5\/16 players/);
```

In the UI fixture use `humanPlayers: 0`, `bots: 5`, and `maxPlayers: 16`; the accessible label must say “5 of 16 players online”.

Run: `node --test test/region-picker.test.js test/region-picker-ui.test.js`
Expected: FAIL because the picker still points at SVG assets and displays only human players.

- [ ] **Step 2: Point region metadata to the supplied assets**

Set the `za` flag path to `/assets/img/flag-south-africa-round-xs.png` and the `us` path to `/assets/img/flag-united-states-icons-round-64px.png`. Do not modify the user-provided image files.

- [ ] **Step 3: Count humans and bots in the visible and accessible occupancy**

In the successful status renderer compute:

```js
const players = result.humanPlayers + result.bots;
online.textContent = `${players}/${result.maxPlayers} players`;
```

Set the button label to `${players} of ${result.maxPlayers} players online`. Keep the server API's `humanPlayers` and `bots` fields separate; only the dialog displays their sum as occupied players.

- [ ] **Step 4: Run focused picker tests**

Run: `node --test test/region-picker.test.js test/region-picker-ui.test.js`
Expected: PASS for paths, bots counted in occupancy, offline state, and accessible text.

### Task 2: Measure game-compatible ping in five rapid samples

**Files:**
- Create: `public/client/ping-burst.js`
- Modify: `shared/constants.js`
- Modify: `public/client/region-picker.js`
- Modify: `public/client/net.js`
- Test: `test/client-ping-burst.test.js`
- Test: `test/region-picker.test.js`
- Test: `test/region-transport.test.js`

- [ ] **Step 1: Add a deterministic ping-burst test**

Export `PING_BURST_GAP_MS = 100` and `startPingBurst(sendPing, { count, gapMs, setTimeoutImpl, clearTimeoutImpl })`. Add a fake-timer test proving it invokes the first ping immediately and the remaining four 100 ms apart, and that calling the returned cancel function prevents later sends.

Run: `node --test test/client-ping-burst.test.js`
Expected: FAIL because `ping-burst.js` does not exist.

- [ ] **Step 2: Implement the shared burst scheduler**

Implement `startPingBurst()` with defaults `count = RTT_SAMPLES` and `gapMs = PING_BURST_GAP_MS`. Return a cancel callback; do not start an interval or keep timers alive after cancellation.

- [ ] **Step 3: Add WebSocket PING/PONG sample tests**

Export `measureGamePing(region, { WebSocketImpl, now, wait, onSample, timeoutMs })`. A fake WebSocket test should return samples `[18, 12, 16, 9, 14]`, assert five PING messages, observe the first sample callback before the remaining samples, and assert final minimum `9`.

Run: `node --test test/region-picker.test.js`
Expected: FAIL because the dialog still measures HTTP fetch duration.

- [ ] **Step 4: Measure the actual game PING/PONG RTT**

Open one WebSocket to `transportUrls(region.origin).ws`. On `open`, send five `{ t: 'ping', c }` messages using `startPingBurst`. Match `pong.c`, measure with `performance.now()`, emit each valid sample, and resolve to the minimum only after five replies. Close the temporary socket in every success, error, and timeout path. If fewer than five pongs arrive before timeout, mark the game region unavailable rather than showing HTTP fetch time as ping.

- [ ] **Step 5: Use the same burst on a real game connection**

In `public/client/net.js`, replace the lone open-time `ping()` with `startPingBurst(ping)`. Keep the normal `PING_EVERY_MS` interval and existing rolling `RTT_SAMPLES` minimum. Clear `rtts` when `connect()` changes region so the HUD cannot show the previous region's ping.

- [ ] **Step 6: Run ping and transport tests**

Run: `node --test test/client-ping-burst.test.js test/region-picker.test.js test/region-transport.test.js`
Expected: PASS, with the same five-sample/minimum semantics in dialog and HUD.

### Task 3: Add dialog refresh and finalize visual controls

**Files:**
- Modify: `public/index.html`
- Modify: `public/client/main.js`
- Modify: `public/client/region-picker.js`
- Modify: `public/style.css`
- Test: `test/region-picker-ui.test.js`

- [ ] **Step 1: Add failing UI assertions**

Assert the dialog contains `#regionRefresh` with an accessible label, Continue occurs before Cancel in the DOM, both controls remain keyboard accessible, and refresh causes fresh `/region-status` calls and ping bursts for both regions.

Run: `node --test test/region-picker-ui.test.js`
Expected: FAIL because there is no refresh control and the action order is Cancel then Continue.

- [ ] **Step 2: Add the refresh control and action order**

Place a small inline-SVG refresh button in a heading row at the dialog's top right. Put `#regionConfirm` before `#regionCancel`; use the gold primary button for Continue and the small ghost button for Cancel.

- [ ] **Step 3: Implement refresh-all behavior**

Expose `refreshRegions()` from `createRegionPicker`. Re-fetch status and run a five-ping burst for both regions in parallel. Disable/spin the refresh control while it is active, preserve the current selected region, ignore stale results from an earlier refresh, and report errors in an accessible live status. Continue re-probing the selected region before connecting.

- [ ] **Step 4: Match the mascot's bandana and cast-gold button**

Apply a dark maroon sampled from the bandana to `.sub-split`, reduce the current 14.5px size by exactly 1pt, and add a subtle dark text-shadow. Render each PNG inside the same 26×26px `object-fit: contain` box. Style Continue with the title's cast-gold gradient and moving specular sweep; make Cancel compact and place it to the right.

- [ ] **Step 5: Run UI tests and inspect a browser preview**

Run: `node --test test/region-picker-ui.test.js test/region-picker.test.js test/client-ping-burst.test.js`
Expected: PASS for total players, buttons, refresh, flags, and ping animations.

Open the landing page locally, open the dialog, and confirm the two flags have equal visual size, Continue is the larger left action, and Cancel is smaller on the right. Do not confirm a join against a production player account.

### Task 4: Verify and deploy the dialog/ping polish

**Files:**
- Modify: `docs/DEPLOY.md` (document PING/PONG probing and refresh behavior)

- [ ] **Step 1: Run the full suite**

Run: `npm test`
Expected: all tests pass, no failures.

- [ ] **Step 2: Check the patch and browser UI**

Run: `git diff --check`
Expected: no whitespace errors.

Verify the production landing markup does not contain the removed privacy text or “Choose your waters” text.

- [ ] **Step 3: Deploy the same commit to ZA and US**

Use the manual `npm run deploy` workflow for each host. Verify both `/healthz` endpoints report the same release and the direct US status/WebSocket endpoint remains healthy.

