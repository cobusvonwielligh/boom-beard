# Boom Beard - Deployment

`boombeard.co.za` is the only public website and admin origin. It serves the landing
page, game assets, and `/admin` from the South Africa instance (`af-south-1`,
`region_id=za`). The US instance (`us-east-1`, EIP `52.21.210.27`,
`region_id=us`) is a game backend only: players choose a game region in a dialog
on the ZA page, then connect directly to the selected game server. The US instance
has no hostname and does not serve its own landing page or admin dashboard.

Both instances run the same `main` commit. ZA is the authority for player accounts,
lifetime career stats, wallet, and shop progress; US forwards account operations and
career mutations to ZA over an authenticated internal HTTPS API. Live rooms, bots,
occupancy, geography, and machine metrics remain regional. `/admin` is served only
by ZA and combines the global player career with ZA-local operational metrics.

---

## 1. The shape

```
                      ┌───────────────────────────────┐
 browser ──HTTPS──►   │ boombeard.co.za · ZA         │
                      │ landing page + /admin        │
                      │ shared player-data authority │
                      └───────┬───────────────┬───────┘
                              │ status probes │ game
                              │               └──────► WSS/WT to selected region
                              │
                    ┌─────────▼────────┐       ┌───────────────────┐
                    │ EC2 · af-south-1 │       │ EC2 · us-east-1   │
                    │ site + game      │       │ game only         │
                    │ shared authority │       │ game + outbox     │
                    │                  │       │ 52.21.210.27      │
                    └──────────────────┘       └───────────────────┘
```

Each region is one Node process under systemd, with HTTPS/WSS on TCP 443 and the HTTP
redirect on TCP 80. The US instance uses a browser-trusted IP-address certificate;
no US DNS record is required. The ZA page probes each region's credential-free
`/region-status` endpoint, then opens the game transport directly to the selected
origin. The US server redirects website and admin requests to ZA. There is no load
balancer, CDN, or central database.

**No Docker.** Each region is one Node process and one systemd service. systemd restarts it
on crash and survives reboots; `npm run deploy` is an rsync instead of an image build. If
this moves to ECS Fargate, add a container definition then.

**No load balancer or regional hostname.** The player selects a region after pressing
Play and connects directly to the selected game origin. Only the ZA host renders the
website and dashboard.

---

## 2. Why this survives corporate IT

Each row is a thing that commonly gets a game blocked, and the choice that avoids it:

| Common blocker | What we do |
|---|---|
| Non-standard ports | **All game traffic on 443.** Port 80 is open only for the HTTPS redirect and certificate renewal. |
| Plain `ws://` on 80 | **`wss://` on 443.** TLS-wrapped, so proxies pass it as ordinary HTTPS. |
| Regional hostnames | **One website hostname.** ZA serves `boombeard.co.za`; the US game transport uses its fixed Elastic IP with an IP certificate. |
| Web fonts, analytics | None. Zero external requests. |
| UDP | WebRTC is not used. WebTransport optionally uses UDP/443; if blocked, the game falls back to WebSocket over TCP/443. |
| Category filters ("games") | Keep the website on its existing domain; the US game connection uses its fixed IP. |

**Ticket text for IT, paste as-is:**

> Please allow outbound HTTPS (TCP 443) to `boombeard.co.za` and `52.21.210.27` for
> the dev team. It is an internally hosted tool on infrastructure we control. The
> website uses `boombeard.co.za`; the selected US game connection uses secure
> WebSockets over TCP/443 to the US Elastic IP. UDP/443 is optional for WebTransport;
> blocking UDP still leaves the WebSocket game available.

---

## 3. US game server without a hostname

The US game server is addressed directly at `52.21.210.27`. Let's Encrypt supports
IP-address certificates with the `shortlived` profile; these certificates are valid
for six days. Certbot must run daily to renew them, so the bootstrap installs a daily
systemd timer. No DNS record or regional hostname is needed.

---

## 4. First-time setup

### On AWS (console)

1. **Instance** - `t3.micro`, Amazon Linux 2023, 16–20 GB gp3. ZA is in `af-south-1`;
   the game-only US instance is in `us-east-1`.
