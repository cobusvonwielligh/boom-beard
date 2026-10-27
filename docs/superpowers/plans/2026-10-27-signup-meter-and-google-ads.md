# Signup Meter, Admin Signup Statistics, and Google Ads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a unique human-signup total on the desktop landing page, expose rolling signup windows to the owner diagnostics, and install the consent-safe Google Ads base tag.

**Architecture:** Aggregate signup data directly from the existing durable account records, expose a total-only public endpoint, and attach the full aggregate to the existing owner-polled health payload. Render the landing meter through a small pure client module, extend the current diagnostics row, and install the Google tag in an explicit document head with denied Consent Mode v2 defaults and a narrowly expanded CSP.

**Tech Stack:** Node.js 20, `node:test`, existing HTTP/WebSocket server, vanilla HTML/CSS/JavaScript, Google gtag.js

---

### Task 1: Add account signup aggregates

**Files:**
- Modify: `test/accounts.test.js`
- Modify: `server/accounts.js`

- [ ] **Step 1: Write the failing aggregate test**

Add to `test/accounts.test.js`:

```js
test('signup statistics count unique accounts in inclusive rolling windows', async () => {
  const d = dir();
  const a = createAccounts({ dataDir: d });
  for (const name of ['fresh', 'day-edge', 'week-edge', 'month-edge', 'old', 'legacy']) {
    assert.equal((await a.register(name, PW)).ok, true);
  }
  a.flushSync();

  const DAY = 24 * 3600_000;
  const now = Date.UTC(2026, 9, 27, 12);
  const file = path.join(d, 'accounts.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.accounts.fresh.created = now - 1;
  data.accounts['day-edge'].created = now - DAY;
  data.accounts['week-edge'].created = now - 7 * DAY;
  data.accounts['month-edge'].created = now - 30 * DAY;
  data.accounts.old.created = now - 30 * DAY - 1;
  delete data.accounts.legacy.created;
  fs.writeFileSync(file, JSON.stringify(data));

  const loaded = createAccounts({ dataDir: d });
  assert.deepEqual(loaded.stats(now), {
    total: 6,
    last24h: 2,
    last7d: 3,
    last30d: 4,
  });
});
```

- [ ] **Step 2: Run the account test and verify it fails**

Run: `node --test test/accounts.test.js`

Expected: FAIL because `loaded.stats` does not exist.

- [ ] **Step 3: Implement the pure aggregate**

Inside `createAccounts`, add:

```js
  const DAY_MS = 24 * 3600_000;

  function stats(now = Date.now()) {
    const at = Number(now);
    const safeNow = Number.isFinite(at) ? at : Date.now();
    const out = { total: accounts.size, last24h: 0, last7d: 0, last30d: 0 };
    for (const rec of accounts.values()) {
      const created = Number(rec?.created);
      if (!Number.isFinite(created) || created > safeNow) continue;
      const age = safeNow - created;
      if (age <= DAY_MS) out.last24h++;
      if (age <= 7 * DAY_MS) out.last7d++;
      if (age <= 30 * DAY_MS) out.last30d++;
    }
    return out;
  }
```

Expose `stats` beside `has` and `lockedFor` in the frozen return object.

- [ ] **Step 4: Run account tests**

Run: `node --test test/accounts.test.js`

Expected: all account tests pass.

- [ ] **Step 5: Commit the account aggregate**

```bash
git add server/accounts.js test/accounts.test.js
git commit -m "feat: aggregate human signup statistics"
```

### Task 2: Expose public and owner signup statistics

**Files:**
- Modify: `test/smoke.test.js`
- Modify: `server/index.js`

- [ ] **Step 1: Add failing endpoint and health assertions**

In `test/smoke.test.js`, import `fs` and `os`. Change:

```js
const startServer = () => new Promise((resolve, reject) => {
```

to:

```js
const startServer = dataDir => new Promise((resolve, reject) => {
```

and add this property to the existing child `env` object:

```js
      DATA_DIR: dataDir,
```

At the top of the parent test:

```js
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-smoke-'));
  await startServer(dataDir);
  t.after(async () => {
    server.kill('SIGTERM');
    await once(server, 'exit');
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
```

Add:

```js
  await t.test('signup count is public but exposes no account details', async () => {
    const res = await fetch(base + '/signup-count');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=60');
    assert.deepEqual(await res.json(), { count: 0 });
  });
```

Extend the existing health assertion:

```js
    assert.deepEqual(h.signups, { total: 0, last24h: 0, last7d: 0, last30d: 0 });
```

- [ ] **Step 2: Run the smoke test and verify it fails**

Run: `node --test test/smoke.test.js`

Expected: `/signup-count` returns 404 and `h.signups` is absent.

- [ ] **Step 3: Implement the total-only public endpoint**

In `serve`, before `/healthz`, add:

```js
  if (url === '/signup-count') {
    const count = accounts.stats().total;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    });
    return res.end(JSON.stringify({ count }));
  }
```

- [ ] **Step 4: Add the aggregate to owner-polled health data**

Add `signups: accounts.stats()` to the extra object passed into `hub.health`.

- [ ] **Step 5: Run the smoke and account tests**

Run: `node --test test/smoke.test.js test/accounts.test.js`

Expected: all endpoint, health, and account tests pass.

- [ ] **Step 6: Commit the server surfaces**

```bash
git add server/index.js test/smoke.test.js
git commit -m "feat: expose aggregate signup counts"
```

### Task 3: Build the public meter and owner diagnostic row

**Files:**
- Create: `public/client/signup-meter.js`
- Create: `test/signup-meter.test.js`
- Modify: `public/index.html`
- Modify: `public/style.css`
- Modify: `public/client/main.js`

- [ ] **Step 1: Write failing formatter, fetch, placement, and diagnostics tests**

Create `test/signup-meter.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { signupDigits, fetchSignupCount } from '../public/client/signup-meter.js';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('signup digits are padded, expandable, and honest about unknown values', () => {
  assert.equal(signupDigits(0), '00000');
  assert.equal(signupDigits(184), '00184');
  assert.equal(signupDigits(123456), '123456');
  for (const bad of [-1, 1.5, NaN, null, undefined, '12']) assert.equal(signupDigits(bad), '-----');
});

test('signup count fetch accepts only finite non-negative integers', async () => {
  const good = async () => ({ ok: true, json: async () => ({ count: 42 }) });
  const bad = async () => ({ ok: true, json: async () => ({ count: -1 }) });
  const down = async () => { throw new Error('offline'); };
  assert.equal(await fetchSignupCount(good), 42);
  assert.equal(await fetchSignupCount(bad), null);
  assert.equal(await fetchSignupCount(down), null);
});

test('the landing meter and owner signup diagnostics occupy their intended surfaces', () => {
  const html = read('public/index.html');
  const css = read('public/style.css');
  const main = read('public/client/main.js');
  const menu = html.slice(html.indexOf('<div id="menu">'), html.indexOf('<script type="module"'));
  assert.match(menu, /id="signupMeter"/);
  assert.match(menu, /id="signupDigits"/);
  assert.match(html, /id="perfSignup24"/);
  assert.match(html, /id="perfSignup7"/);
  assert.match(html, /id="perfSignup30"/);
  assert.match(css, /#signupMeter\s*\{[^}]*position:\s*fixed[^}]*right:[^;]+;[^}]*bottom:/s);
  assert.match(css, /#signupDigits/);
  assert.match(main, /fetchSignupCount/);
  assert.match(main, /perfSignup24/);
  assert.match(main, /perfSignup7/);
  assert.match(main, /perfSignup30/);
});
```

- [ ] **Step 2: Run the focused UI test and verify it fails**

Run: `node --test test/signup-meter.test.js`

Expected: FAIL because the module and UI elements do not exist.

- [ ] **Step 3: Implement the pure signup meter module**

Create `public/client/signup-meter.js`:

```js
export function signupDigits(count, width = 5) {
  if (!Number.isSafeInteger(count) || count < 0) return '-'.repeat(width);
  return String(count).padStart(width, '0');
}

export async function fetchSignupCount(fetcher = fetch) {
  try {
    const res = await fetcher('/signup-count', { cache: 'no-store' });
    if (!res?.ok) return null;
    const count = (await res.json())?.count;
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Add the compact bottom-right landing meter markup**

Inside `#menu`, after `#menuWrap`, add:

```html
    <div id="signupMeter" aria-label="human signup count">
      <span class="signupScrew signupScrewA"></span>
      <span class="signupScrew signupScrewB"></span>
      <span class="signupLabel">humans registered</span>
      <span id="signupDigits" aria-live="polite" aria-label="signup count unavailable">
        <span class="signupDigit">-</span><span class="signupDigit">-</span>
        <span class="signupDigit">-</span><span class="signupDigit">-</span>
        <span class="signupDigit signupDigitLast">-</span>
      </span>
    </div>
```

