# Multi-Region Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a responsive ZA/US server picker that probes latency and capacity, routes each game session to the selected server, and keeps regional data/admin isolated.

**Architecture:** Keep `boombeard.co.za` as the ZA origin and use `us.boombeard.co.za` for an independent US instance. A small CORS-restricted status API exposes only human-player count, bot count, and capacity; the browser selects the lowest-latency reachable region unless the player has made a manual selection. Player IDs and trust tokens are namespaced by region, while each host keeps its own `/admin` and persistent data.

**Tech Stack:** Node.js ESM, `node:test`, vanilla browser JavaScript, existing WebSocket/WebTransport clients, systemd/EC2, Route 53, Let's Encrypt.

---

## File map

- `shared/regions.js` — regional IDs, labels, flags, HTTPS origins, and transport URLs.
- `shared/region-selection.js` — pure nearest-reachable selection logic.
- `shared/region-keys.js` — deterministic region-scoped player/trust storage keys.
- `server/region-status.js` — minimal public status response and exact-origin CORS handling.
- `server/config.js` — server-local `regionId`.
- `server/index.js` — `/region-status` and CSP allowance.
- `public/client/region-picker.js` — bounded probes, saved manual selection, and visible status.
- `public/client/net.js` — selected-origin transport and region-scoped player/trust keys.
- `public/client/main.js` — create the picker and re-probe immediately before joining.
- `public/admin.js` — use the current host's region-scoped trusted-browser token.
- `public/index.html`, `public/style.css` — branded, responsive region selector.
- `config.example.ini`, `infra/bootstrap.sh`, `docs/DEPLOY.md` — region configuration and NA setup.
- `test/cache.test.js` and new region-focused tests — HTTP behavior, selection, probe failures,
  CORS, and per-region client state.

## Task 1: Define regions and deterministic nearest-server selection

**Files:**
- Create: `shared/regions.js`
- Create: `shared/region-selection.js`
- Create: `test/region-selection.test.js`

- [ ] **Step 1: Write the failing nearest-region tests**

Create `test/region-selection.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closestReachable, selectedRegionId } from '../shared/region-selection.js';

test('chooses the reachable region with the lowest measured RTT', () => {
  assert.equal(closestReachable([
    { id: 'za', online: true, rttMs: 182 },
    { id: 'us', online: true, rttMs: 41 },
  ]), 'us');
});

test('ignores offline and invalid RTT samples', () => {
  assert.equal(closestReachable([
    { id: 'za', online: false, rttMs: 2 },
    { id: 'us', online: true, rttMs: Number.NaN },
  ]), null);
});

test('breaks equal RTT ties by stable region id', () => {
  assert.equal(closestReachable([
    { id: 'us', online: true, rttMs: 50 },
    { id: 'za', online: true, rttMs: 50 },
  ]), 'us');
});

test('keeps a manual choice and refuses an offline manual region', () => {
  const results = [
    { id: 'za', online: true, rttMs: 182 },
    { id: 'us', online: false, rttMs: null },
  ];
  assert.equal(selectedRegionId(results, 'za'), 'za');
  assert.equal(selectedRegionId(results, 'us'), null);
});
```

- [ ] **Step 2: Run the test and confirm the helper is missing**

Run: `node --test test/region-selection.test.js`

Expected before implementation: module import fails because `shared/region-selection.js`
does not exist.

- [ ] **Step 3: Add the immutable region registry**

Create `shared/regions.js`:

```js
export const REGIONS = Object.freeze([
  Object.freeze({
    id: 'za',
    name: 'South Africa',
    flag: '🇿🇦',
    origin: 'https://boombeard.co.za',
  }),
  Object.freeze({
    id: 'us',
    name: 'North America',
    flag: '🇺🇸',
    origin: 'https://us.boombeard.co.za',
  }),
]);
```

- [ ] **Step 4: Implement stable nearest-reachable selection**

Create `shared/region-selection.js`:

```js
export function closestReachable(results) {
  return results
    .filter(result => result.online === true && Number.isFinite(result.rttMs))
    .sort((a, b) => a.rttMs - b.rttMs || a.id.localeCompare(b.id))[0]?.id ?? null;
}

export function selectedRegionId(results, manualId = null) {
  if (manualId !== null) {
    return results.some(result => result.id === manualId && result.online) ? manualId : null;
  }
  return closestReachable(results);
}
```

- [ ] **Step 5: Verify selection tests**

Run: `node --test test/region-selection.test.js`

