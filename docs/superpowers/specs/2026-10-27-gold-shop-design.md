# Persistent Gold Shop Design

## Goal

Turn the existing collected gold into a persistent spendable wallet and let human players queue a small next-round loadout while dead or between rounds. The shop must reuse Boom Beard's existing perk icons, colors, cast-gold typography, pickup sounds, server authority, persistence model, and death/intermission card.

## Scope

The shop sells exactly four bundles:

| Item key | Display item | Cost | Bundle granted next round | Maximum queued grant |
|---|---|---:|---:|---:|
| `speed` | Speed | 1 gold | +1 speed level | +4 |
| `shield` | Shield | 1 gold | +1 shield | +2 |
| `stim` | Stim | 1 gold | +2 stamina levels | +4 |
| `fire` | Fire | 1 gold | +2 blast radius | +4 |

Bomb capacity, rum, gold, statuses, health, and every other mechanic are not sold.

There are no refunds or cart-decrement controls. Each accepted click buys one bundle. A button becomes unavailable when the player lacks one gold or the queued grant has reached the existing simulation cap.

## Floor Drop Frequency

Ordinary floor powerups become 20% less frequent, while gold keeps its current absolute drop rate. After the existing drop logic selects a non-gold perk, an independent 80% keep roll decides whether that perk is created; the remaining 20% becomes no drop. A selected gold drop bypasses this thinning roll.

The removed non-gold probability is not redistributed into gold or another perk. Existing adaptive supply/demand, block eligibility, forced-drop rules, per-type weights, round caps, and death-scatter behavior otherwise remain unchanged. The keep roll uses the simulation's deterministic RNG so identical seeds still produce identical matches.

## Persistent Economy

The leaderboard remains the one persistent gameplay store. Account/password storage will not carry economy data.

Existing `coins` remains the lifetime number of gold coins collected. Two additive fields are introduced on each human career record:

- `spentCoins`: lifetime gold spent, defaulting to zero;
- `pendingShop`: queued next-round grants, defaulting to an empty four-item object.

The spendable wallet is always derived:

```text
wallet = max(0, lifetime coins collected - spentCoins)
```

This migration makes every previously collected coin spendable while preserving the existing `gold collected` statistic. Old board files remain version 1; absent fields safely mean zero/empty. When old browser identities are folded into a name-keyed career, collected and spent totals are summed and queued grants are summed then clamped to their normal caps.

The existing in-game gold HUD changes to the spendable wallet. Lifetime profile and all-time statistics continue to show total gold collected.

## Authoritative Purchase Flow

The client sends only a whitelisted item key. The room and leaderboard own every decision.

Before evaluating a purchase, the room banks the player's current unbanked score and coins. This makes a coin collected moments before death immediately spendable without double-counting it later.

A purchase succeeds only when:

- the seat exists and belongs to a human player;
- the player is dead, or the room is in the between-round intermission;
- the item key is one of the four defined shop items;
- the wallet contains at least one gold;
- adding the bundle would not exceed the item's normal simulation cap.

On success, `spentCoins` increases by one and the bundle is added to `pendingShop` in the same career record. The leaderboard queues an immediate durable flush. Node's single event loop serializes rapid clicks, so every click rechecks the balance and cap after the preceding click.

There are no client-side balance decisions, no negative balances, no partial bundles, and no shop access for bots or spectators.

## Queue Lifetime and Round Application

Paid purchases persist through reconnects and server restarts until consumed.

At a round reset, each connected human seat receives and consumes its pending loadout once. Disconnected careers are untouched. A player joining after a reset, including during that round's count-in, waits for the following round boundary; a purchase is a starting loadout, never a mid-round grant.

The fresh player receives:

- `speed` directly from queued speed levels;
- `shields` directly from queued shields;
- `staminaLevel` from queued stim levels, with stamina filled to the resulting maximum;
- `radius = START_RADIUS + queued fire`.

