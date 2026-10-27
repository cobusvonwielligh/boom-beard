# Region Choice Dialog and Game-Only US Routing

## Goal

Keep `boombeard.co.za` as the only landing-page and admin origin while allowing
players to choose the South African or US game server on every connection
attempt. The US host serves game traffic only and has no regional hostname.

## Region dialog

- Remove the always-visible region picker from the landing page.
- After local Play validation, open a compact, accessible dialog for every
  connection attempt. Spectating also opens the dialog because it starts a
  game-server connection.
- Preselect the player's last confirmed region, or the lowest-latency reachable
  region if they have not chosen before. Persist a choice only when confirmed;
  never skip the dialog based on a saved choice.
- Show South Africa and United States using small local flag assets, not
  regional abbreviations or platform-dependent flag emoji.
- Show measured RTT and human players online out of server capacity. Color RTT
  green at 0–50 ms, orange at 51–99 ms, and red at 100 ms or higher.
- Keep unavailable regions visible as offline and prevent selecting them. Do
  not show a success/status footer; errors are represented by the affected
  region's state.
- Use the heading “Choose your region”; remove “Choose your waters” and the
  “South Africa server ready” message.
- Remove the country/IP analytics disclosure paragraph from the landing page.
  This changes only displayed copy, not analytics or collection behavior.

## Region and transport architecture

- Keep all landing-page assets, account entry, and `/admin` on
  `https://boombeard.co.za`. The admin dashboard remains ZA-local.
- Use the US Elastic IP directly for US status probes and game transports:
  `https://52.21.210.27/region-status`, `wss://52.21.210.27/ws`, and
  `https://52.21.210.27/wt`.
- Issue a browser-trusted Let's Encrypt IP-address certificate for the US EIP
  using the `shortlived` profile. IP certificates are valid for six days, so
  the host must renew at least daily and reload the certificate safely.
- The US instance answers health, region status, and game transport endpoints.
  Its root, static pages, and admin routes redirect to the ZA site; the browser
  continues loading all game assets from ZA.
- Allow the ZA origin for cross-origin US status probes. Do not expose
  credentials in status responses.
- Keep each region's game data and browser identity tokens isolated.

## Deployment and prerequisites

- The US instance is currently configured for local HTTP on port 8080. Direct
  public status probes and WSS/WT require inbound TCP 80 and 443 on its AWS
  security group; no DNS record is needed.
- Port 80 is needed for standalone ACME validation and renewal; TCP 443 serves
  the game and status endpoint.
- Available AWS CLI profiles currently lack EC2 security-group permissions.
  The application and certificate changes can be prepared, but public US
  verification remains blocked until those ingress rules are enabled.

## Validation

- Unit tests cover dialog invocation, saved-but-confirmed selection, flags,
  ping classes, player counts, offline selection, and transport URLs.
- Server tests cover US game-only redirects, status CORS, and health/game
  endpoint behavior.
- Bootstrap tests cover IP certificate issuance and daily renewal scheduling.
- Verify the ZA landing page and admin remain served from ZA, the US host does
  not render its own landing page, and the US status and game transports work
  directly after network ingress is enabled.
