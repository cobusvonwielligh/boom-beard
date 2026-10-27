# Boom Beard - Deployment

The game runs as two independent regional instances:

- **South Africa:** `boombeard.co.za`, EC2 in `af-south-1`, `region_id=za`.
- **North America:** `us.boombeard.co.za`, EIP `52.21.210.27`, EC2 in `us-east-1`,
  `region_id=us`.

Both hosts run the same `main` commit. The root landing page probes each region, shows
the measured browser RTT and available capacity, and connects to the selected host.
Each instance owns its accounts, leaderboard, geography, metrics, and `/admin` data;
there is no shared database or cross-region progression sync.

---

## 1. The shape

```
                      ┌───────────────────────────────┐
 browser ──HTTPS──►   │ boombeard.co.za · ZA         │
                      │ landing page + game server   │
                      └───────────────┬───────────────┘
                                      │ HTTPS status probes
                      ┌───────────────┴───────────────┐
                      │                               │
              WSS/WT to ZA                     WSS/WT to US
                      │                               │
          ┌───────────▼────────┐          ┌───────────▼────────┐
          │ EC2 · af-south-1   │          │ EC2 · us-east-1    │
          │ boombeard.co.za    │          │ us.boombeard.co.za │
          │ local data + admin │          │ local data + admin│
          └────────────────────┘          └───────────────────┘
```

Each region is one Node process under systemd, with HTTPS/WSS on 443 and the HTTP redirect
on 80. The WebSocket shares that region's HTTPS origin. The root page makes a credential-free
status request to the other region; CORS exposes only the minimal region status payload.
There is no load balancer, CDN, or central database.

**No Docker.** Each region is one Node process and one systemd service. systemd restarts it
on crash and survives reboots; `npm run deploy` is an rsync instead of an image build. If
this moves to ECS Fargate, add a container definition then.

**No load balancer.** The player selects a region in the landing page and connects directly
to that region's hostname. This keeps `/admin` and all persistent game data instance-local.

---

## 2. Why this survives corporate IT

Each row is a thing that commonly gets a game blocked, and the choice that avoids it:

| Common blocker | What we do |
|---|---|
| Non-standard ports | **All game traffic on 443.** Port 80 is open only for the HTTPS redirect and certificate renewal. |
| Plain `ws://` on 80 | **`wss://` on 443.** TLS-wrapped, so proxies pass it as ordinary HTTPS. |
| Multiple domains / CDNs | **Two regional hosts under one domain.** `boombeard.co.za` and `us.boombeard.co.za` are the game origins; the status endpoint allows only these origins. |
| Web fonts, analytics | None. Zero external requests. |
| WebRTC / UDP | Not used. |
| Category filters ("games") | Prefer a neutral hostname on an eezi domain over something obviously a game. |

**Ticket text for IT, paste as-is:**

> Please allow outbound HTTPS (TCP 443) to `boombeard.co.za` and `us.boombeard.co.za` for
> the dev team. It is an internally hosted tool on infrastructure we control. The game uses
> standard HTTPS and secure WebSockets over port 443 on those two hosts. No other game hosts,
> ports, or protocols are required.

---

## 3. Hostname without a domain

`sslip.io` resolves any embedded IP, so `15.240.88.189.sslip.io` → `15.240.88.189`, free, instant,
no account. Let's Encrypt issues for it happily.

```
$ dig +short 15.240.88.189.sslip.io
15.240.88.189
```

Swapping to a real eezi hostname later is a DNS record plus re-running `bootstrap.sh` with the
new `HOST`. Nothing in the code knows the name.

---

## 4. First-time setup

### On AWS (console)

1. **Instance** - `t3.micro`, Amazon Linux 2023, 16–20 GB gp3, in `af-south-1`.
2. **Elastic IP** - allocate, associate to the instance. (Since Feb 2024 every public IPv4 costs
   $0.005/h; Free Tier covers 750 h/month for 12 months, so one is free for a year.)