2. **Elastic IP** - allocate, associate to the instance. (Since Feb 2024 every public IPv4 costs
   $0.005/h; Free Tier covers 750 h/month for 12 months, so one is free for a year.)
3. **Security group** - three required inbound rules on each instance, plus optional UDP
   for WebTransport:

   | Port | Source | Purpose |
   |---|---|---|
   | 443 | `0.0.0.0/0` | HTTPS, status, and game transport |
   | 80 | `0.0.0.0/0` | HTTPS redirect + ACME renewal |
   | 22 | your IP | SSH |

   Optionally allow UDP/443 from `0.0.0.0/0` for WebTransport. TCP/443 WebSocket
   fallback remains available without it. Specifically **not** 8080 - that is local dev only.

### On the box (once, ~3 minutes)

```bash
scp -i ~/Downloads/bombs-away.pem infra/bootstrap.sh ec2-user@15.240.88.189:
ssh -i ~/Downloads/bombs-away.pem ec2-user@15.240.88.189 \
  'HOST=15.240.88.189.sslip.io EMAIL=you@example.com bash bootstrap.sh'
```

`bootstrap.sh` is idempotent - re-run it any time. It installs Node, creates
`/opt/boom-beard` and `/var/lib/boom-beard`, issues the certificate, installs a deploy hook
that copies the cert somewhere the unprivileged service can read it, and arms a daily renewal
timer. Set `REGION_ID=za` on the South Africa instance. On the US game instance, use
`HOST=52.21.210.27 REGION_ID=us`; bootstrap requests the six-day IP certificate.
ZA bootstrap creates `/var/lib/boom-beard/shared-data-token` with owner-only permissions.
Transfer that file securely to `/tmp/boom-beard-shared-token` on US before running US
bootstrap; the script consumes it without displaying the secret.

### From your laptop, every deploy after that

```bash
HOST=15.240.88.189.sslip.io npm run deploy
```

Runs the tests, rsyncs, `npm ci --omit=dev`, restarts the service, and polls `/healthz` until it
answers. On failure it prints the last 40 journal lines. Takes a few seconds; do it between
rounds.

---

## 5. Configuration - `config.ini`

All settings and secrets live in **`config.ini`**, which is gitignored and never rsynced, so a
deploy can never clobber it and a secret can never reach GitHub. `config.example.ini` is the
committed template. On the server the real file is `/opt/boom-beard/config.ini`, written by
`bootstrap.sh`.

Precedence is **environment variable > `config.ini` > built-in default**, so a one-off like
`LAG=200 npm start` never needs a file edit, and CI can override anything.

| Section | Key | Env | Default | Meaning |
|---|---|---|---|---|
| `server` | `port` | `PORT` | `8080` | `443` in production. |
| | `redirect_port` | `REDIRECT_PORT` | `80` | Plain-HTTP redirect. Only used when TLS is on. |
| | `public_host` | `PUBLIC_HOST` | `localhost` | Redirect targets and logging. |
| | `region_id` | `REGION_ID` | `za` | `za` or `us`; identifies this server in `/region-status`. |
| | `tls_cert` / `tls_key` | `TLS_CERT` / `TLS_KEY` | blank | Blank → plain HTTP, which is local dev. |
| | `data_dir` | `DATA_DIR` | `./data` | Leaderboard and certificate copies. |
| | `max_players` | `MAX_PLAYERS` | `16` | |
| | `min_bots` | `MIN_BOTS` | `6` | Bots kept topped up while anyone plays; 0 turns it off |
| `deploy` | `token` | `DEPLOY_TOKEN` | blank | Secret for `POST /deploy`. **Blank disables the endpoint entirely** - correct on a laptop. |
| | `ssh_host` / `ssh_user` / `ssh_key` | same | - | Used by `infra/deploy.sh`. |
| `admin` | `key` | `ADMIN_KEY` | blank | Whoever's browser presents it is always host. Open `https://<host>/?admin=<key>` once; the browser keeps it and the address bar drops it. `bootstrap.sh` generates one. |
| | `name` | `ADMIN_NAME` | `cobusvw` | Only used when `key` is blank, which is right on a laptop and wrong anywhere else: names are not secret. |
| | `dashboard_password` | `ADMIN_DASHBOARD_PASSWORD` | blank | Second factor for `/admin`; blank disables the dashboard. Set the secret only in the server environment or ignored `config.ini`, never in the repository. |
| `dev` | `lag` / `jitter` | `LAG` / `JITTER` | `0` | Outbound delay in ms. The process **refuses to start** if either is non-zero while TLS is configured. |
| `shared` | `token` | `SHARED_DATA_TOKEN` | blank | One server-only secret shared by ZA and US. Required on US; ZA serves the internal API only when set. Never put it in browser config or source control. |
| | `host` | `SHARED_DATA_HOST` | blank | US-only ZA Elastic IP, `15.240.88.189`; connects by IP to avoid depending on apex DNS. |
| | `servername` | `SHARED_DATA_SERVERNAME` | `boombeard.co.za` | TLS name for certificate verification and the internal HTTP Host header. |

