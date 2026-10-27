// Boom Beard - process bootstrap: config, static files, health, TLS, self-update webhook.
// The WebSocket hub lives in net.js. See docs/ARCHITECTURE.md §7.

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createGzip } from 'node:zlib';
import { attachHub } from './net.js';
import { config, usingTls, ROOT, sameSecret } from './config.js';
import { canonicalTarget } from './canonical.js';
import { createLeaderboard } from './leaderboard.js';
import { createAccounts } from './accounts.js';
import { createAdminAuth } from './admin-auth.js';
import { createAdminData, createMetricHistory } from './admin-data.js';
import { createAdminHttpHandler } from './admin-http.js';
import { createGeography } from './geography.js';
import { createRegionStatusHandler } from './region-status.js';
import geoip from 'geoip-country';
import { startWebTransport } from './webtransport.js';
import { createGuard } from './guard.js';

// The lag shim exists to make development honest, and would silently ruin a real session.
if (config.lag && usingTls) {
  console.error('refusing to start: lag is set while TLS is configured. That combination is a bug.');
  process.exit(1);
}

// ─── static files ─────────────────────────────────────────────────────────────
// Two mounts: public/ at `/`, and shared/ at `/shared` so the browser can import the exact
// simulation modules Node runs.

const MOUNTS = [
  { prefix: '/shared/', dir: path.join(ROOT, 'shared') },
  { prefix: '/', dir: path.join(ROOT, 'public') },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.xml', '.txt']);
const MIN_GZIP_BYTES = 1024;

// The game itself stays self-hosted. The only third-party exception is the Google Ads tag, with
// the host list from Google's CSP guide. Inline script/style remain allowed because there is no
// build step; user strings are assigned with textContent, never injected as HTML.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.googleadservices.com https://www.google.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://pagead2.googlesyndication.com https://www.google.com",
  "media-src 'self'",
  "connect-src 'self' ws: wss: https://boombeard.co.za https://us.boombeard.co.za https://www.googletagmanager.com https://www.googleadservices.com https://googleads.g.doubleclick.net https://pagead2.googlesyndication.com https://www.google.com https://ad.doubleclick.net",
  "frame-src https://www.googletagmanager.com",
  "object-src 'none'",
  "base-uri 'none'",
  // Nobody may frame the game: no clickjacking the host into typing /kick.
  "frame-ancestors 'none'",
].join('; ');

/** `decodeURIComponent` throws on a stray `%`, and a throw in here used to take the process down. */
function decodePath(urlPath) {
  try { return decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
}

function resolveFile(urlPath) {
  const clean = decodePath(urlPath);
  if (clean === null || clean.includes('\0') || clean.includes('\\') || clean.split('/').includes('..')) return null;
  for (const { prefix, dir } of MOUNTS) {
    if (!clean.startsWith(prefix)) continue;
    let rel = clean.slice(prefix.length) || 'index.html';
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(dir, rel);
    // Belt and braces: path.join already collapsed `..`, this proves we stayed inside the mount.
    if (!file.startsWith(dir + path.sep) && file !== dir) return null;
    if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

// ─── self-update webhook ──────────────────────────────────────────────────────
// GitHub Actions cannot SSH in - port 22 is restricted to one IP on purpose, and runners have
// dynamic addresses. So CD is pull-based: Actions proves the tests pass, then pokes this, and
// the box updates itself over its own outbound HTTPS. No inbound SSH, no private key in GitHub.

let lastDeploy = 0;
const DEPLOY_COOLDOWN_MS = 10_000;

function handleDeploy(req, res) {
  // No token configured (any laptop) means the endpoint does not exist at all.
  if (!config.deployToken) return false;

  const ok = sameSecret(req.headers['x-deploy-token'], config.deployToken);
  const who = req.socket.remoteAddress;
  if (req.method !== 'POST' || !ok) {
    // Deliberately a 404, not a 401: an unauthenticated caller learns nothing about the endpoint.
    console.warn(`deploy: rejected from ${who}`);
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
    return true;
  }
  if (Date.now() - lastDeploy < DEPLOY_COOLDOWN_MS) {
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    res.end('too soon');
    return true;
  }
  lastDeploy = Date.now();

  console.log(`deploy: accepted from ${who}, self-update starting`);
  // Detached, because the script restarts this very process. Answer first, then die.
  // The script restarts us by signalling this pid: the unit sets NoNewPrivileges, so it cannot sudo.
  const child = spawn('bash', [config.deployScript], {
    cwd: ROOT, detached: true, stdio: 'ignore',
    env: { ...process.env, BV_SERVER_PID: String(process.pid) },
  });
  // An unhandled 'error' (no bash on this machine) would otherwise be an uncaught exception.
  child.on('error', err => console.warn(`deploy: could not start the update (${err.message})`));
  child.unref();

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, updating: true }));
  return true;
}

