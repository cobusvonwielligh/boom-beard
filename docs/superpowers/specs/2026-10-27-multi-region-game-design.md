# Multi-Region Game and North America Deployment

## Goal

Run the current game in South Africa and North America, let players choose the closest
available server, and keep each server's administration data isolated. Fix the root
favicon URL as part of the production follow-up.

## Current findings

- `https://boombeard.co.za/admin` currently returns the protected dashboard login page.
- `https://boombeard.co.za/favicon.ico` returns 404; the favicon exists only under
  `/assets/img/`.
- The North America EIP `52.21.210.27` does not currently serve HTTPS.
- `us.boombeard.co.za` has no DNS record. The available AWS identity cannot edit the
  Route 53 hosted zone, so an A record must be added before issuing the regional TLS
  certificate.
- The supplied key is present as `~/Downloads/bombs-away-na.pem`; its current
  permissions must be restricted before SSH use.

## Architecture

Keep `boombeard.co.za` as the South Africa game and landing-page host. Use
`us.boombeard.co.za` for the North America copy, pointing to `52.21.210.27`. Each
instance runs the same `main` commit and serves the same routes, including `/admin`.
The hostname and each server's local configuration select its region and data directory.

The root landing page knows the two HTTPS endpoints. Each instance exposes a small,
unauthenticated `/region-status` response containing only region ID, connected human
players, bot count, and maximum seats. It must not expose names, scores, registration
totals, or other `/healthz` data. Cross-origin status requests are allowed only from
the two game origins and never include credentials.

The browser probes both endpoints concurrently, measures HTTP round-trip time, and
displays the country flag, RTT, human player count, and capacity. A visitor without a
saved choice defaults to the lowest-latency reachable region. A manual selection is
persisted and is not silently overridden. The browser probes again immediately before
registration/join, and refreshes the displayed status periodically. An offline region
is clearly marked; joining it is disabled with an explanation. If both regions are
unavailable, joining is disabled rather than redirected to an unselected server.

The selected region's hostname is passed to the existing WebSocket/WebTransport
connection code. The resulting account, career, and operational data are written only
to that instance's existing local stores. No production user database is copied to the
new server, and no cross-region account or score synchronization is introduced.
The browser namespaces player IDs and trusted-browser tokens by region so registering
on one server cannot overwrite the identity or trust token used on the other. The
player name may be reused, but a first visit to a region can require claiming that
name there.

`/admin` remains same-origin on each regional hostname. The ZA dashboard reads only
ZA accounts, metrics, and geography; the US dashboard reads only US-local data.
Each instance has its own server-side admin key and password configuration. The
owner's browser enrolls each regional key on that host with the existing
`/?admin=<key>` flow. Dashboard login reads the trusted-browser token scoped to that
host's region.

## Production setup

Add `us.boombeard.co.za A 52.21.210.27` in Route 53, then provision the instance with
TLS for that hostname and deploy the current `main` commit. The provided SSH key must
be chmod 600 before SSH. The current AWS identity lacks Route 53 write permission, so
DNS must be added by an authorized operator before production TLS and the final NA
hostname can be verified. Until then, the NA region remains unavailable; do not silently
substitute the bare IP, because it cannot provide the required hostname-bound HTTPS
and `/admin` behavior.

The public root favicon URL `/favicon.ico` will serve the existing ICO asset directly.
The page's icon metadata will point to that root route.

## Failure handling and security

- Failed, timed-out, or invalid status responses mark only that region offline.
- Probe timeouts are bounded; status polling must not block rendering or game startup.
- Regional credentials stay in ignored/server-only configuration and are never sent to
  another region or the browser.
- The status response is deliberately smaller than `/healthz` and contains no player
  identity or progression data.
- Admin session checks and API protection remain enforced independently on both hosts.

## Acceptance criteria

1. `/favicon.ico` returns the existing ICO with an image content type and HTTP 200.
2. `/admin` on each regional hostname returns that host's login page; unauthenticated
   admin data APIs remain denied.
3. Both landing pages show flags, current RTT, human players/max, and bot count.
4. With no saved override, the lowest measured reachable RTT becomes the default.
5. A saved manual choice survives reload and is not replaced by later probe results.
6. A fresh probe runs before registration/join; an unavailable chosen region blocks the
   join with a useful message.
7. A join uses the selected host's secure transport, and server-side tests verify that
   account, score, and admin data remain instance-local.
8. The ZA root's admin data remains unchanged by the NA instance.

## Deliberate non-goals

- Shared user accounts, progression, or leaderboards.
- Global load balancing or AWS Global Accelerator.
- Copying production user data into North America.
- Automatic migration of an active game session between regions.