Add a third row under the existing server rows:

```html
      <div class="perfRow perfSignups">
        <span>SIGNUPS</span><span class="perfSep">·</span>
        <span id="perfSignup24">24H --</span><span class="perfSep">·</span>
        <span id="perfSignup7">7D --</span><span class="perfSep">·</span>
        <span id="perfSignup30">30D --</span>
      </div>
```

- [ ] **Step 5: Style the meter as a compact mechanical water meter**

Add these desktop-only rules; do not add a mobile media query:

```css
#signupMeter {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 3;
  width: max-content;
  max-width: 220px;
  min-height: 52px;
  box-sizing: border-box;
  padding: 8px 12px 8px 10px;
  border: 2px solid #7a5527;
  border-radius: 9px;
  background:
    linear-gradient(112deg, #fff3 0 8%, transparent 9% 72%, #fff1 73% 78%, transparent 79%),
    linear-gradient(#9f793d, #3d2b15 24%, #18130c 76%, #77562b);
  box-shadow: inset 0 0 0 2px #d7ac5a33, inset 0 -8px 16px #0007, 0 8px 24px #0009;
  color: #d8c7a0;
  pointer-events: none;
  user-select: none;
}
.signupLabel {
  display: block;
  margin: 0 0 5px 2px;
  color: #e0bd72;
  font: 700 7px/1 var(--nums);
  letter-spacing: 0.2em;
  text-transform: uppercase;
}
#signupDigits { display: flex; gap: 2px; }
.signupDigit {
  position: relative;
  display: inline-grid;
  place-items: center;
  width: 20px;
  height: 27px;
  overflow: hidden;
  border: 1px solid #a9874e55;
  border-radius: 3px;
  background: linear-gradient(#222 0 44%, #050505 48% 53%, #1a1a1a 57%, #020202 100%);
  box-shadow: inset 0 0 7px #000, 0 1px 0 #e8c98233;
  color: #f3e7c8;
  font: 700 18px/1 var(--nums);
  text-shadow: 0 0 5px #fff3;
}
.signupDigit::after {
  content: "";
  position: absolute;
  inset: 48% 0 auto;
  border-top: 1px solid #000;
  box-shadow: 0 1px #ffffff0e;
}
.signupDigitLast { color: #ff8064; text-shadow: 0 0 6px #a83442; }
.signupScrew {
  position: absolute;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: radial-gradient(circle at 35% 35%, #e0c184, #4a3218 70%);
  box-shadow: 0 1px 2px #000;
}
.signupScrewA { top: 5px; right: 5px; }
.signupScrewB { bottom: 5px; right: 5px; }
```

- [ ] **Step 6: Render and refresh the landing count**

Import the new helpers in `public/client/main.js`:

```js
import { signupDigits, fetchSignupCount } from './signup-meter.js';
```

Add:

```js
function renderSignupMeter(count) {
  const digits = signupDigits(count);
  const root = $('signupDigits');
  root.replaceChildren(...[...digits].map((digit, i) => {
    const wheel = document.createElement('span');
    wheel.className = `signupDigit${i === digits.length - 1 ? ' signupDigitLast' : ''}`;
    wheel.textContent = digit;
    return wheel;
  }));
  root.setAttribute('aria-label', count === null ? 'signup count unavailable' : `${count} humans registered`);
}

async function refreshSignupMeter() {
  renderSignupMeter(await fetchSignupCount());
}
```

Call `refreshSignupMeter()` once during landing boot and again in `leave()` after the menu is shown.

- [ ] **Step 7: Render rolling owner statistics defensively**

In `sampleServerHealth`, add:

```js
  const signups = h.signups;
  const signupText = (key, label) => Number.isFinite(signups?.[key])
    ? `${label} ${Math.max(0, signups[key] | 0)}` : `${label} --`;
  perfCell('perfSignup24', signupText('last24h', '24H'), false);
  perfCell('perfSignup7', signupText('last7d', '7D'), false);
  perfCell('perfSignup30', signupText('last30d', '30D'), false);
```

- [ ] **Step 8: Run focused UI and browser-source tests**

Run: `node --test test/signup-meter.test.js test/client-modules.test.js test/sources.test.js`

Expected: all formatter, fetch, placement, module-graph, and source tests pass.

- [ ] **Step 9: Commit the two UI surfaces**

```bash
git add public test/signup-meter.test.js
git commit -m "feat: show human signup meter"
```