// ─── request handling ─────────────────────────────────────────────────────────

const started = Date.now();
const guard = createGuard();
let adminHttp;
let regionStatusHttp;
let geography = null;
let lastProcessSample = { at: process.hrtime.bigint(), usage: process.cpuUsage() };

/**
 * Lightweight process metrics for the in-game diagnostics badge.
 *
 * Each number says exactly what it measures, because a vague one is worse than none:
 *
 *   cpuPct     this process's CPU time since the last sample, over the wall clock since the last
 *              sample, as a percentage of ONE core. Over 100 on a busy multi-core box is real,
 *              not a bug, so it is capped only because the badge is four characters wide.
 *   memoryPct  resident set of this process against the machine's total memory. The game's
 *              share of the box, not the box's own usage.
 *   diskPct    how full the filesystem the app lives on is. `statfsSync` rather than shelling
 *              out to df: no child process on a path that answers every two seconds.
 */
function processMetrics() {
  const at = process.hrtime.bigint();
  const usage = process.cpuUsage();
  const elapsedUs = Number(at - lastProcessSample.at) / 1000;
  const cpuUs = (usage.user - lastProcessSample.usage.user)
    + (usage.system - lastProcessSample.usage.system);
  lastProcessSample = { at, usage };
  let diskPct = null;
  try {
    const fsStat = fs.statfsSync(ROOT);
    const total = fsStat.blocks, free = fsStat.bavail;
    // bavail, not bfree: the space a non-root process can actually have.
    if (total > 0) diskPct = +(((total - free) / total) * 100).toFixed(1);
  } catch { /* not every platform has statfs; the badge simply omits it */ }
  return {
    cpuPct: elapsedUs > 0 ? Math.min(100, +(cpuUs / elapsedUs * 100).toFixed(1)) : 0,
    memoryPct: +((process.memoryUsage().rss / os.totalmem()) * 100).toFixed(1),
    ...(diskPct === null ? null : { diskPct }),
  };
}

/* A throw while answering one request must never become an uncaught exception: that handler
 * exits the process, so a single malformed URL was enough to restart the game for everybody. */
async function handle(req, res) {
  try {
    await serve(req, res);
  } catch (err) {
    console.warn(`request ${req.method} ${String(req.url).slice(0, 200)} failed (${err.message})`);
    if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end();
  }
}

