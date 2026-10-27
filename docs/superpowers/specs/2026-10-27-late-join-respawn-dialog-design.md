# Late-Join Respawn Dialog Design

## Goal

When a player joins an already-running round for the first time, keep the shop and
respawn dialog open with the Respawn button ready immediately. After the player
clicks Respawn, close the dialog and show an animated 3, 2, 1 countdown. Spawn the
player as soon as the server-owned 4.5-second countdown ends.

## Decision

Reuse the existing `#countIn` overlay for personal respawn countdowns. The server's
pending-respawn ticks remain authoritative. Preserve the existing shared round
count-in when it is active; a personal countdown takes over after the shared
count-in ends. Hide the death/shop dialog once a respawn request is accepted.

The existing server `respawn()` path remains unchanged. It applies the spawn pop
and ring animation event and grants the current 3-second invulnerability effect.
The 11-second death cooldown and the 4.5-second post-click countdown do not change.

## Alternatives

- Add a separate respawn overlay. This duplicates the existing animated counter
  and risks overlapping it with the round count-in.
- Use a client-only timer. This can drift from server placement and is rejected.

## Verification

Cover late-join readiness, dialog dismissal after an accepted request, 3-2-1
display from the server countdown, spawn timing, and retained invulnerability and
spawn event in tests. Run focused tests and the local full suite. Do not rely on CI.
