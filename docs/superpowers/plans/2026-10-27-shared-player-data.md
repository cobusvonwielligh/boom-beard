# Shared Player Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make player accounts and lifetime career progression identical across ZA and US while keeping live room state and machine metrics regional.

**Architecture:** ZA remains the authoritative file-backed account/career store behind an internal TLS API protected by a server-only token. US connects to the ZA Elastic IP while verifying TLS against `boombeard.co.za`, so internal calls do not depend on apex DNS. US authenticates through ZA and persists career mutations in a durable, idempotent outbox until ZA acknowledges them; local game loops use a cached shared-career read model. A one-time merge preserves both regions' current account credentials and adds existing human career totals.

**Tech Stack:** Node.js ES modules, HTTPS/JSON internal API, timing-safe shared secret, atomic JSON persistence, durable operation outbox, Node test runner.

---

## File map

- `server/shared-data-http.js`: ZA-only internal API routes, authorization, request validation, and idempotency.
- `server/shared-data-client.js`: US HTTPS client with fixed ZA IP, ZA TLS server name, bounded timeout, and explicit error responses.
- `server/shared-data-outbox.js`: durable US operation queue and retry/replay.
- `server/accounts.js`: support multiple existing password hashes for a merged account while keeping them hashed.
- `server/leaderboard.js`: export/merge regional career data and apply idempotent career updates.
- `server/config.js`, `config.example.ini`, `infra/bootstrap.sh`: shared endpoint/token configuration.
- `server/index.js`: enable the internal API only on ZA, select the US shared client, and retain regional health/admin behavior.
- `server/net.js`: await shared account lookups and authentication on US joins.
- `server/room.js`: publish career deltas and use shared shop state without blocking the simulation tick.
- `shared/region-keys.js`, `public/client/store.js`: reuse the global trusted-browser token while preserving legacy region keys.
- `infra/merge-region-data.js`: one-time backup, fetch, merge, and verification of existing US account/career records.
- `test/shared-data-http.test.js`, `test/shared-data-client.test.js`, `test/shared-data-outbox.test.js`, `test/shared-data-merge.test.js`, `test/accounts.test.js`, `test/leaderboard.test.js`, `test/region-credentials.test.js`, `test/room.test.js`: focused regression tests.

### Task 1: Merge existing account and career records safely

**Files:**
- Create: `server/shared-data-merge.js`
- Test: `test/shared-data-merge.test.js`

- [ ] **Step 1: Add account merge tests**

Test two account records with the same normalized name and different password hashes. The result must keep both hashed credentials, combine trusted-device records by digest, preserve the earliest `created`, latest `lastSeen`, and exclusion flags, and never output plaintext passwords.

- [ ] **Step 2: Add career merge tests**

Merge ZA and US snapshots keyed by the existing `careerKey`. Assert human XP/score, kills, deaths, medals, coins, spent coins, and pending shop counts are combined; cap each shop count at `SHOP_ITEMS[key].cap`; keep `bot_*` records region-local.

- [ ] **Step 3: Implement pure merge helpers**

Export `mergeAccountRecords(zaRecords, usRecords)` and `mergeCareerRecords(zaPlayers, usPlayers)`. Keep them pure: inputs are snapshots and outputs are new objects; do not write files in these helpers.

- [ ] **Step 4: Run merge tests**

Run: `node --test test/shared-data-merge.test.js`
Expected: PASS without modifying existing source files.

### Task 2: Add the authenticated ZA shared-data API

**Files:**
- Create: `server/shared-data-http.js`
- Modify: `server/config.js`
- Modify: `server/index.js`
- Modify: `config.example.ini`
- Test: `test/shared-data-http.test.js`

- [ ] **Step 1: Test rejected and authorized requests**

Create a local HTTP server around `createSharedDataHttpHandler`. Assert unauthenticated, wrong-token, invalid-method, invalid-payload, and non-ZA-region requests do not execute operations. Assert an authorized request returns only its operation result and has no CORS allow-origin header.