async function serve(req, res) {
  // Flood protection first, before any work is spent on the request. See server/guard.js.
  if (!guard.allowRequest(req.socket.remoteAddress)) {
    res.writeHead(429, { 'Retry-After': '2', 'Content-Type': 'text/plain' });
    return res.end('slow down\n');
  }
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Over TLS only: the browser then refuses plain HTTP to this name for a year, so nobody on the
  // office wifi can be quietly served a downgraded page.
  if (usingTls) res.setHeader('Strict-Transport-Security', 'max-age=31536000');

  const url = req.url.split('?')[0];

  // Before anything else: www, the sslip.io name and the bare IP all bounce to the canonical one.
  const to = canonicalTarget({ host: req.headers.host, url: req.url, want: config.publicHost, tls: usingTls });
  if (to) {
    res.writeHead(301, { Location: to, 'Cache-Control': 'no-store' });
    return res.end();
  }

  if (url === '/deploy' && handleDeploy(req, res)) return;

  if (url === '/admin' || url.startsWith('/admin/')) {
    if (await adminHttp(req, res)) return;
  }
  if (url === '/admin.html') {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }

  /* What build is this?
   *
   * A tiny endpoint rather than a string baked into index.html, because baking it in needs a
   * build step and this project does not have one - the deploy is an rsync of the working tree.
   * One fetch on the menu, and the marker under the title is always the truth.
   *
   * `version` is the semantic one from package.json, bumped and tagged by `npm run tag`.
   * `build` is the sha actually on disk, which is what you want when the answer to "which
   * version" is "the same one, but with your fix in it".
   */
  if (url === '/version') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ version: pkgVersion(), build: version() }));
  }

  if (url === '/signup-count') {
    const count = accounts.stats().total;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    });
    return res.end(JSON.stringify({ count }));
  }

  if (url === '/healthz') {
    const body = JSON.stringify(hub.health({
      uptimeS: Math.round((Date.now() - started) / 1000),
      ...processMetrics(),
      version: version(),
      signups: accounts.stats(),
      transports: { ...hub.transportCounts, webtransport: wt ? hub.transportCounts.webtransport : null },
      top: leaderboard.top(5),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(body);
  }

  if (url === '/region-status' && regionStatusHttp(req, res)) return;

  if (req.method === 'GET' && url === '/') {
    geography?.recordHit(req.socket.remoteAddress);
  }

  const file = resolveFile(req.url);
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('not found');
  }
  const ext = path.extname(file);
  const stat = fs.statSync(file);
  const size = stat.size;
  const compressible = COMPRESSIBLE.has(ext);
  const gzip = compressible
    && size >= MIN_GZIP_BYTES
    && !req.headers.range
    && /(?:^|,)\s*gzip\s*(?:,|$)/i.test(req.headers['accept-encoding'] || '');
  /* Caching, with no build step and no content hashes for code.
   *
   * CODE IS NEVER SERVED STALE. It used to be: everything that was not HTML got five minutes of
   * max-age, so for five minutes after every deploy a browser could be running a MIX of old and
   * new modules - each file cached on its own clock. That is how ice "did not render": a fresh
   * art.js beside a cached constants.js (or the reverse) and the block type the server was sending
   * had no drawing code, so the tile drew as nothing and the sea showed through the hole. On a day
   * with several deploys that is not an edge case.
   *
   * So code - .js, .css, .json, .html - is `no-cache`: always revalidated, never trusted. With an
   * ETag (size and mtime; rsync -a preserves mtimes, so it changes only when the file did) an
   * unchanged file costs a 304 with no body, which on one hostname over one connection is
   * nothing. Content-fingerprinted assets are immutable because a changed file necessarily gets
   * a changed URL. Other images and fonts keep a short max-age plus the ETag; the music, which
   * never changes within a deploy and is megabytes, keeps a day. */
  const etag = `W/"${size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  const code = ext === '.html' || ext === '.js' || ext === '.mjs' || ext === '.css' || ext === '.json';
  const fingerprinted = /\.[0-9a-f]{8}\.[^.]+$/i.test(path.basename(file));
  const head = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': fingerprinted ? 'public, max-age=31536000, immutable'
      : code ? 'no-cache'
      : ext === '.mp3' ? 'public, max-age=86400'
      : 'public, max-age=300',
    'Accept-Ranges': 'bytes',
    ETag: etag,
    ...(compressible ? { Vary: 'Accept-Encoding' } : null),
    ...(gzip ? { 'Content-Encoding': 'gzip' } : null),
  };
  if (!req.headers.range && req.headers['if-none-match'] === etag) {
    res.writeHead(304, {
      'Cache-Control': head['Cache-Control'],
      ETag: etag,
      ...(head.Vary ? { Vary: head.Vary } : null),
      ...(head['Content-Encoding'] ? { 'Content-Encoding': head['Content-Encoding'] } : null),
    });
    return res.end();
  }

  /* Byte ranges.
   *
   * Only media ever asks for one, but it is not optional for media: Safari will not play an
   * <audio> source AT ALL from a server that answers a Range request with a 200 and the whole
   * file. It issues `bytes=0-1`, expects a 206, and gives up on the element when it does not get
   * one. Chrome is forgiving, which is exactly how this ships broken for half the office. */
  const asked = /^bytes=(\d*)-(\d*)$/.exec((req.headers.range || '').trim());
  if (asked && size > 0) {
    const [, rawStart, rawEnd] = asked;
    let start, end;
    if (rawStart === '') {
      // A suffix range: the LAST n bytes. `bytes=-500` is not "from 0 to 500".
      const n = Number(rawEnd);
      if (!rawEnd || !Number.isFinite(n)) return range416(res, size);
      start = Math.max(0, size - n);
      end = size - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      return range416(res, size);
    }
    res.writeHead(206, {
      ...head,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }

  if (gzip) {
    res.writeHead(200, head);
    return fs.createReadStream(file).pipe(createGzip()).pipe(res);
  }

  res.writeHead(200, { ...head, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}

function range416(res, size) {
  res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Type': 'text/plain' });
  res.end('range not satisfiable');
}

/**
 * The semantic version, taken from the release tag the running code was built from.
 *
 * The tag is the truth, not package.json: package.json goes stale the moment anyone tags without
 * `npm version`, and it did - it said 1.0.0 while v1.0.2 was live. `.version` is stamped from
 * `git describe --tags` on every deploy (infra/deploy.sh and infra/self-update.sh), so the
 * leading `v1.0.2` of `v1.0.2-1-g0aa8364` is the release actually on disk. package.json is the
 * fallback for a plain `node server/index.js` in a tree nobody has deployed.
 */
let cachedPkg;
function pkgVersion() {
  if (cachedPkg !== undefined) return cachedPkg;
  cachedPkg = /^v?(\d+\.\d+\.\d+)/.exec(version() || '')?.[1] || null;
  if (cachedPkg) return cachedPkg;
  try {
    cachedPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || null;
  } catch { cachedPkg = null; }
  return cachedPkg;
}

/**
 * What is actually running, for /healthz.
 *
 * `.version` is written by infra/deploy.sh and wins, because a manual deploy rsyncs the working
 * tree without touching `.git` - reading the git sha alone would report the last *pulled*
 * commit, not the code on disk. Falls back to .git/HEAD for a self-update, and to null locally.
 */
let cachedVersion;
function version() {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    cachedVersion = fs.readFileSync(path.join(ROOT, '.version'), 'utf8').trim() || null;
    return cachedVersion;
  } catch { /* not a manual deploy; try git */ }
  try {
    const head = fs.readFileSync(path.join(ROOT, '.git/HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    const sha = ref ? fs.readFileSync(path.join(ROOT, '.git', ref), 'utf8').trim() : head;
    cachedVersion = sha.slice(0, 7);
  } catch { cachedVersion = null; }
  return cachedVersion;
}

// ─── server ───────────────────────────────────────────────────────────────────

const server = usingTls
  ? https.createServer(
      { cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, handle)
  : http.createServer(handle);
hardenTimeouts(server);

/* Node's defaults wait a minute for headers and five for a body, so a few hundred connections
 * that send one header byte every few seconds tie the box up without ever tripping the request
 * guard. Every request here is a GET or an empty POST: ten seconds is generous. Upgraded
 * WebSockets leave the HTTP server's books and are unaffected. */
function hardenTimeouts(s) {
  s.headersTimeout = 10_000;
  s.requestTimeout = 15_000;
  s.maxHeadersCount = 64;
  return s;
}

const leaderboard = createLeaderboard({ dataDir: config.dataDir });
// Passwords and trusted browsers. Beside the leaderboard because it protects the leaderboard:
// the career is keyed by name, so the name is what needs an owner. See server/accounts.js.
const accounts = createAccounts({ dataDir: config.dataDir });
geography = createGeography({
  dataDir: config.dataDir,
  lookupCountry: ip => geoip.lookup(ip)?.country ?? null,
});
const adminAuth = createAdminAuth({
  accounts: config.requirePassword ? accounts : null,
  adminName: 'cobusvw',
  adminKey: config.adminKey,
  password: config.adminDashboardPassword,
});
const adminMetrics = createMetricHistory(processMetrics);
const adminData = createAdminData({
  accounts, leaderboard, metrics: adminMetrics, geography,
});
adminHttp = createAdminHttpHandler({
  auth: adminAuth,
  data: adminData,
  pageFile: path.join(ROOT, 'public/admin.html'),
  usingTls,
});
// `requirePassword: false` hands the hub no store at all rather than a store it is asked to
// ignore - one branch instead of two, and no way for a future edit to half-enable it.
const hub = attachHub(server, {
  ...config, leaderboard, guard,
  geography,
  accounts: config.requirePassword ? accounts : null,
});
regionStatusHttp = createRegionStatusHandler({
  regionId: config.regionId,
  getStats: () => hub.health(),
});

/**
 * WebTransport on UDP/443, beside the WebSocket on TCP/443.
 *
 * Only with real TLS: WebTransport demands a publicly trusted certificate unless the client pins
 * a hash, and there is no sane way to hand a pinned hash to sixteen colleagues. Locally that
 * means WebSocket only, which is the correct local setup anyway.
 *
 * Failure here is never fatal. A missing native binary, a taken port, a kernel that will not give
 * us UDP - all of them end as "WebSocket only", which is the configuration a good share of
 * players behind a corporate firewall will be in no matter what we do.
 */
let wt = null;
if (usingTls) {
  startWebTransport({
    port: config.port,
    cert: fs.readFileSync(config.tlsCert, 'utf8'),
    privKey: fs.readFileSync(config.tlsKey, 'utf8'),
    onSocket: (ws, ip) => hub.attachSocket(ws, ip),
  }).then(h => { wt = h; }).catch(err => console.warn(`webtransport: ${err.message}`));
}

server.listen(config.port, () => {
  console.log(`boom-beard listening on ${usingTls ? 'https' : 'http'}://${config.publicHost}:${config.port}`);
  console.log(`config: ${config.iniPath || 'defaults + environment only'}`);
  if (config.lag) console.log(`LAG SHIM ACTIVE: ${config.lag}ms +/-${config.jitter}ms`);
  if (config.deployToken) console.log('self-update webhook enabled at POST /deploy');
});

