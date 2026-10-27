# Shared Player Accounts and Career Data Design

## Goal

Use the same player account and lifetime career on ZA and US game servers while
keeping the landing page, admin dashboard, live room state, and machine metrics
on their intended region.

## Authority and data flow

- ZA is the canonical shared player-data authority because it is the public
  website and admin host. It keeps the authoritative account and career files.
- The US game server authenticates and performs shared-career operations
  through a private, token-authenticated HTTPS API on ZA. Server credentials
  stay in each server's ignored configuration and never reach browser code.
- The US server connects to ZA's fixed EIP using the ZA TLS hostname for
  certificate verification, so internal calls do not depend on the still-being-
  corrected public apex A records.
- Both rooms keep their live players, bots, round score, CPU/RAM/disk metrics,
  geography, and regional health local. Lifetime player progress, account
  identity, trusted-device records, wallet, shop progress, and the global
  all-time leaderboard are shared.
- Merge existing account files by normalized name. Preserve each existing
  password hash as an accepted credential until the player changes their
  password; union trusted-device records without exposing token hashes.
- Merge human career totals additively by player name, including XP/score,
  kills, deaths, medals, coins, and shop progress. Keep bot careers regional.

## Consistency and failure behavior

- ZA serializes shared writes and deduplicates US mutations by stable operation
  ID so retrying after a network error cannot double-count a round or purchase.
- The US server keeps a permission-restricted durable outbox for career
  mutations until ZA acknowledges them. It must not silently discard a write
  or replace the shared account/leaderboard with a stale local copy.
- During a ZA data-service outage, US gameplay can continue for already
  authenticated players, but new account operations and purchases that need
  authoritative state fail explicitly. US career values include its queued
  deltas and are marked pending; ZA shows acknowledged values until replay.
- The `/admin` dashboard remains ZA-only. Server resource metrics and live
  occupancy remain per-region; only player account/career data is global.

## Security

- Internal API routes are not browser CORS endpoints. Require an independent
  server-to-server secret, compare it timing-safely, rate-limit requests, and
  return only the fields needed by the caller.
- Never return password hashes or trusted-device hashes from internal API
  calls. Password verification and device-token checks execute at the ZA
  authority; raw passwords/tokens travel only over TLS and are not logged.

## Validation

- Account tests cover shared signup, login, trusted devices, duplicate-name
  credential merging, and rejection of unauthenticated internal calls.
- Career tests cover additive merges, duplicate operation IDs, wallet/shop
  consistency, and replaying the US outbox after a temporary ZA outage.
- Integration tests verify the same username has one global career across
  regions, while regional active-player counts and server metrics remain local.