Expected: 4 tests pass, including the offline manual choice.

- [ ] **Step 6: Commit**

```bash
git add shared/regions.js shared/region-selection.js test/region-selection.test.js
git commit -m "feat(regions): define server registry and selection"
```

## Task 2: Expose safe, region-local server status

**Files:**
- Modify: `server/config.js`
- Create: `server/region-status.js`
- Modify: `server/index.js`
- Modify: `config.example.ini`
- Create: `test/region-status.test.js`

- [ ] **Step 1: Write status-handler tests**

Create `test/region-status.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRegionStatusHandler } from '../server/region-status.js';

test('regional status is minimal and grants CORS only to registered origins', async t => {
  const handler = createRegionStatusHandler({
    regionId: 'us',
    getStats: () => ({ players: 7, bots: 4, maxPlayers: 16 }),
  });
  const server = http.createServer((req, res) => {
    if (!handler(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/region-status`;

  const allowed = await fetch(url, { headers: { Origin: 'https://boombeard.co.za' } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://boombeard.co.za');
  assert.equal(allowed.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await allowed.json(), {
    region: 'us',
    humanPlayers: 3,
    bots: 4,
    maxPlayers: 16,
  });

  const denied = await fetch(url, { headers: { Origin: 'https://attacker.example' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(Object.keys(await denied.json()).sort(),
    ['bots', 'humanPlayers', 'maxPlayers', 'region']);

  const method = await fetch(url, { method: 'POST' });
  assert.equal(method.status, 405);
});
```

- [ ] **Step 2: Run the focused test and confirm the handler is missing**

Run: `node --test test/region-status.test.js`

Expected before implementation: import failure for `server/region-status.js`.

- [ ] **Step 3: Add and validate a region ID config value**

In `server/config.js`, compute the region ID before constructing `config`:

```js
const regionId = String(pick('REGION_ID', 'server', 'region_id', 'za')).toLowerCase();
if (!['za', 'us'].includes(regionId)) {
  throw new RangeError(`invalid region id: ${regionId}`);
}
```

Add `regionId` to the exported `config` object and `region_id = za` to the
`[server]` section in `config.example.ini`.

- [ ] **Step 4: Implement the status handler**

Create `server/region-status.js`:

```js
import { REGIONS } from '../shared/regions.js';

export function createRegionStatusHandler({ regionId, getStats }) {
  const allowedOrigins = new Set(REGIONS.map(region => region.origin));

  return function handleRegionStatus(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/region-status') return false;
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }

    const origin = req.headers.origin;
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
    };
    if (typeof origin === 'string' && allowedOrigins.has(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
    }

    const stats = getStats();
    if (![stats.players, stats.bots, stats.maxPlayers].every(Number.isSafeInteger)
      || stats.players < 0 || stats.bots < 0 || stats.maxPlayers < 1) {
      throw new TypeError('invalid room stats for region status');
    }

    res.writeHead(200, headers);
    res.end(JSON.stringify({
      region: regionId,
      humanPlayers: Math.max(0, stats.players - stats.bots),
      bots: stats.bots,
      maxPlayers: stats.maxPlayers,
    }));
    return true;
  };
}
```

- [ ] **Step 5: Wire status before static-file handling**

In `server/index.js`, construct the handler with `config.regionId` and
`() => hub.health()`. Invoke it before the static-file fallback. Add
`https://us.boombeard.co.za` to `connect-src` in `CSP`; retain the existing
`'self'`, `ws:`, and `wss:` sources.

- [ ] **Step 6: Run region and existing API tests**

Run: `node --test test/region-status.test.js test/admin-http.test.js test/admin-integration.test.js test/config.test.js`

Expected: all selected tests pass; unauthenticated admin APIs remain denied.

- [ ] **Step 7: Commit**

```bash
git add server/config.js server/region-status.js server/index.js config.example.ini test/region-status.test.js
git commit -m "feat(regions): expose minimal regional status"
```

## Task 3: Add the landing-page region selector

**Files:**
- Create: `public/client/region-picker.js`
- Modify: `public/index.html`
- Modify: `public/style.css`
- Create: `test/region-picker.test.js`
- Create: `test/region-picker-ui.test.js`

- [ ] **Step 1: Test parallel region probes**

Create `test/region-picker.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeRegions } from '../public/client/region-picker.js';

const regions = [
  { id: 'za', name: 'South Africa', flag: '🇿🇦', origin: 'https://boombeard.co.za' },
  { id: 'us', name: 'North America', flag: '🇺🇸', origin: 'https://us.boombeard.co.za' },
];

test('probes both regions without cache or credentials', async () => {
  const calls = [];
  let time = 0;
  const results = await probeRegions(regions, {
    now: () => { time += 10; return time; },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const region = url.includes('us.boombeard.co.za') ? 'us' : 'za';
      return {
        ok: true,
        json: async () => ({
          region,
          humanPlayers: region === 'us' ? 6 : 2,
          bots: region === 'us' ? 3 : 5,
          maxPlayers: 16,
        }),
      };
    },
  });

  assert.equal(results.length, 2);
  assert.ok(results.every(result => result.online && Number.isFinite(result.rttMs)));
  assert.deepEqual(calls.map(call => call.options.cache), ['no-store', 'no-store']);
  assert.deepEqual(calls.map(call => call.options.credentials), ['omit', 'omit']);
  assert.ok(calls.every(call => call.options.signal instanceof AbortSignal));
});

test('marks one unreachable region offline without hiding the other', async () => {
  const results = await probeRegions(regions, {
    fetchImpl: async url => {
      if (url.includes('us.boombeard.co.za')) throw new TypeError('network failure');
      return {
        ok: true,
        json: async () => ({ region: 'za', humanPlayers: 2, bots: 5, maxPlayers: 16 }),
      };
    },
  });
  assert.equal(results.find(result => result.id === 'za').online, true);
  assert.equal(results.find(result => result.id === 'us').online, false);
});
```

- [ ] **Step 2: Verify the probe tests fail**

Run: `node --test test/region-picker.test.js`

Expected before implementation: the module import fails.

- [ ] **Step 3: Implement the bounded regional probe**

In `public/client/region-picker.js`, export `probeRegion` and `probeRegions`:

```js
export async function probeRegion(region, {
  fetchImpl = fetch,
  now = () => performance.now(),
  timeoutMs = 2000,
} = {}) {
  const controller = new AbortController();
  const started = now();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${region.origin}/region-status`, {
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ...region, online: false, rttMs: null, error: `HTTP ${response.status}` };
    }
    const status = await response.json();
    if (status.region !== region.id
      || !Number.isSafeInteger(status.humanPlayers) || status.humanPlayers < 0
      || !Number.isSafeInteger(status.bots) || status.bots < 0
      || !Number.isSafeInteger(status.maxPlayers) || status.maxPlayers < 1) {
      return { ...region, online: false, rttMs: null, error: 'invalid status response' };
    }
    return {
      ...region,
      ...status,
      online: true,
      rttMs: Math.max(0, Math.round(now() - started)),
    };
  } catch (error) {
    if (error.name === 'AbortError' || error instanceof TypeError) {
      return { ...region, online: false, rttMs: null, error: 'unreachable' };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function probeRegions(regions, options) {
  return Promise.all(regions.map(region => probeRegion(region, options)));
}
```

Test parallel completion, the 2000 ms abort, invalid response, one failed region, and
one successful region with injected `fetchImpl` and `now`.

- [ ] **Step 4: Implement saved manual choice and visible state**

Add `createRegionPicker({ root, store, regions = REGIONS, fetchImpl = fetch })`.
It renders status only through DOM nodes and `textContent`, loads `bv.region` on
startup, and exposes:

```js
{
  start(),
  selectedRegion(), // selected region object, or null until a probe completes
  prepareJoin(),
  stop(),
}
```

Use this state transition in the picker:

```js
const state = { results: [], manualId: store.get('bv.region'), timer: null };
const selectedId = () => state.manualId || closestReachable(state.results);

async function refresh() {
  state.results = await probeRegions(regions, { fetchImpl });
  render(state.results, selectedId());
}

function choose(id) {
  if (!regions.some(region => region.id === id)) return;
  state.manualId = id;
  store.set('bv.region', id);
  render(state.results, id);
}

async function prepareJoin() {
  await refresh();
  const id = selectedId();
  const status = state.results.find(result => result.id === id);
  return status?.online ? id : null;
}
```

Attach `choose()` to each region button. `start()` runs `refresh()` immediately and
every 30 seconds; `stop()` clears that interval. If a saved region ID is no longer in
`regions`, remove it and use the nearest reachable result. A manual selection is never
replaced by later probe results. A manual selection that is offline remains selected
and blocks joining with its visible offline message.

For each result, create a button with `document.createElement('button')`, set
`type = 'button'`, `dataset.region`, `aria-pressed`, and `disabled = !result.online`,
then append flag/name/latency/player/bot spans with `textContent`. Put the HTTP error
or `unreachable` reason in `.regionPickerStatus`. Catch unexpected refresh errors and
put their message in that status element; do not leave a rejected polling promise
unhandled.

- [ ] **Step 5: Add the failing accessibility/layout assertion**

Add a test to `test/region-picker-ui.test.js` that reads `public/index.html` and
`public/style.css`, then asserts `#regionPicker` exists, the region buttons use
`role="group"` and `aria-pressed`, selected choices have a visible style, and
`:focus-visible` has an outline.

- [ ] **Step 6: Run the focused UI test and confirm it fails**

Run: `node --test test/region-picker-ui.test.js`

Expected before implementation: the picker markup and selected/focus styles are
missing.

- [ ] **Step 7: Add accessible selector markup**

Insert a selector next to the player form and above PLAY in `public/index.html`:

```html
<section id="regionPicker" aria-label="Choose a game server">
  <p class="regionPickerTitle">CHOOSE YOUR SERVER</p>
  <div class="regionChoices" role="group" aria-label="Available game servers"></div>
  <p class="regionPickerStatus" role="status" aria-live="polite"></p>
</section>
```

The client creates two `<button type="button">` elements with `data-region`,
`aria-pressed`, flag, region name, RTT, human count/capacity, and bot count using
`textContent` and safe DOM APIs.

- [ ] **Step 8: Style the selector for the existing game aesthetic**

Add compact dark panels, gold selected outline, muted offline state, visible focus
outline, and a narrow-screen stacked layout in `public/style.css`. Keep the selector
within the current menu card and preserve existing responsive scroll behavior.

- [ ] **Step 9: Verify selector tests and run the local page**

Run: `node --test test/region-picker.test.js test/region-picker-ui.test.js`

Expected: all probe, saved-choice, and accessible-markup tests pass. Start `npm start`, open
`http://localhost:8080/`, and verify both region rows fit above PLAY at desktop and
mobile widths.

- [ ] **Step 10: Commit**

```bash
git add public/client/region-picker.js public/index.html public/style.css test/region-picker.test.js test/region-picker-ui.test.js
git commit -m "feat(regions): add landing server selector"
```

## Task 4: Route joins and reconnects through the selected region

**Files:**
- Modify: `public/client/net.js`
- Modify: `public/client/main.js`
- Modify: `public/admin.js`
- Modify: `shared/regions.js`
- Create: `shared/region-keys.js`
- Create: `test/region-transport.test.js`
- Create: `test/region-credentials.test.js`
- Modify: `test/admin-ui.test.js`

- [ ] **Step 1: Add transport URL tests**

Create `test/region-transport.test.js` with:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transportUrls } from '../shared/regions.js';

test('regional secure transport URLs use the selected host', () => {
  assert.deepEqual(transportUrls('https://us.boombeard.co.za'), {
    ws: 'wss://us.boombeard.co.za/ws',
    wt: 'https://us.boombeard.co.za/wt',
  });
});

test('local HTTP uses WebSocket without WebTransport', () => {
  assert.deepEqual(transportUrls('http://localhost:8080'), {
    ws: 'ws://localhost:8080/ws',
    wt: null,
  });
});
```

Implement `transportUrls` in `shared/regions.js`:

```js
export function transportUrls(origin) {
  const base = new URL(origin);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new TypeError('unsupported region protocol');
  }
  const secure = base.protocol === 'https:';
  return {
    ws: `${secure ? 'wss:' : 'ws:'}//${base.host}/ws`,
    wt: secure ? `https://${base.host}/wt` : null,
  };
}
```

- [ ] **Step 2: Verify the new transport tests fail**

Run: `node --test test/region-transport.test.js`

Expected before implementation: `transportUrls` is not exported.

- [ ] **Step 3: Keep the selected region for every reconnect**

Import `transportUrls` from `shared/regions.js`. Extend `createNet.connect` with a
validated region ID. Store that ID for the entire socket lifecycle; `open()` and every
reconnect use the corresponding origin from `REGIONS`, never the current page host by
accident.

- [ ] **Step 4: Namespace per-region identities**

Keep the existing ZA keys for backwards compatibility. Create
`shared/region-keys.js`:

```js
export const playerIdKey = region => region === 'za' ? 'bv.playerId' : `bv.playerId.${region}`;
export const trustKey = (region, name) => region === 'za'
  ? `bv.trust.${String(name ?? '').trim().toLowerCase()}`
  : `bv.trust.${region}.${String(name ?? '').trim().toLowerCase()}`;