`https://boombeard.co.za/admin` is served by ZA. Its live occupancy and machine metrics
are ZA-local; the leaderboard and player account totals are global. Requests to
`/admin` on the US IP redirect to this ZA dashboard; the US instance is game-only.
The dashboard requires `ADMIN_KEY`, `ADMIN_DASHBOARD_PASSWORD`, and
`REQUIRE_PASSWORD=1`. Open the ZA bootstrap-provided `/?admin=<key>` link once in the
trusted `cobusvw` browser, then use `/admin` and the dashboard passphrase. The second
factor is never shipped to the browser or stored in git; it is accepted only over TLS.
`bootstrap.sh` preserves an existing dashboard password and accepts a new one through the
`ADMIN_DASHBOARD_PASSWORD` environment variable.
The dashboard currently requires TLS to terminate directly in the app. It is not supported with
`SKIP_TLS=1` behind a TLS-terminating load balancer.

## US game server setup

1. Keep the existing Elastic IP `52.21.210.27`; no DNS record or regional hostname is used.
2. Allow inbound TCP 443 for the game/status endpoint, TCP 80 for redirect and ACME
   certificate renewal, and TCP 22 only from the administrator's current IP. Optionally
   allow UDP/443 for WebTransport; WebSocket over TCP/443 remains available without it.
3. Secure `~/Downloads/bombs-away-na.pem` with mode `600`, then run
   `infra/bootstrap.sh` with `HOST=52.21.210.27 REGION_ID=us`. `EMAIL` is optional;
   without it, Certbot sends no expiry notices, so monitor the daily renewal timer.
   The IP certificate uses the `shortlived` profile and renews daily.
4. Keep `/var/lib/boom-beard` on each instance. US keeps a local durable career outbox
   and cached global read model; it does not become an account authority. Deploy the same
   `main` commit to both instances, using `SSH_HOST=52.21.210.27`,
   `SSH_USER=ec2-user`, and the US key for the US manual deployment.
5. Set the exact same `SHARED_DATA_TOKEN` on both instances. US must use
   `SHARED_DATA_HOST=15.240.88.189` and `SHARED_DATA_SERVERNAME=boombeard.co.za`.
   Transfer the secret from ZA to US through a secure channel; never print it into a
   terminal transcript or commit it.
6. After deploying the shared-data code, run `node infra/merge-region-data.js` once on
   US. It creates mode-0600 backups of both existing US data files before importing
   accounts and human careers into ZA. Re-running the same migration ID is safe.
7. Verify `/healthz` and `/region-status` on each instance. The US `/` and `/admin`
   routes redirect to the ZA website; game clients load all page assets from ZA.

The browser probes each public `/region-status` endpoint. It returns only that
instance's region ID, connected human count, bot count, and seat limit; it does not
expose `/healthz`, player names, scores, registrations, or geography.

