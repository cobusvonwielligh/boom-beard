# Killstreak Bomb Power and HUD Placement Design

## Goal

Make an active kill streak visibly and mechanically matter while keeping the result identical on the server and predicting clients. Keep the music and performance panels inside the game frame without covering its radar rim.

## Killstreak behavior

Reuse the existing streak rule: a player reaches an active streak on their second kill within `STREAK_WINDOW_TICKS` (six seconds), and remains active until more than six seconds pass after their most recent kill. Dying resets the streak. Apply the same rainbow styling already used by streak announcements to the streaking player's visible name, including the local HUD name and named player UI.

## Bomb power and damage

A bomb placed while its owner has an active streak records that fact at placement. It retains its power through its fuse and chain reactions; bombs already placed before the streak are not upgraded retroactively. A powder keg chain-created by an empowered blast inherits that blast's power and owner, consistent with its existing kill-credit behavior.

An empowered fire source applies two damage units the first time it hits a player: shields are spent first, then health, then the hit is lethal if no defense remains. A source still counts only once per player, and the existing invulnerability, lethal-window, hitbox, and shield-grace rules continue to apply. The second unit is part of that one hit rather than a second later tick, so the existing grace period cannot erase the requested double damage.

The shared simulation owns streak count and last-kill tick so placement, damage, and prediction use the same state. Carry the fields in player snapshots and determinism hashing. Store the empowered flag on each bomb and copy it to its fire. Render empowered flames with a smoothly animated rainbow cycle using the existing fire shapes and timing; ordinary fire remains owner-colored.

## HUD placement

Keep the music dock at the lower-left and the performance counters at the lower-right, but inset both from the corresponding lower corners of `canvas#game` so neither touches or paints over its radar rim. Derive offsets from the existing `--gap` and `--side` layout variables so the placement follows the canvas at desktop and compact widths. On very narrow screens, stack the performance badge above the music dock.

Set the control-panel background fills to 33% opacity while preserving full-opacity text, icons, borders, and focus indicators. Apply the same translucency to the music-volume flyout.

## Verification

Add simulation tests for streak activation on the second timely kill, expiry after the existing window, reset on death, and deterministic state hashing. Add bomb tests proving placement captures active streak power and preserves it through detonation and chains. Add damage tests for two defense units being consumed in shield-first order, lethal damage, once-per-source behavior, and unchanged grace/invulnerability behavior. Add focused fire-tone tests confirming rainbow colors vary over animation time while standard fire retains owner colors.

Run the focused streak, bomb, damage, artwork, and client-module tests, then the full test suite. Validate the HUD offsets and panel opacity in the browser at desktop, compact, and narrow widths; confirm the controls remain inside the canvas frame without colliding.