```

Import and use these helpers in `public/client/net.js` for player ID and trust reads
and writes. Keep `bv.name` and `bv.device` shared. Keep the existing admin key scoped
to the current page origin; each server receives a unique key, so host privileges only
apply when the browser is on that regional origin.

In `public/admin.js`, import `regionIdForOrigin` and `trustKey`, set
`const regionId = regionIdForOrigin(location.origin)`, and read the login token with
`store.get(trustKey(regionId, name))`. Update `test/admin-ui.test.js` to assert that
the region helper and region-scoped trust key are used instead of the ZA-only literal.

Create `test/region-credentials.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playerIdKey, trustKey } from '../shared/region-keys.js';

test('ZA keeps existing identity keys', () => {
  assert.equal(playerIdKey('za'), 'bv.playerId');
  assert.equal(trustKey('za', 'CobusVW'), 'bv.trust.cobusvw');
});

test('US identity keys do not overwrite ZA credentials', () => {
  assert.equal(playerIdKey('us'), 'bv.playerId.us');
  assert.equal(trustKey('us', 'CobusVW'), 'bv.trust.us.cobusvw');
  assert.notEqual(playerIdKey('us'), playerIdKey('za'));
  assert.notEqual(trustKey('us', 'CobusVW'), trustKey('za', 'CobusVW'));
});
```

- [ ] **Step 5: Re-probe immediately before registration/join**

Make the landing-page `play()` path await `regionPicker.prepareJoin()` before
`net.connect()`. A manual region that became unavailable remains selected, shows an
error, and does not connect. With automatic selection, use the lowest fresh successful
RTT. Pass the resulting region ID to `net.connect(name, observe, password, regionId)`.
Use the same path for spectate and password retries. Guard duplicate clicks while the
probe is pending, restore the PLAY button in `finally`, and turn unexpected probe
errors into the existing visible toast.

- [ ] **Step 6: Verify network and authentication regressions**

Run:

```bash
node --test test/region-transport.test.js test/region-credentials.test.js test/transport.test.js test/accounts.test.js test/admin-auth.test.js
```

Expected: all tests pass, legacy ZA player IDs and trust tokens remain readable, and
US IDs/tokens do not overwrite ZA values.

- [ ] **Step 7: Commit**

```bash
git add public/client/net.js public/client/main.js test/region-transport.test.js
git commit -m "feat(regions): connect through selected server"
```

## Task 5: Make the two-instance deployment repeatable

**Files:**
- Modify: `infra/bootstrap.sh`
- Modify: `config.example.ini`
- Modify: `docs/DEPLOY.md`
- Modify: `test/config.test.js`

- [ ] **Step 1: Add config tests for the region ID**

Assert default `regionId` is `za`, `REGION_ID=us` overrides the config file, and an
invalid region ID is rejected rather than silently mapped to ZA.

Add a subprocess test to `test/config.test.js` that runs:

```js
const result = spawnSync(process.execPath, [
  '--input-type=module',
  '-e',
  "import { config } from './server/config.js'; process.stdout.write(config.regionId)",
], {
  cwd: ROOT,
  env: { ...process.env, REGION_ID: 'us' },
  encoding: 'utf8',
});
assert.equal(result.status, 0, result.stderr);
assert.equal(result.stdout, 'us');
```

Add a second subprocess with `REGION_ID=moon`; assert nonzero exit and an error
containing `invalid region id`.

- [ ] **Step 2: Verify config tests fail**

Run: `node --test test/config.test.js`

Expected before implementation: config has no `regionId`.

- [ ] **Step 3: Make bootstrap preserve region and generate a unique admin key**

Initialize `REGION_ID` from the environment, otherwise read an existing config value,
otherwise default to `za`. Reject anything other than `za` or `us`; write
`region_id = $REGION_ID` in the generated `[server]` section. Preserve an existing
admin key on re-runs; generate a new random key for a fresh instance, never copy the
ZA key. Keep the dashboard password from the environment or existing config. The
bootstrap-provided owner link enrolls the unique key on that host.

In `server/config.js`, use this validation before constructing `config`:

```js
const regionId = String(pick('REGION_ID', 'server', 'region_id', 'za')).toLowerCase();
if (!['za', 'us'].includes(regionId)) {
  throw new RangeError(`invalid region id: ${regionId}`);
}
```

Then add `regionId` to the exported `config` object.

- [ ] **Step 4: Document the regional DNS and admin setup**

Document `us.boombeard.co.za A 52.21.210.27`, the required 80/443 security-group
ingress, same-version deployment from `main`, separate local data directories, and
the first-time NA account/trusted-browser enrollment. State that `/admin` on each
regional hostname reports only that host's data.

- [ ] **Step 5: Verify setup and full tests**

Run:

```bash
node --test test/config.test.js test/region-status.test.js test/admin-integration.test.js
npm test
npm audit --omit=dev
```

Expected: all tests pass and the production dependency audit reports zero
vulnerabilities.

- [ ] **Step 6: Commit**

```bash
git add infra/bootstrap.sh config.example.ini docs/DEPLOY.md test/config.test.js
git commit -m "docs(deploy): configure regional game servers"
```

## Task 6: Provision and verify North America

**Prerequisites:** Route 53 must contain `us.boombeard.co.za A 52.21.210.27`; ports
22, 80, and 443 must be reachable. Current credentials lack Route 53 write permission.

**Files/Systems:**
- Remote: North America EC2 at `52.21.210.27`
- Local secret: `~/Downloads/bombs-away-na.pem` (do not print or commit)
- Local deploy config: ignored `config.ini`

- [ ] **Step 1: Restrict the SSH key permissions**

Run: `chmod 600 "$HOME/Downloads/bombs-away-na.pem"`

Verify only file mode with: `stat -f '%Sp' "$HOME/Downloads/bombs-away-na.pem"`

Expected: `-rw-------`.

- [ ] **Step 2: Verify DNS and SSH before changing the server**

Confirm `us.boombeard.co.za` resolves to `52.21.210.27`; the current record is absent
and the available AWS identity has no Route 53 permission. Have an authorized operator
create the exact A record before continuing. Then run an SSH `true` command with
`BatchMode=yes` and a short connection timeout. Do not print the private key or remote
secret configuration. Read the instance's security-group ingress through AWS and
confirm TCP 22, 80, and 443 are open to the required sources. If DNS, SSH, or ingress
cannot be made ready with authorized credentials, stop before changing the instance.
Stop if the host key or target does not match the stated EIP.

- [ ] **Step 3: Integrate and publish one tested main commit**

After all code tasks pass, merge `feature/multi-region` into `main` with a fast-forward,
run `npm test` and `npm audit --omit=dev` again, then push `main`. Retarget the already
published `v1.0.8` tag to this tested commit as previously requested, then update the
remote tag. Record the resulting full commit SHA for both deployments.

- [ ] **Step 4: Bootstrap the NA instance**

Use `infra/bootstrap.sh` with `HOST=us.boombeard.co.za`, `REGION_ID=us`, and the
existing Let's Encrypt contact from the ZA certificate registration. Supply the
dashboard password without echoing it; let bootstrap generate a unique NA admin key
and keep its enrollment link private. Keep `/var/lib/boom-beard` separate on the NA
server; do not rsync ZA user data.

- [ ] **Step 5: Deploy the same commit to both regions**

Run `npm run deploy` once from `main` using the existing ZA deploy configuration.
Then run it again with `SSH_HOST=52.21.210.27`, `SSH_USER=ec2-user`, and
`KEY=$HOME/Downloads/bombs-away-na.pem`. Confirm both deploy reports identify the
same commit/build and both health checks succeed.

- [ ] **Step 6: Verify both public origins**

Run:

```bash
curl -fsS https://boombeard.co.za/version
curl -fsS https://us.boombeard.co.za/version
curl -fsS https://boombeard.co.za/region-status
curl -fsS https://us.boombeard.co.za/region-status
curl -sS -o /dev/null -w '%{http_code}\n' https://boombeard.co.za/favicon.ico
curl -sS -o /dev/null -w '%{http_code}\n' https://boombeard.co.za/admin
curl -sS -o /dev/null -w '%{http_code}\n' https://us.boombeard.co.za/admin
```

Expected: both versions match; status responses identify different regions; both
favicons and login pages return 200; unauthenticated admin data APIs return 401.

- [ ] **Step 7: Verify manual and automatic selection in a browser**

Check that initial selection follows the lower measured RTT, the flag/ping/human
count/capacity update, manual selection survives reload, an offline server is visibly
disabled, and the selected region's connection reports that region's data.

- [ ] **Step 8: Preserve final integration evidence**

Confirm `git status --short --branch` is clean and leave the existing local recovery
stash untouched. Never commit SSH keys, admin passwords, player databases, or generated
server configuration.
