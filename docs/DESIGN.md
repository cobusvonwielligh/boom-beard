# Boom Beard - Design

Date: 2026-10-23; implementation addendum updated 2026-10-25
Author: Cobus (with Claude)
Status: original intent plus current implementation. [RULES.md](RULES.md) and
[STATUS.md](STATUS.md) are authoritative where the original plan changed.

---

## 1. Intent

The eezi team wants something to play together on Friday afternoons. Game of Bombs is the
reference - some of us already played it - but it is someone else's server, it is flaky, and
corporate IT does not reliably let it through. We want our own: one box, one hostname, type
your name, play.

The success test is simple and social, not technical:

> On a Friday, 10–12 of us open a link, pick names, and spend ten minutes blowing each other up
> without anyone saying "mine is lagging" or "how do I do the thing again".

That second half matters. People who played Game of Bombs should not have to relearn anything.
Movement feel, bomb fuse, blast shape, perk icons, the rhythm of the round - all of it should be
close enough that muscle memory transfers.

---

## 2. Goals

1. **16 concurrent players**, one shared arena, no lobbies or matchmaking.
2. **Feels right at high latency.** Designed so a player on a 180 ms link plays essentially the
   same game as a player on a 20 ms link. See §5.
3. **Low-friction owned identity.** Type a name and claim it once with a password. A trusted-browser
   token makes later visits one click; there is still no email, OAuth or account-recovery flow.
4. **One IP, one port, one hostname.** An IT department unblocks a single thing and we are done.
5. **Trivially portable.** It runs on a personal AWS account today and inside the eezi VPC later
   with a config change, not a rewrite.
6. **Fast to run locally.** `npm install && npm start` and you are playing. One dependency.
7. **Splittable work.** Two developers working in parallel with near-zero merge conflicts.

## 3. Non-goals (v1)

Explicitly out. Not "later" - out of this build.

- Email, OAuth, social login, password recovery and public account profiles.
- Payments, plutonium, shops, skins, the skin constructor. Gold exists only as an in-game
  collectible and lifetime stat.
- A persistent streaming world. We have three fixed arenas.
- Mobile or touch controls.
- Matchmaking, multiple rooms, multiple server regions.
- Competitive anti-cheat, moderation staff and appeals. The server is authoritative and validates
  identity, movement inputs and game rules; this is still a small office game, not an esport.
- Puzzles, iron chests, keys, locked gates, forts, warehouses, caches, soccer/goal mode, bosses,
  hamsters, the ball.
- Observer camera scroll-wheel zoom.

## 4. Anti-goals

Things that would make this a failure even if every feature ticked:

- **It is laggy.** If people feel their input is not landing, they will not come back. Latency
  tolerance is the single most important engineering property of this build.
- **It needs a build step to run.** Nobody should have to fight webpack on a Friday.
- **IT blocks it.** Multiple domains, odd ports, WebRTC, or a CDN dependency kills it dead.
- **It takes more than 10 seconds from link to playing.**
- **It is a different game.** If a Game of Bombs player has to relearn how bombs chain or how
  perks drop, we have failed goal 1's spirit.
- **One file both developers need to edit.** That is how a two-person project stalls.

## 5. The central constraint: latency

The server will sit on AWS free tier in Europe. Where the players sit is not yet settled, so the
design assumes the worst realistic case: **South Africa → eu-west-1, ≈180 ms round trip.**

Three things make this playable, and they are the heart of the architecture:

**(a) Explosions are derived, not announced.** When a bomb is placed, the server tells everyone
*when it will explode* (a fixed tick number), not *that it exploded*. Fuse is 2.4 s. A client
180 ms behind still has 2.2 s of warning and computes the identical blast locally. Nobody ever
dies to a blast they could not see. This single decision removes most of the latency problem.

**(b) Players do not collide with each other.** In classic Bomberman and in Game of Bombs you
walk through other players. Keeping that means nothing in the game depends on knowing exactly
where a remote player is *right now* - we can render them 130 ms in the past and it is invisible.

**(c) Your own movement is predicted and reconciled.** Your character responds to your keys on
the same frame. The server is still authoritative; mismatches are corrected by replaying your
unacknowledged inputs. The correction is almost always zero because the movement rules are
deterministic integer maths shared by both sides.

