# Signup Meter, Admin Signup Statistics, and Google Ads Design

## Goal

Show a durable human-signup total on the desktop landing page, give the `cobusvw` owner rolling signup statistics in the existing in-game diagnostics, and install the Google Ads base tag without enabling ad storage before consent.

## Signup Definition

A signup is one successfully registered account in the existing account store. Account keys are normalized names and cannot be registered twice, so the metric is a unique player-account count. Bots never register accounts and are excluded automatically. A one-time cleanup removes existing accounts named `cobus`, `cobusvonw`, `test`, `awe`, and `mock`, while preserving `cobusvw`. The preserved existing `cobusvw` record is excluded from counts once; future registrations with these names count normally. No other identity or name pattern is removed.

The account store already writes a millisecond `created` timestamp for new records. It will expose a pure `stats(now)` aggregate with:

- `total`: every account, including legacy records without a creation timestamp;
- `last24h`: records created during the preceding 24 hours;
- `last7d`: records created during the preceding 7×24 hours;
- `last30d`: records created during the preceding 30×24 hours.

Window boundaries are inclusive. Legacy or malformed creation timestamps do not enter time windows but still contribute to the total.

## Public Signup Counter

A new `GET /signup-count` endpoint will return only the public aggregate:

```json
{ "count": 184 }
```

The response will be JSON with a short public cache lifetime. It will not expose names, creation dates, recent-window counts, devices, scores, or any account record.

The landing page will fetch this endpoint once. Until a valid count arrives, the meter displays dashes; it never substitutes zero for a network or server error.

## Landing-Page Visual

The signup meter lives inside the landing-page container and is fixed to the bottom-right of the desktop viewport. Because it is a child of the landing page, it disappears when the menu is hidden for gameplay.

The component is intentionally compact and does not alter the centered card's dimensions. It resembles a mechanical domestic water meter:

- dark individual digit wheels with a central seam;
- a weathered brass casing and small screw details;
- a restrained glass highlight;
- a rust-red least-significant digit;
- the label `PIRATES REGISTERED`;
- at least five zero-padded wheels, expanding rather than truncating for larger totals.

There is no mobile layout or mobile-specific behavior. The project remains desktop-only.

## Admin Signup Statistics

The existing `/healthz` payload will receive the complete signup aggregate. The client already fetches and displays server diagnostics only for the owner/admin experience; the new data will be rendered as a third compact server row in the bottom-left diagnostics:

```text
SIGNUPS 24H 3 · 7D 18 · 30D 61
```

The public landing counter consumes only `/signup-count`, not the rolling-window fields. The aggregate contains no personally identifying data.

## Google Ads Base Tag

The document will gain an explicit `<head>` and the Google tag ID `AW-18535357585`. Consent Mode v2 defaults will execute before the external tag and before `gtag('config', ...)`:

- `ad_storage: denied`;
- `ad_user_data: denied`;
- `ad_personalization: denied`;
- `analytics_storage: denied`.

This is advanced consent mode: the tag may send cookieless measurement signals, but it does not write advertising or analytics storage while consent remains denied. A later consent interface can call `gtag('consent', 'update', ...)`; that interface and the registration conversion event are explicitly outside this task.

The Content Security Policy will allow only the Google hosts needed to load and operate this Ads tag. Existing self-hosted game, WebSocket, media, and clickjacking protections remain in place.

## Failure Handling

- Account statistics ignore malformed timestamps rather than failing the endpoint.
- `/signup-count` always serializes a finite non-negative integer.
- A failed public fetch leaves the meter in its unknown state.
- Missing signup fields in an older health response render dashes in owner diagnostics.
- Google tag failure or blocking does not affect signup, login, gameplay, or the counter.

## Verification

Automated tests will verify:

- unique total and exact inclusive 24h/7d/30d boundaries;
- legacy account behavior and persistence;
- `/signup-count` shape and absence of private/window fields;
- health payload signup aggregates;
- the landing meter is inside the menu, bottom-right, compact, and renders separate wheels;
- invalid or failed counts stay unknown rather than showing zero;
- owner diagnostics contain the three rolling windows;
- the Google tag ID appears once;
- all four consent defaults execute before the external tag/config call;
- CSP contains the minimum required Google hosts;
- existing account, deployment, source, browser-module, and full project tests continue to pass.