The admin geography panel counts home-page views and new registrations by country. It performs
GeoLite2 country lookups locally, persists only daily ISO country totals in
`<data_dir>/geography.json` for up to 365 days, and never saves the source IP. The map is
approximate and must not be used to identify an individual. GeoLite2 data is licensed by MaxMind;
the dashboard displays the required attribution. Refresh the pinned `geoip-country` package
at least monthly to keep its bundled country database current. Past traffic cannot be backfilled.

## Shared account and career data

ZA stores the authoritative `accounts.json` and `leaderboard.json`. US authentication
requests use `POST /internal/shared-data` over HTTPS to the ZA Elastic IP, with TLS
certificate verification pinned to `boombeard.co.za`. This route is not a browser/CORS
endpoint and never returns password hashes or trusted-device hashes. The HTTP guard
rate-limits it like other server requests.

US career writes are first persisted in `shared-outbox.json` with owner-only permissions.
The US server retries them until ZA acknowledges the operation ID; replay cannot apply
the same score, medal, purchase, or shop consumption twice. `shared-leaderboard.json`
is a cached global read model. If ZA is unavailable, queued score changes remain durable;
account operations and purchases that need ZA authority fail explicitly.

The one-time import runs only after the same code is deployed to both regions:

```bash
# On US, after config.ini contains the shared secret and ZA HTTPS settings:
cd /opt/boom-beard
node infra/merge-region-data.js
```

The script backs up US account/career files as `.pre-shared-<timestamp>` before import.
It preserves both regions' hashed password credentials and trusted-device records,
adds human career values, and keeps bot careers local. Do not copy the full ZA data
directory over the US data directory. Keep the apex A record pointed only at ZA
(`15.240.88.189`); the US EIP remains game-only and has no DNS hostname.

Local development needs no file at all: `npm start` → `http://localhost:8080`.

The application does not call AWS APIs. Each region keeps its own `/var/lib/boom-beard`
files, while ZA remains the shared-data authority. A VPC move must preserve the authenticated
ZA API, the US outbox, and the US cache; it is a planned shared-data migration, not merely
a storage-path change.

---

## 6. CI/CD

```
push to main ─► GitHub Actions ─► npm ci && npm test
                                      │ pass
                                      ▼
                            POST https://host/deploy
                            X-Deploy-Token: <secret>
                                      │ 202
                                      ▼
                     server runs infra/self-update.sh:
                     git reset --hard origin/main
                     npm ci --omit=dev
                     SIGTERM to the server → systemd restarts it
                                      │
                      Actions polls /healthz until
                      "version" equals the pushed sha
```

**Deployment is pull-based, and that is the point.** Port 22 is locked to one IP, and GitHub
runners have dynamic addresses. The alternatives were opening SSH to the world or chasing
GitHub's IP ranges; instead the box updates *itself* over its own outbound HTTPS. GitHub never
holds an SSH key.

The endpoint is deliberately unhelpful to strangers:

- Missing, wrong, or wrong-length token → **404**, not 401. An unauthenticated caller learns
  nothing about whether the endpoint exists.
- Comparison is `crypto.timingSafeEqual` on equal-length buffers.
- 10-second cooldown, so a stuck workflow cannot restart the box in a loop.
- No token configured → the route does not exist at all. That is the default everywhere except
  the server.
- The script cannot sudo: the unit sets `NoNewPrivileges`. It restarts the server by sending it
  SIGTERM (which banks the round) and letting `Restart=always` bring the new code up. A changed
  unit file is therefore only installed by `npm run deploy`, which comes in over SSH.

### Secrets to set once

GitHub → Settings → Secrets and variables → Actions → New repository secret:

| Secret | Value |
|---|---|
| `DEPLOY_URL` | `https://<host>/deploy` |
| `DEPLOY_TOKEN` | printed at the end of `bootstrap.sh`, and stored in `config.ini` under `[deploy] token` |

Until they are set the deploy job logs a skip and goes green - tests still gate every push.

### Deploying from a laptop

`npm run deploy` rsyncs your working tree, including uncommitted work. It is the fast path for
iterating. A later CI deploy overwrites whatever it pushed, which is correct: git is the source
of truth.

---

## 7. One website, two game regions

