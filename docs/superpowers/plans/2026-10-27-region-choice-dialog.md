# Region Choice Dialog and Game-Only US Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the ZA host as the only website while prompting every player to choose a game region and connecting US selections directly to the US Elastic IP.

**Architecture:** The ZA page owns the accessible region dialog and probes both region-status endpoints. The US instance uses a short-lived, browser-trusted IP certificate for direct WebSocket/WebTransport connections, serves status and game traffic only, and redirects page/admin requests to ZA. The dialog remembers the last confirmed choice but is shown on every Play or Spectate action.

**Tech Stack:** Node.js ES modules, native `<dialog>`, browser Fetch/CORS, WebSocket/WebTransport, Certbot/Let's Encrypt, Node test runner, Bash/systemd.

---

## File map

- `shared/regions.js`: region display names, flag asset paths, origins, and transport URL derivation.
- `shared/region-selection.js`: closest reachable/default-choice behavior.
- `public/client/region-picker.js`: status probes, accessible choice dialog, persistence, offline state, and ping categories.
- `public/client/main.js`: ask for a region before creating a game connection.
- `public/index.html`: dialog markup and removal of the analytics disclosure.
- `public/style.css`: compact dialog, flag, selected, responsive, and ping-state styling.
- `public/assets/img/flags/za.svg`, `public/assets/img/flags/us.svg`: self-hosted flags that render consistently.
- `server/canonical.js`, `server/index.js`: US game-only HTTP routes and ZA redirects.
- `server/region-status.js`: safe counts and exact ZA-origin CORS for the US status probe.
- `infra/bootstrap.sh`: IP-address certificate issuance, deployment hook, and daily renewal.
- `docs/DEPLOY.md`: single-site/direct-IP production instructions and network prerequisites.
- `test/region-transport.test.js`, `test/region-picker.test.js`, `test/region-picker-ui.test.js`, `test/admin-ui.test.js`, `test/canonical.test.js`, `test/region-status.test.js`, `test/bootstrap-config.test.js`: focused regression coverage.

### Task 1: Use the US Elastic IP as the game origin

**Files:**
- Modify: `shared/regions.js`
- Test: `test/region-transport.test.js`

- [ ] **Step 1: Add failing direct-IP URL tests**

Replace the `us.example` fixture in `test/region-transport.test.js` with the production EIP, and assert:

```js
assert.equal(regionOrigin('us', 'https://boombeard.co.za'), 'https://52.21.210.27');
assert.deepEqual(transportUrls('https://52.21.210.27'), {
  ws: 'wss://52.21.210.27/ws',
  wt: 'https://52.21.210.27/wt',
});
```

Run: `node --test test/region-transport.test.js`
Expected: FAIL because the US origin is still `https://us.boombeard.co.za`.

- [ ] **Step 2: Update the region definitions**

Set the US region to `name: 'United States'`, `flag: '/assets/img/flags/us.svg'`, and `origin: 'https://52.21.210.27'`. Set the ZA flag to `/assets/img/flags/za.svg`. Keep ZA's origin and the localhost ZA override unchanged.

- [ ] **Step 3: Run transport tests**

Run: `node --test test/region-transport.test.js`
Expected: PASS, including local HTTP fallback and unknown-region rejection.

### Task 2: Restrict the US instance to game/status traffic

**Files:**
- Modify: `server/canonical.js`
- Modify: `server/index.js`
- Modify: `server/region-status.js`
- Test: `test/canonical.test.js`
- Test: `test/region-status.test.js`

- [ ] **Step 1: Add failing game-only redirect tests**

In `test/canonical.test.js`, test an exported `gameOnlyRedirect({ regionId, url })` helper with these cases:

```js
assert.equal(gameOnlyRedirect({ regionId: 'us', url: '/' }), 'https://boombeard.co.za/');
assert.equal(gameOnlyRedirect({ regionId: 'us', url: '/admin' }), 'https://boombeard.co.za/admin');
assert.equal(gameOnlyRedirect({ regionId: 'us', url: '/client/main.js' }), 'https://boombeard.co.za/');
assert.equal(gameOnlyRedirect({ regionId: 'us', url: '/region-status' }), null);
assert.equal(gameOnlyRedirect({ regionId: 'us', url: '/healthz' }), null);
assert.equal(gameOnlyRedirect({ regionId: 'za', url: '/' }), null);
```

The helper must not copy an incoming query string to the ZA URL.

Run: `node --test test/canonical.test.js`
Expected: FAIL because the helper is not defined.

- [ ] **Step 2: Implement game-only redirects before static/admin routing**

Add the tested helper to `server/canonical.js`. In `server/index.js`, after parsing the request path and before canonical/admin/static handling, redirect non-allowlisted US HTTP paths with `302` and `Cache-Control: no-store`. Allow `/healthz`, `/region-status`, and `/deploy`; WebSocket upgrades remain handled by the existing hub upgrade handler, and WebTransport remains on its existing UDP endpoint. Route every US `/admin...` request to the ZA `/admin` path without forwarding query data. Route other US page/static requests to the ZA root.

