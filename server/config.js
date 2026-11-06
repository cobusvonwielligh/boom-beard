// Boom Beard - configuration.
//
// Precedence: environment variable > config.ini > built-in default.
// Env wins so CI and one-off runs (`LAG=200 npm start`) never need to touch a file.
//
// config.ini is gitignored and holds anything secret or machine-specific. config.example.ini
// is the committed template. On the server the real file lives at /opt/boom-beard/config.ini
// and is excluded from rsync, so a deploy never overwrites it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTO_BOTS_MIN } from '../shared/constants.js';
import { parseWindow } from './nightly-restart.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal INI: [section], key = value, # or ; comments. No nesting, no arrays, no quotes. */
export function parseIni(text) {
  const out = {};
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#') || s.startsWith(';')) continue;
    const head = s.match(/^\[(.+?)\]$/);
    if (head) { section = head[1].trim().toLowerCase(); out[section] ??= {}; continue; }
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim().toLowerCase();
    const value = s.slice(eq + 1).trim();
    (out[section] ??= {})[key] = value;
  }
  return out;
}

const iniPath = process.env.CONFIG || path.join(ROOT, 'config.ini');
const ini = fs.existsSync(iniPath) ? parseIni(fs.readFileSync(iniPath, 'utf8')) : {};

const pick = (env, section, key, fallback) =>
  process.env[env] ?? ini[section]?.[key] ?? fallback;

const num = (...a) => Number(pick(...a));
const regionId = String(pick('REGION_ID', 'server', 'region_id', 'za')).toLowerCase();
if (regionId !== 'za' && regionId !== 'us') {
  throw new RangeError(`invalid region id: ${regionId}`);
}
const defaultMinBots = regionId === 'us' ? 4 : AUTO_BOTS_MIN;

export const config = {
  iniPath: fs.existsSync(iniPath) ? iniPath : null,

  regionId,
  port: num('PORT', 'server', 'port', 8080),
  redirectPort: num('REDIRECT_PORT', 'server', 'redirect_port', 80),
  publicHost: pick('PUBLIC_HOST', 'server', 'public_host', 'localhost'),
  tlsCert: pick('TLS_CERT', 'server', 'tls_cert', ''),
  tlsKey: pick('TLS_KEY', 'server', 'tls_key', ''),
  dataDir: path.resolve(ROOT, pick('DATA_DIR', 'server', 'data_dir', './data')),
  maxPlayers: num('MAX_PLAYERS', 'server', 'max_players', 16),
  // Target bot count. The US room also retains its complement while idle. 0 disables bots.
  minBots: num('MIN_BOTS', 'server', 'min_bots', defaultMinBots),

  /* Restart the server overnight while nobody is playing. `23-2`, or blank to disable.
   *
   * The server's OWN LOCAL TIME, so the Johannesburg and US boxes each restart in their own
   * night rather than one of them bouncing mid-afternoon. Blank by default, which is the correct
   * setting for a laptop - the same reasoning as `deploy.token`. See server/nightly-restart.js.
   */
  nightlyRestart: parseWindow(pick('NIGHTLY_RESTART', 'server', 'nightly_restart', '')),

  // Shared secret for POST /deploy. Empty disables the endpoint entirely.
  deployToken: pick('DEPLOY_TOKEN', 'deploy', 'token', ''),
  // Overridable so tests can exercise the accept path without actually redeploying anything.
  deployScript: pick('DEPLOY_SCRIPT', 'deploy', 'script', path.join(ROOT, 'infra/self-update.sh')),

  lag: num('LAG', 'dev', 'lag', 0),
  jitter: num('JITTER', 'dev', 'jitter', 0),

  // Who is always host. With a key set, it is whoever's browser presents the key - opened once
  // as /?admin=KEY, then remembered. Without one it falls back to the name, which is fine on a
  // laptop and nowhere else: names are not secret, and this one is in a public repository.
  adminKey: pick('ADMIN_KEY', 'admin', 'key', ''),
  adminName: String(pick('ADMIN_NAME', 'admin', 'name', 'cobusvw')).toLowerCase(),
  // Second factor for the private /admin dashboard. Blank keeps the dashboard disabled.
  adminDashboardPassword: pick('ADMIN_DASHBOARD_PASSWORD', 'admin', 'dashboard_password', ''),

  /* Do names need a password? On by default, and the default is the one that matters: the
   * leaderboard is keyed by name (see careerKey), so without this anybody can type your name and
   * inherit your career. See server/accounts.js.
   *
   * It is a switch because there is a real configuration where it is wrong: a LAN party, a demo,
   * a kiosk - anywhere the room is the access control and asking sixteen people to invent
   * passwords is friction for nothing. `REQUIRE_PASSWORD=0` turns the whole thing off and the
   * handshake is exactly what it was before passwords existed, which is also how the tests that
   * are about ROOMS rather than about sign-in keep being about rooms.
   */
  requirePassword: String(pick('REQUIRE_PASSWORD', 'server', 'require_password', '1')) !== '0',
  sharedDataToken: pick('SHARED_DATA_TOKEN', 'shared', 'token', ''),
  sharedDataHost: pick('SHARED_DATA_HOST', 'shared', 'host', ''),
  sharedDataServername: pick('SHARED_DATA_SERVERNAME', 'shared', 'servername', 'boombeard.co.za'),

  /* Seconds of frozen count-in at the top of every round. 0 starts the round live.
   *
   * A knob because it is a rule the room enforces rather than an animation: a test that drives
   * inputs from tick 0 sets COUNT_IN=0 and gets the old behaviour, and anybody running a private
   * server who finds five seconds of standing still annoying can have none.
   */
  countIn: Math.max(0, num('COUNT_IN', 'server', 'count_in', 5)),

  /* Seconds a joining or rejoining player is held off the board before being placed. See
   * ARRIVE_DELAY_TICKS. A knob for the same reason as the count-in: a test that drives inputs the
   * moment it joins sets ARRIVE_IN=0. */
  arriveIn: Math.max(0, num('ARRIVE_IN', 'server', 'arrive_in', 3)),
};

export const usingTls = Boolean(config.tlsCert && config.tlsKey);

/** Constant-time comparison of a presented secret against the configured one. Blank never matches. */
export function sameSecret(given, want) {
  if (!want || typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(String(want));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