### Task 4: Install the consent-safe Google Ads base tag

**Files:**
- Create: `test/google-tag.test.js`
- Modify: `public/index.html`
- Modify: `server/index.js`

- [ ] **Step 1: Write failing tag-order and CSP tests**

Create `test/google-tag.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

test('Google Ads tag has denied Consent Mode v2 defaults before loading', () => {
  assert.equal((html.match(/AW-18535357585/g) || []).length, 2);
  const consent = html.indexOf("gtag('consent', 'default'");
  const loader = html.indexOf('googletagmanager.com/gtag/js?id=AW-18535357585');
  const config = html.indexOf("gtag('config', 'AW-18535357585')");
  assert.ok(consent > 0 && consent < loader && loader < config, 'consent/tag/config order is unsafe');
  for (const key of ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage']) {
    assert.match(html, new RegExp(`'${key}': 'denied'`));
  }
});

test('the document has an explicit head and the Google Ads CSP allowlist', () => {
  assert.match(html, /<html lang="en">\s*<head>/);
  assert.match(html, /<\/head>\s*<body>/);
  for (const host of [
    'www.googletagmanager.com', 'www.googleadservices.com', 'googleads.g.doubleclick.net',
    'pagead2.googlesyndication.com', 'www.google.com', 'ad.doubleclick.net',
  ]) assert.ok(server.includes(host), `${host} missing from CSP`);
  assert.match(server, /frame-src[^\n]*www\.googletagmanager\.com/);
});
```

- [ ] **Step 2: Run the Google tag test and verify it fails**

Run: `node --test test/google-tag.test.js`

Expected: FAIL because the tag, explicit head, and CSP hosts are absent.

- [ ] **Step 3: Make the document structure explicit**

Open `<head>` immediately after `<html lang="en">`, close it after the stylesheet and Google tag, open `<body>` before page content, and close `</body></html>` at the end of the document.

- [ ] **Step 4: Install consent defaults before the Google tag**

Inside `<head>`, after metadata and before the external loader, add:

```html
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag() { dataLayer.push(arguments); }
      gtag('consent', 'default', {
        'ad_storage': 'denied',
        'ad_user_data': 'denied',
        'ad_personalization': 'denied',
        'analytics_storage': 'denied'
      });
    </script>
    <script async src="https://www.googletagmanager.com/gtag/js?id=AW-18535357585"></script>
    <script>
      gtag('js', new Date());
      gtag('config', 'AW-18535357585');
    </script>
```

- [ ] **Step 5: Extend CSP with Google's documented Ads hosts**

Keep the existing directives and add:

```js
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.googleadservices.com https://www.google.com",
  "img-src 'self' data: https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://pagead2.googlesyndication.com https://www.google.com",
  "connect-src 'self' ws: wss: https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://pagead2.googlesyndication.com https://www.google.com https://ad.doubleclick.net",
  "frame-src https://www.googletagmanager.com",
```

Replace the existing `script-src`, `img-src`, and `connect-src` lines rather than duplicating directives.

- [ ] **Step 6: Run tag, source, and smoke tests**

Run: `node --test test/google-tag.test.js test/client-modules.test.js test/sources.test.js test/smoke.test.js`

Expected: the tag ordering, CSP, document structure, module graph, source references, and deployment spine all pass.

- [ ] **Step 7: Commit the base tag**

```bash
git add public/index.html server/index.js test/google-tag.test.js
git commit -m "feat: install consent-safe Google Ads tag"
```

### Task 5: Verify the complete change

**Files:**
- No additional production files

- [ ] **Step 1: Run focused validation**

Run:

```bash
node --test test/accounts.test.js test/smoke.test.js test/signup-meter.test.js test/google-tag.test.js test/client-modules.test.js test/sources.test.js
```

Expected: all focused tests pass.

- [ ] **Step 2: Run repository validation**

Run: `git diff --check && npm test`

Expected: all project tests pass.

- [ ] **Step 3: Inspect editor diagnostics**

Check `server/accounts.js`, `server/index.js`, `public/index.html`, `public/style.css`, `public/client/main.js`, and `public/client/signup-meter.js` for diagnostics.

- [ ] **Step 4: Complete the branch workflow**

Use the finishing-a-development-branch workflow to integrate the tested commits. Push or deploy only with explicit user authorization. After deployment, verify `/signup-count`, `/healthz`, Google tag loading, CSP console output, and the landing meter on the live desktop site.