The queue is cleared and flushed as part of consumption before the new-round welcome is broadcast. Purchases then behave exactly like floor perks: they apply to that starting life and are lost on death. Respawning later in the same round returns to the ordinary defaults.

## Timing and Availability

The between-round intermission changes from 20 seconds to 16 seconds.

The same shop shelf appears in the existing death/intermission card:

- while dead, below the death content and above the manual respawn action;
- between rounds, below the standings/countdown content.

The shop is never shown while the player is alive. While the death shop is visible, auto-respawn is disabled and its control is visibly disabled/dimmed; the stored preference is retained but not executed. The player leaves the shop with the existing manual respawn button. Intermission ends normally at the 16-second boundary.

## Visual Design

The approved layout is the compact horizontal four-item perk shelf.

The shop reuses the exact SVG symbols already in the document:

- wallet: `#i-coin`;
- speed: `#i-boot`;
- shield: `#i-shield`;
- stim: `#i-bolt`;
- fire: `#i-fire`.

No icons are redrawn. Wallet text, `SHOP`, `QUEUED LOADOUT`, and other primary text use the existing Clegan display face and `.cast`/`.castSm` gold treatment.

Each item uses the existing floor-perk palette exactly:

| Item | Dark | Mid | Rim |
|---|---|---|---|
| Speed | `#123f4e` | `#1b6076` | `#5fd8f0` |
| Shield | `#15402f` | `#1d6347` | `#5ad1a0` |
| Stim | `#4a4212` | `#75671d` | `#ffe04a` |
| Fire | `#5a2416` | `#8c3a1f` | `#ff9b4a` |

Each compact item shows its icon, item name, bundle (`+1` or `+2`), one-gold price with the exact coin icon, and queued amount. Accepted purchases flash the button in its own perk color and reuse the existing `pickup` voice with the matching perk type. Rejections reuse the existing warning sound and toast text. No new audio vocabulary is introduced.

## Protocol and Client State

Two client-to-server messages are added:

- `shop`: request the private current shop state;
- `shopbuy`: request one bundle by item key.

The private `shop` response includes:

- current spendable wallet;
- queued grants for the four items;
- per-item availability or a rejection reason;
- the purchased item key on a successful buy so the client can play the correct pickup sound.

The client requests shop state when the death card opens, when intermission begins, and after reconnecting into either state. Every purchase receives a fresh authoritative response.

The normal once-per-second score message adds the player's spendable wallet for the existing HUD gold counter. Other players' private queues are never broadcast.

## Failure Handling

- Unknown or malformed shop messages are ignored or rejected without throwing.
- An unavailable leaderboard disables purchasing and reports an unavailable shop rather than inventing a wallet.
- A failed disk write leaves the leaderboard dirty for retry under its existing persistence rules.
- Duplicate or rapid clicks cannot overspend because the server validates sequentially.
- Missing new fields in old clients/servers degrade to wallet/queue unknown states without breaking gameplay.
- A client may animate a purchase only after the authoritative success response.

## Verification

Automated tests will cover:

- migration from old leaderboard records and preservation of lifetime collected gold;
- wallet derivation and immediate use of newly banked coins;
- persistence of spending and queued grants through reload/restart;
- identity merging and queue clamping;
- all four prices, bundle sizes, and existing simulation caps;
- insufficient gold, over-cap, unknown-item, alive-player, bot, and spectator rejection;
- disconnected queues remaining untouched;
- connected queues applying once at reset and clearing durably;
- queued upgrades present on the first life and lost on death;
- 16-second intermission timing;
- disabled auto-respawn while the death shop is visible;
- private protocol state and authoritative purchase responses;
- spendable-wallet HUD versus lifetime-collected profile stats;
- exact reuse of coin/perk SVG symbols, floor-perk palettes, and cast-gold classes;
- correct existing pickup and warning sounds;
- deterministic 20% thinning of newly selected non-gold floor drops, with gold's absolute drop behavior unchanged;
- full server, simulation, persistence, browser-module, source, and UI test suites.