What is left that latency can still hurt: two players grabbing the same perk (server wins, the
loser's pickup flickers away), and catching a status by touching someone (resolved server-side,
appears ~RTT later). Both are acceptable.

Full detail: [NETCODE.md](NETCODE.md).

## 6. The how, as decided

These were chosen, not discovered. A builder may push back but should not quietly change them.

| Area | Decision |
|---|---|
| Server runtime | Node 20+. Two runtime dependencies. HTTPS + WebSocket in one process, with WebTransport/HTTP3 beside it on UDP 443. |
| Client | Vanilla ES modules and DOM APIs served raw. No framework and no build step. |
| Rendering | Canvas 2D. Static map drawn once into cached 8×8-tile chunk canvases, dirty-redrawn on change. Entities drawn per frame on top. Same approach Game of Bombs uses. |
| Shared code | `shared/` directory, ES modules, imported unchanged by Node and the browser. The simulation is literally the same file on both sides. |
| Wire format | JSON snapshots at 15 Hz over WebTransport datagrams when available, WebSocket otherwise. |
| Simulation | Fixed 30 Hz tick, integer fixed-point positions (1 tile = 256 units), fully deterministic. |
| Art | Board art is generated in code from shapes. A small PNG set is used for landing/HUD branding, including the generated bearded wordmark. |
| Audio | Synthesised SFX plus four produced music files, with generated WebAudio fallbacks. Music 10 % by default, SFX 75 %. |
| Persistence | A JSON file on disk, flushed every 30 s. Leaderboard only. No database. |
| Identity | Password-owned name + revocable device token + `playerId`. Canonical names are unique across case, spacing and Unicode compatibility forms. |
| Build | None. `node server/index.js`. |
| Tests | `node --test`. No framework, no fixtures. |
| Deployment | Single container, single port 443, TLS. Portable from personal EC2 to eezi VPC by changing environment variables. |

## 7. Scope: what is in v1

Agreed in planning:

- **Core**: movement, slides, bombs, owner-coloured fire, destructible blocks, safe respawn,
  ten-minute rounds, scoreboards and player dossiers, five maps.
- **Perks**: Bomb +1, Fire +1, Boots +1, Shield, Stim and Rum. Gift was removed.
- **Statuses** (the contagious diseases): Invulnerability, Pacifism, Slowdown, Invisibility,
  Changeling, Reduction, Fast Detonation.
- **Chat** (ENTER), narrow severe-language masking, and observer mode.
- **Leaderboard** with the 16 Game of Bombs rank titles.

Designed-for but **not built** in v1 - the architecture leaves explicit, named slots so adding
them later is a new file, not a refactor:

- Kick, Jelly, Detonator (radio bombs), Bat (charge-throw), Jetpack, Nuclear charge, Blue fire,
  Heart, Key.
- Nyan disease and nyan bombs.
- Rocks, ore, treasure, chests, bridges, arrows, buttons, cabins.

Exact numbers for everything in scope: [RULES.md](RULES.md).

## 8. Constraints

- AWS free tier: one `t3.micro`/`t2.micro`, 1 GB RAM, burstable CPU. The sim must stay well
  inside one core at 30 Hz with 16 players. It will - this is a grid game with ~1 200 cells.
- Free tier egress is 100 GB/month. At 15 Hz JSON snapshots a full 16-player round costs about
  180 MB. That is roughly 500 rounds a month. Comfortable, but it is the number to watch if we
  ever raise the snapshot rate.
- Corporate network: must work over `wss://` on 443 to a single hostname, with a strict
  `default-src 'self'` content security policy and no external requests of any kind.
- Two developers, roughly a week of part-time work, split as vertical slices.

## 9. What is left to the builder

Deliberately unspecified - make the call, write it down in the PR:

- Exact easing on the camera follow.
- Menu layout and copy, beyond "name field, three map cards, play button".
- How bots behave in `npm run bots` (they only need to move and bomb plausibly).
- The shape of the status visual effects, as long as each is distinguishable at a glance.
- Internal naming inside a slice you own.

## 10. Open questions

- **Resolved:** production is in `af-south-1`, and `https://boombeard.co.za` is the canonical
  hostname. `15.240.88.189.sslip.io` remains a certificate-covered fallback that redirects to it.