- [ ] **Step 3: Restrict status CORS and verify payload**

In `server/region-status.js`, allow `Access-Control-Allow-Origin` only when `Origin` is exactly `https://boombeard.co.za`. Preserve `Vary: Origin`, `Cache-Control: no-store`, the GET-only method, and the existing safe `{ region, humanPlayers, bots, maxPlayers }` response. Add a test that accepts the ZA origin and rejects the US EIP origin and an unrelated origin.

- [ ] **Step 4: Run server routing tests**

Run: `node --test test/canonical.test.js test/region-status.test.js`
Expected: PASS, with ZA routes unchanged and US page/admin requests redirected.

### Task 3: Issue and renew the direct-IP TLS certificate

**Files:**
- Modify: `infra/bootstrap.sh`
- Modify: `test/bootstrap-config.test.js`
- Modify: `docs/DEPLOY.md`

- [ ] **Step 1: Add failing bootstrap assertions**

Extend `test/bootstrap-config.test.js` to assert that the IP-host path requests Certbot's `shortlived` profile with `--ip-address "$HOST"` and that the renewal timer runs daily:

```js
assert.match(script, /--preferred-profile shortlived/);
assert.match(script, /--ip-address "\$HOST"/);
assert.match(script, /OnCalendar=daily/);
assert.match(script, /REGION_ID=us requires HOST to be an IP address/);
```

Also assert IP/alternate-host validation occurs before stopping the service and a failed Certbot request restores the previous service. Keep coverage for the existing named-host path, regional identity, password, and generated admin key.

Run: `node --test test/bootstrap-config.test.js`
Expected: FAIL because bootstrap only requests domain certificates and the timer is weekly.

- [ ] **Step 2: Add IP/domain identifier handling**

In `infra/bootstrap.sh`, detect whether `HOST` is an IP address with Python's standard-library `ipaddress`. Require an IP whenever `REGION_ID=us`, including `SKIP_TLS=1`. For an IP, pass `--ip-address "$HOST" --preferred-profile shortlived`; for a ZA DNS hostname, preserve the current `-d "$HOST"` and `ALT_HOSTS` behavior. Keep the existing standalone HTTP-01 challenge and certificate deploy hook.

- [ ] **Step 3: Schedule reliable six-day certificate renewal**

Change the Certbot systemd timer from weekly to daily. Preserve the existing pre-hook that stops the HTTP listener and post-hook that restarts it. If issuance or certificate installation fails, report the error and restore the previous service before exiting. Continue copying the renewed certificate and private key into the data directory and restarting Boom Beard after renewal.

- [ ] **Step 4: Update deployment documentation**

Document `HOST=52.21.210.27 REGION_ID=us`, the six-day `shortlived` IP certificate, daily renewal, and required inbound TCP 80/443. Keep the existing `EMAIL` environment requirement for certificate expiry notices; never hard-code an address in the repository. Remove `us.boombeard.co.za` as a deployment prerequisite or game origin. State that ZA remains the only landing/admin website.

- [ ] **Step 5: Run bootstrap tests**

Run: `node --test test/bootstrap-config.test.js`
Expected: PASS for IP and existing hostname setup.

### Task 4: Build the compact region-choice dialog

**Files:**
- Create: `public/assets/img/flags/za.svg`
- Create: `public/assets/img/flags/us.svg`
- Modify: `public/client/region-picker.js`
- Modify: `shared/region-selection.js`
- Test: `test/region-picker.test.js`
- Test: `test/region-picker-ui.test.js`

- [ ] **Step 1: Test ping thresholds**

Export `pingClass(rttMs)` from `region-picker.js` and add tests:

```js
assert.equal(pingClass(0), 'pingGood');
assert.equal(pingClass(50), 'pingGood');
assert.equal(pingClass(51), 'pingFair');
assert.equal(pingClass(99), 'pingFair');
assert.equal(pingClass(100), 'pingPoor');
```

Expected: unknown/null RTT has no color class and remains labeled offline/checking.

- [ ] **Step 2: Test dialog and saved-choice behavior**

Extend the DOM stubs in `test/region-picker-ui.test.js` with a dialog that records `showModal()` and `close()`. Test that every `chooseRegion()` call opens the dialog, a saved region is preselected, the dialog remains open until explicit confirmation, cancellation returns `null`, and only confirmation persists the region.

- [ ] **Step 3: Test card content and offline handling**

Assert that each button uses an image with descriptive alt text, shows country name, RTT class, and the compact `humanPlayers/maxPlayers players` count; its accessible label describes the count as players online. An offline region shows `OFFLINE` and cannot be confirmed. Ensure the picker has no “server ready” footer.

- [ ] **Step 4: Implement dialog choice API**

Change `createRegionPicker` to expose `chooseRegion()` instead of starting background polling on page load. On each call:

1. Open the dialog immediately.
2. Select the saved region, or choose the fastest reachable region after initial probes if no choice is saved.
3. Probe both regions in parallel and update their cards.
4. On confirmation, perform a fresh status probe for the selected region, persist only a reachable confirmed choice, close the dialog, and resolve with its ID.
5. On cancellation, close and resolve `null` without connecting.

Keep bounded probe timeouts, `cache: 'no-store'`, credential-free CORS, and explicit unexpected-error handling.

- [ ] **Step 5: Add local flag assets and semantic labels**

Create small SVGs for South Africa and the United States. Use the flag path in the region record and render it with an accessible image label; do not rely on flag emoji glyph support or display `ZA`/`US` abbreviations.

- [ ] **Step 6: Run region-picker tests**

Run: `node --test test/region-picker.test.js test/region-picker-ui.test.js`
Expected: PASS for ping boundaries, flags, counts, saved selection, confirmation, cancellation, offline state, and stale probes.

### Task 5: Integrate Play/Spectate and finish landing-page styling

**Files:**
- Modify: `public/index.html`
- Modify: `public/client/main.js`
- Modify: `public/style.css`
- Modify: `test/region-picker-ui.test.js`
- Modify: `test/admin-ui.test.js`

- [ ] **Step 1: Add failing markup/copy regression assertions**

Assert that `public/index.html` contains a labeled native `<dialog>` with `regionPicker`, confirm, and cancel controls; there is no always-visible picker; the analytics disclosure string is absent; and the heading is “Choose your region”.

- [ ] **Step 2: Move the picker inside the dialog**

Place the region cards and actions in a native `<dialog>` with `aria-labelledby`. Remove the inline picker from the landing form and remove the entire `geoPrivacyDisclosure` paragraph. In `test/admin-ui.test.js`, replace the old presence assertion with `assert.doesNotMatch(home, /Country-level visit and sign-up counts only/)`.

- [ ] **Step 3: Wire every connection attempt to the dialog**

Remove `regionPicker.start()` from page initialization. In `play()`, call `await regionPicker.chooseRegion()` after local input/password validation and before `net.connect`. If canceled, return without creating a renderer or socket and restore the Play button. Keep Spectate using the same region prompt because it also starts a game-server connection.

- [ ] **Step 4: Style a compact, responsive toggle**

Style two equal-width country choices as a segmented/toggle-like pair, with selected gold outline, legible flags, online count, and colored RTT. Use green for `<=50`, orange for `51..99`, red for `>=100`; keep offline state neutral. Ensure keyboard focus, native dialog backdrop, Escape/cancel behavior, and a compact two-column layout down to 320px.

- [ ] **Step 5: Run UI and transport tests**

Run: `node --test test/region-picker-ui.test.js test/region-picker.test.js test/region-transport.test.js test/admin-ui.test.js`
Expected: PASS, including “no analytics disclosure” and “no always-visible region picker”.

### Task 6: Full verification and deployment

**Files:**
- Modify: `docs/DEPLOY.md` (final deployment commands and validation)

- [ ] **Step 1: Run focused and complete tests**

Run: `node --test test/region-picker.test.js test/region-picker-ui.test.js test/region-transport.test.js test/region-status.test.js test/canonical.test.js test/bootstrap-config.test.js test/admin-ui.test.js`
Expected: all selected tests pass.

Run: `npm test`
Expected: all tests pass, no regressions.

- [ ] **Step 2: Review the patch**

Run: `git diff --check`
Expected: no whitespace errors.

Search: `rg -n 'us\.boombeard\.co\.za|Choose your waters|South Africa server ready|Country-level visit and sign-up counts only' public shared server infra docs/DEPLOY.md`
Expected: no obsolete runtime hostname, heading, footer, or disclosure copy remains. Historical design/plan documents and regression tests may retain old strings as test fixtures.

- [ ] **Step 3: Deploy ZA and stage US**

Deploy the verified commit to ZA with `npm run deploy`. Deploy the same tree to the US instance with `SSH_HOST=52.21.210.27 SSH_USER=ec2-user KEY=/Users/CobusV/Downloads/bombs-away-na.pem npm run deploy`; keep the US service at its per-region data directory. Verify `/healthz` locally over SSH reports the same `v1.0.8` commit marker and `/region-status` reports `region: "us"`.

- [ ] **Step 4: Enable public US TLS and verify**

After inbound TCP 80/443 is enabled on the US security group, rerun bootstrap with `HOST=52.21.210.27 REGION_ID=us` and TLS enabled. Verify the IP certificate is publicly trusted, the daily renewal timer is enabled, `https://52.21.210.27/region-status` returns US-local counts with ZA CORS, and `wss://52.21.210.27/ws` connects. Verify `https://52.21.210.27/` and `/admin` redirect to the ZA site.

If ingress remains unavailable, leave the US option visibly offline and report the exact AWS security-group prerequisite; do not claim public US connectivity works.