- [ ] **Step 2: Add shared-store config**

Read the shared token, host, and TLS server name in `server/config.js`; require a fixed ZA IP and a token of at least 32 characters on US. Keep the token only in ignored `config.ini`/environment. Add blank placeholders, never real secrets, to `config.example.ini`.

- [ ] **Step 3: Implement one internal JSON RPC route**

Use `POST /internal/shared-data`, `Authorization: Bearer <shared_data_token>`, and request bodies shaped as:

```json
{"op":"account.checkDevice","name":"cobusvw","token":"opaque-device-token"}
```

Support only the allowlisted account/career operations defined in the handler. Compare the token with `sameSecret`, cap JSON bodies at 8 MiB, return `401` on auth failure, `400` on invalid requests, and `503` for store errors. Keep the route behind `guard.allowRequest`, emit no CORS header, and never log request bodies, passwords, device tokens, or hashes.

- [ ] **Step 4: Register the handler on ZA only**

In `server/index.js`, call the internal handler before static-file routing only when `config.regionId === 'za'`. Keep `/admin` and public `/region-status` behavior unchanged.

- [ ] **Step 5: Run API tests**

Run: `node --test test/shared-data-http.test.js`
Expected: PASS for authorized operation routing and all rejection cases.

### Task 3: Proxy US account authentication to ZA

**Files:**
- Create: `server/shared-data-client.js`
- Modify: `server/accounts.js`
- Modify: `server/net.js`
- Modify: `shared/region-keys.js`
- Test: `test/shared-data-client.test.js`
- Test: `test/accounts.test.js`
- Test: `test/region-credentials.test.js`

- [ ] **Step 1: Test the remote client contract**

Inject `httpsRequest` and assert `createSharedDataClient` connects to the configured IP with the configured TLS `servername`, keeps certificate verification enabled, and sends the configured authorization header. Assert timeout, non-JSON, 401, and 503 responses reject with explicit errors instead of success-shaped defaults.

- [ ] **Step 2: Implement the HTTPS API client**

Export `createSharedDataClient({ host, servername, token, requestImpl, timeoutMs })`. Connect to the fixed ZA Elastic IP as `host`, set `servername` to `boombeard.co.za`, and keep certificate verification enabled. POST to `/internal/shared-data`, validate `{ok:true,result}`, and throw a descriptive error for non-2xx responses. Inject `requestImpl` in tests.

- [ ] **Step 3: Make shared account checks awaitable**

Change US account adapter methods (`has`, `checkDevice`, `lockedFor`, `register`, `verify`) to use the remote client. In `server/net.js`, await all account checks before seat assignment; keep `ws.bvAuthing` and the readyState guard so slow cross-region auth cannot seat twice.

- [ ] **Step 4: Preserve trusted-browser compatibility**

Make the client prefer a global `bv.trust.<name>` key. Read the existing ZA key and existing region-suffixed US key as fallback, then write new shared tokens under the global key. Keep player seat IDs region-specific.

- [ ] **Step 5: Run auth and client tests**

Run: `node --test test/shared-data-client.test.js test/accounts.test.js test/region-credentials.test.js`
Expected: PASS for both regions using one authoritative account and for old token key migration.

### Task 4: Synchronize career stats and shop operations

**Files:**
- Modify: `server/leaderboard.js`
- Modify: `server/room.js`
- Modify: `server/net.js`
- Modify: `server/shared-data-http.js`
- Modify: `server/shared-data-client.js`
- Create: `server/shared-data-outbox.js`
- Test: `test/shared-data-outbox.test.js`
- Test: `test/leaderboard.test.js`
- Test: `test/shop-room.test.js`

- [ ] **Step 1: Add idempotent career mutation tests**

For an operation ID and a career delta, applying the same operation twice must add the delta once. A distinct operation ID must add it again. The outbox must retain unacknowledged writes across process restart and remove only IDs the ZA authority acknowledged.

- [ ] **Step 2: Implement the durable outbox**