3. **Security group** - exactly three inbound rules, nothing else:

   | Port | Source | Purpose |
   |---|---|---|
   | 443 | `0.0.0.0/0` | the game |
   | 80 | `0.0.0.0/0` | HTTPS redirect + ACME renewal |
   | 22 | your IP | SSH |

   Specifically **not** 8080 - that is local dev only.

### On the box (once, ~3 minutes)

```bash
scp -i ~/Downloads/bombs-away.pem infra/bootstrap.sh ec2-user@15.240.88.189:
ssh -i ~/Downloads/bombs-away.pem ec2-user@15.240.88.189 \
  'HOST=15.240.88.189.sslip.io EMAIL=you@example.com bash bootstrap.sh'
```

`bootstrap.sh` is idempotent - re-run it any time. It installs Node, creates
`/opt/boom-beard` and `/var/lib/boom-beard`, issues the certificate, installs a deploy hook
that copies the cert somewhere the unprivileged service can read it, and arms a weekly renewal
timer for 03:00 Sunday. Set `REGION_ID=za` on the South Africa instance and `REGION_ID=us`
on the North America instance.

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

`/admin` is instance-local: `https://boombeard.co.za/admin` reports ZA data, and
`https://us.boombeard.co.za/admin` reports US data. Each instance requires `ADMIN_KEY`,
`ADMIN_DASHBOARD_PASSWORD`, and `REQUIRE_PASSWORD=1`. Open the bootstrap-provided
`/?admin=<key>` link once in the trusted `cobusvw` browser on each host, then use that
host's `/admin` and the dashboard passphrase. A new regional instance has its own empty
account store; the owner must claim `cobusvw` there before the trusted-browser check can
succeed. The second factor is never shipped to the browser or stored in git; it is
accepted only over TLS.
`bootstrap.sh` preserves an existing dashboard password and accepts a new one through the
`ADMIN_DASHBOARD_PASSWORD` environment variable.
The dashboard currently requires TLS to terminate directly in the app. It is not supported with
`SKIP_TLS=1` behind a TLS-terminating load balancer.

## Regional server setup

1. Add the Route 53 record `us.boombeard.co.za A 52.21.210.27` and confirm it resolves before
   requesting a certificate.
2. Allow inbound TCP 443 (game), TCP 80 (redirect and ACME renewal), and TCP 22 only from the
   administrator's current IP.
3. Use `REGION_ID=us`, `HOST=us.boombeard.co.za`, and the North America key with
   `infra/bootstrap.sh`. Bootstrap creates a unique admin key for the host and prints a
   one-time enrollment link; do not copy the ZA admin key. Supply the dashboard password
   through the server environment. Keep `/var/lib/boom-beard` on that instance; do not copy
   the ZA accounts or leaderboard.
4. Deploy the same `main` commit to both hosts. Set `region_id=za` on the existing instance
   (the default) and `region_id=us` on the new instance.

The browser probes the public `/region-status` endpoint on each host. It returns only the
region ID, connected human count, bot count, and seat limit; it does not expose `/healthz`,
player names, scores, registrations, or geography.

The admin geography panel counts home-page views and new registrations by country. It performs
GeoLite2 country lookups locally, persists only daily ISO country totals in
`<data_dir>/geography.json` for up to 365 days, and never saves the source IP. The map is
approximate and must not be used to identify an individual. GeoLite2 data is licensed by MaxMind;
the dashboard displays the required attribution. Refresh the pinned `geoip-country` package
at least monthly to keep its bundled country database current. Past traffic cannot be backfilled.

Local development needs no file at all: `npm start` → `http://localhost:8080`.

Nothing AWS-specific appears in the application code. Each region uses the same server
configuration shape and its own `/var/lib/boom-beard` files; the VPC move remains a
configuration change, not a database migration.

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

## 7. Regional DNS and deployment

The South Africa host remains `boombeard.co.za`. For North America:

1. Add the Route 53 A record `us.boombeard.co.za` → `52.21.210.27`. Wait until
   `dig +short us.boombeard.co.za` returns that EIP before requesting a certificate.