// Plain HTTP exists only to bounce people to HTTPS and to answer ACME challenges.
if (usingTls && config.redirectPort) {
  hardenTimeouts(http.createServer((req, res) => {
    if (!guard.allowRequest(req.socket.remoteAddress)) {
      res.writeHead(429, { 'Retry-After': '2' });
      return res.end();
    }
    res.writeHead(301, { Location: `https://${config.publicHost}${req.url}` });
    res.end();
  })).listen(config.redirectPort);
}

/* A crash is the shutdown nobody planned, and it used to save nothing: everything earned since
 * the last round boundary was simply gone. Bank and write synchronously - there is no event loop
 * worth trusting at this point - then exit non-zero so systemd restarts us. */
process.on('uncaughtException', err => {
  console.error('uncaught exception - saving the leaderboard before exiting', err);
  try { hub.bankScores(); } catch (e) { console.error(`bank on crash failed (${e.message})`); }
  leaderboard.flushSync();
  geography?.flushSync();
  // A password set seconds before a crash must not be lost: the person would be locked out of
  // their own name, with no way back except editing the file by hand.
  accounts.flushSync();
  process.exit(1);
});
process.on('unhandledRejection', err => {
  console.error('unhandled rejection', err);
});

/* Shutting down has to finish writing before it exits.
 *
 * Two bugs lived here. The scores of everyone still playing were only ever written at a round
 * boundary, so a deploy in the middle of a ten-minute round discarded it - and on a build day
 * that is most deploys. And `leaderboard.stop()` returns a promise that nothing awaited, while
 * `server.close` could call `process.exit` first, so even the writes that were queued could be
 * cut off halfway.
 *
 * Now: bank the round, await the save, then exit. The three-second backstop stays, because a
 * shutdown that hangs is worse than one that loses a few points.
 */
let shuttingDown = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${sig} - shutting down`);
    setTimeout(() => process.exit(0), 3000).unref();
    try {
      hub.bankScores();
      // Synchronously, so the backstop timer above can never cut a save off halfway.
      await leaderboard.stop();
      if (leaderboard.flushSync()) console.log('leaderboard saved');
      geography?.stop();
      accounts.flushSync();
    } catch (err) {
      console.warn(`leaderboard: save on shutdown failed (${err.message})`);
    }
    adminMetrics.stop();
    hub.shutdown();
    wt?.stop();
    server.close(() => process.exit(0));
  });
}