Write pending records to `<data_dir>/shared-outbox.json` with file mode `0600`, atomic temp-write/fsync/rename, and one serialized flush chain. Each record contains `operationId`, `regionId`, operation type, normalized player name, and numeric delta only; no password or device token.

- [ ] **Step 3: Make score and medal writes idempotent**

Assign each US flush a monotonic operation ID and enqueue the `record`/`award` deltas. The ZA API applies each ID once and acknowledges it; the outbox replays after restart without duplicating score or medals.

- [ ] **Step 4: Share wallet and shop state transactionally**

Route `buy` and `consumePending` through the ZA API so two regions cannot spend the same wallet concurrently. Refactor the `shopbuy` message path to await the authoritative result and return the same `{ok, wallet, pending}` wire shape. Keep room ticks and snapshots local; do not await network calls inside the fixed-step simulation loop.

- [ ] **Step 5: Keep global career reads current**

The US adapter loads a ZA career snapshot at startup and refreshes it after acknowledged writes. `get`, `top`, and `all` combine the acknowledged ZA state with US-local pending deltas exactly once. Regional bot entries and live occupancy remain local.

- [ ] **Step 6: Run persistence and shop tests**

Run: `node --test test/shared-data-outbox.test.js test/leaderboard.test.js test/shop-room.test.js test/room.test.js`
Expected: PASS for retry, restart, duplicate operation IDs, and cross-region wallet integrity.

### Task 5: Configure and migrate both servers

**Files:**
- Modify: `infra/bootstrap.sh`
- Modify: `config.example.ini`
- Create: `infra/merge-region-data.js`
- Modify: `docs/DEPLOY.md`
- Test: `test/bootstrap-config.test.js`
- Test: `test/shared-data-merge.test.js`

- [ ] **Step 1: Add an idempotent migration command**

Back up the original ZA and US account/leaderboard files before merging. Transfer the US snapshots over authenticated TLS to the ZA internal API. The ZA merge endpoint uses `mergeAccountRecords` and `mergeCareerRecords` once per source snapshot ID; repeated migration requests return the prior result without changing totals again.

- [ ] **Step 2: Configure the shared server token**

Generate one random `shared_data_token` on ZA, store it mode `0600`, and install the same token on US. Set the US internal API host to ZA's fixed Elastic IP `15.240.88.189` and TLS `servername` to `boombeard.co.za`; keep certificate verification enabled. Do not print or commit the token. Keep the US public game origin as `https://52.21.210.27`. This internal connection does not depend on apex DNS; separately verify apex DNS points only to ZA for landing-page traffic.

- [ ] **Step 3: Verify migration before enabling US writes**

Compare unique account counts, account names, and per-name career totals before and after the merge. Verify duplicate account records retain all hashed credentials and no plaintext credentials appear in migration output.

- [ ] **Step 4: Document shared data ownership**

Update `docs/DEPLOY.md` to state ZA is the sole website/admin and shared player-data authority; US is game-only and requires the shared endpoint/token. Document that online counts/resource metrics stay regional, and explain outbox replay and manual deploy steps.

### Task 6: Full verification and rollout

**Files:**
- Verify: all files listed above and `docs/DEPLOY.md`

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: all tests pass.

- [ ] **Step 2: Verify shared behavior in a two-server test**

Create an account on ZA, sign in from US with the same password/token, add a known career delta on US, and confirm the ZA and US profile/leaderboard views return the same lifetime totals after acknowledgement. Verify the US active-player count remains local.

- [ ] **Step 3: Deploy only after DNS is ZA-only**

Confirm authoritative `boombeard.co.za` A answers include only `15.240.88.189`. Deploy the same commit to ZA and US, configure the shared token on both, run the US-to-ZA migration, and verify both servers are on the same release.

- [ ] **Step 4: Verify failure behavior**

Temporarily make the shared API unavailable in the test environment. Confirm US keeps a durable outbox, shows sync pending, does not double-apply replayed deltas, and explicitly rejects operations that require authoritative account/wallet state.