2. Confirm the NA security group allows inbound TCP 443, TCP 80, and SSH (TCP 22)
   from the administrator's IP.
3. Secure the provided key with `chmod 600 ~/Downloads/bombs-away-na.pem`, copy
   `infra/bootstrap.sh` to the NA host, and run it with
   `HOST=us.boombeard.co.za REGION_ID=us` and the existing Let's Encrypt contact.
   Bootstrap generates a unique admin key and prints a one-time enrollment link.
   Supply the dashboard password through the environment and do not copy the ZA key
   or `/var/lib/boom-beard` directory.
4. Merge and push the verified code to `main`, then deploy that exact commit to ZA and
   NA. For the NA manual deploy, override `SSH_HOST=52.21.210.27`,
   `SSH_USER=ec2-user`, and `KEY=~/Downloads/bombs-away-na.pem`.
5. Verify `/version`, `/region-status`, and `/admin` on both hosts. Each region returns
   its own metrics and local accounts; a first visit to NA may require claiming the
   `cobusvw` account there before the trusted-browser admin check succeeds.

Do not use the bare IP as the production game origin. TLS certificates and canonical
redirects are tied to the regional hostnames. `/healthz` and `/deploy` remain available
on the local host name for deployment health checks.

---

## 8. Moving into the eezi VPC later

| Thing | Personal AWS account today | eezi VPC later |
|---|---|---|
| Compute | Two EC2 instances + systemd | Same two regions in private subnets - or ECS with a six-line Dockerfile per service |
| TLS | Let's Encrypt on each app | ACM on an ALB for game traffic; `/admin` needs trusted-proxy support before using TLS termination there |
| Hostnames | `boombeard.co.za` and `us.boombeard.co.za` | Regional hostnames under the eezi domain |
| Access | Public internet | VPC + VPN or an internal ALB - **then IT does not need to unblock anything at all** |
| Data | Separate `/var/lib/boom-beard/` per region | Separate region-specific mounts or prefixes |
| Config | `/etc/boom-beard.env` | Task definition env or SSM Parameter Store |

Three properties make this a config change rather than a project:

1. Each region uses its own `DATA_DIR`; no shared-state service is required.
2. The app's ZA/US IDs are application config; it **never calls an AWS API**.
3. TLS is optional for game traffic, but `/admin` intentionally remains unavailable
   behind an untrusted TLS-terminating proxy.

Do not pre-build for this. No SDK, no filesystem abstraction, no Terraform. It is a day's work
when it happens and nothing today gets easier by guessing now.

---

## 9. Operations

**Logs.** `sudo journalctl -u boom-beard -f`, or `--since 1h` to debug a Friday session.
systemd rotates them. No log shipping.

**Health.** `https://<host>/healthz` → `{ ok, players, maxPlayers, lag, uptimeS }`. Check it by
eye before a session; that is the whole monitoring story.

**Restart / reboot.** `Restart=always` plus `systemctl enable`, so a crash recovers in two
seconds and a reboot comes back unattended. On SIGTERM the server closes sockets cleanly.

**Backup.** `leaderboard.json` is the only state. A daily `cp` to a dated file, keep seven. If it
is ever lost, everyone's lifetime score resets and we live.

**Certificates.** Renewed by `certbot-renew.timer` at 03:00 Sunday. The deploy hook copies the
new pair into `/var/lib/boom-beard/certs` and restarts the service. Check with
`systemctl list-timers certbot-renew`.

---

## 10. Cost

| Item | Regional deployment |
|---|---|
| EC2 | Two `t3.micro` instances; price varies by region and account credits |
| Public IPv4 | Two Elastic IPs; billed per address under current AWS pricing |
| Egress | Combined game traffic; estimate from both regions' usage |
| TLS | $0 (Let's Encrypt on each instance) |
| Hostname | Existing `boombeard.co.za` plus `us.boombeard.co.za` |

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