The website and dashboard remain on `boombeard.co.za`. The US game server has no
regional hostname:

1. Keep EIP `52.21.210.27` associated with the US instance. Do not create a DNS record.
2. Confirm its security group allows inbound TCP 443 and TCP 80 from `0.0.0.0/0`, and
   SSH/TCP 22 only from the administrator's IP. Optionally allow UDP/443 for WebTransport.
3. After ZA bootstrap, securely transfer `/var/lib/boom-beard/shared-data-token`
   to `/tmp/boom-beard-shared-token` on US without printing it. Secure
   `~/Downloads/bombs-away-na.pem` with `chmod 600`. Run bootstrap using
   `HOST=52.21.210.27 REGION_ID=us`; bootstrap reads the transferred token, writes it
   to the ignored config and owner-only data file, then removes the temporary copy.
   `EMAIL` is optional; without it, Certbot sends no expiry notices, so monitor the daily
   renewal timer. This requests an IP-address certificate with the six-day `shortlived`
   profile and daily renewal.
4. Deploy the same verified `main` commit to both instances. For manual US deployment,
   set `SSH_HOST=52.21.210.27`, `SSH_USER=ec2-user`, and
   `KEY=~/Downloads/bombs-away-na.pem`.
5. Verify `/version`, `/healthz`, and `/region-status` on each instance. US root and
   `/admin` requests must redirect to `https://boombeard.co.za`; US WebSocket and
   WebTransport connections remain direct to the EIP.

---

## 8. Moving into the eezi VPC later

| Thing | Personal AWS account today | eezi VPC later |
|---|---|---|
| Compute | Two EC2 instances + systemd | Same two regions in private subnets - or ECS with a six-line Dockerfile per service |
| TLS | Let's Encrypt on each app | ACM on an ALB for game traffic; `/admin` needs trusted-proxy support before using TLS termination there |
| Public endpoint | `boombeard.co.za` + US EIP `52.21.210.27` | One website hostname and a game-only IP endpoint |
| Access | Public internet | VPC + VPN or an internal ALB - **then IT does not need to unblock anything at all** |
| Data | Separate `/var/lib/boom-beard/` per region; ZA owns shared accounts/careers | Separate region mounts or prefixes; preserve the ZA API and US outbox |
| Config | `/etc/boom-beard.env` | Task definition env or SSM Parameter Store |

Three properties make the networking and storage paths explicit:

1. Each region uses its own `DATA_DIR`; the ZA instance remains the shared-data authority.
2. The app's ZA/US IDs are application config; it **never calls an AWS API**.
3. The US internal client targets the ZA fixed IP while verifying the ZA TLS hostname.
   Preserve this private server-to-server path and its token when moving VPCs.

The networking move still needs a planned migration for shared account/career data;
do not replace the authority or delete either outbox/cache as part of a VPC cutover.

---

## 9. Operations

**Logs.** `sudo journalctl -u boom-beard -f`, or `--since 1h` to debug a Friday session.
systemd rotates them. No log shipping.

**Health.** `https://<host>/healthz` → `{ ok, players, maxPlayers, lag, uptimeS }`. Check it by
eye before a session; that is the whole monitoring story.

**Restart / reboot.** `Restart=always` plus `systemctl enable`, so a crash recovers in two
seconds and a reboot comes back unattended. On SIGTERM the server closes sockets cleanly.

**Backup.** Back up `accounts.json`, `leaderboard.json`, `shared-outbox.json`, and
`shared-leaderboard.json` from both regions. ZA is authoritative for accounts and global
career state. Keep US outbox files until every queued operation is acknowledged.

**Certificates.** Renewed daily by `certbot-renew.timer`. The US IP certificate is valid for
six days; the deploy hook copies the renewed pair into `/var/lib/boom-beard/certs` and
restarts the service. Check with `systemctl list-timers certbot-renew`.

---

## 10. Cost

| Item | Regional deployment |
|---|---|
| EC2 | Two `t3.micro` instances; price varies by region and account credits |
| Public IPv4 | Two Elastic IPs; billed per address under current AWS pricing |
| Egress | Combined game traffic; estimate from both regions' usage |
| TLS | $0 (Let's Encrypt on each instance) |
| Public website | Existing `boombeard.co.za`; US game endpoint uses its Elastic IP |

The Free Tier allowance is shared across the account and may not cover two
always-on instances; check the AWS billing dashboard before launch.

---

## 11. Troubleshooting

| Symptom | Cause, in order of likelihood |
|---|---|
| **CI deploy returns 404** | Wrong `DEPLOY_TOKEN`, or `config.ini` on the server has no `[deploy] token`. The endpoint answers 404 to anything it does not like, on purpose. |
| **CI deploy returns 429** | Two deploys within 10 s. The workflow `concurrency` group should prevent it; check for a manual `curl`. |
| **Deploy accepted but version never changes** | `sudo journalctl -u boom-beard` plus `/var/lib/boom-beard/self-update.log`. Usually the deploy key cannot fetch - re-run `bootstrap.sh`. |
| **Nobody has host commands, including you** | Your browser has no admin key yet, or an old one. Open `https://<host>/?admin=<key>` once; the key is `[admin] key` in the server's `config.ini`. |
| **Server came up on 8080 without TLS** | `config.ini` is missing or has blank `tls_cert`. The service reads only that file now; `/etc/boom-beard.env` is no longer used. |
| **No music in the browser** | Autoplay is blocked until a gesture. The page arms a one-shot click/keypress listener; if it still fails, check the console for an AudioContext error. |
| **All ports time out** (22, 80, 443) | Security group does not have the rule, *or* the Elastic IP is not associated with a running instance. A timeout means the packet was dropped; a *refused* would mean it arrived and nothing was listening. |
| Port 22 times out, 443 works | SSH rule source is a different IP than yours now. EC2 → Security Groups → Edit inbound → set **My IP** again. Do not reopen 22 to `0.0.0.0/0`. |
| `certbot` fails with a connection error | Port 80 not open, or DNS not yet pointing at the box. `dig +short <host>` must return the Elastic IP. |
| Service dies on start | `journalctl -u boom-beard -n 50`. Usually a cert path or a port permission - check `AmbientCapabilities` survived in the unit file. |
| Page loads, WebSocket does not | Mixed content (page on https, socket on ws). The client derives the scheme from `location.protocol`; if you hardcoded one, that is the bug. |

---

## 12. Security

What stands between the internet and the box, checked end to end on 2026-10-25 for v1.0.3+.

| Layer | What it does |
|---|---|
| **Security group** | 443 and 80 to the world, 22 to one address. sshd logged no attempt from anywhere else in the three days checked. |
| **sshd** | Keys only, no root login, no X11, three tries per connection - `/etc/ssh/sshd_config.d/00-boom-beard.conf`, written by `bootstrap.sh`. |
| **The service** | Runs as `ec2-user` with `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome` and a private `/tmp`. `ec2-user` can sudo anything, so `NoNewPrivileges` is the line that keeps a hole in the game from becoming root. |
| **HTTP** | Per-address token bucket (40/s, burst 200) on both listeners; headers must arrive within 10 s; `GET /%`-style junk is a 404, never an exception. CSP `default-src 'self'`, `frame-ancestors 'none'`, HSTS, `nosniff`. |
| **Sockets** | WebSocket *and* WebTransport share the per-address limits: 90 connects a minute (burst 40), 64 open at once, 120 messages a second per socket, 4 KB per message. A socket that keeps flooding is closed. |
| **Messages** | Every field is type-checked, and a message handler that throws is logged and dropped rather than taking the process down. |
| **Host commands** | Gated by `[admin] key`, compared in constant time. Without it the host is the longest-standing human, as before. |
| **`/deploy`** | 404 to anything but a POST with the right token; 10 s cooldown. |
| **Secrets** | `config.ini` only, `chmod 600`, never in git (the history was checked). |

The regressions that were found doing that check - a stray `%` in a URL, `/logout`, and a message
field whose `toString` is not a function each ended the process - are locked in by
`test/smoke.test.js`.
