# Radar Bomb Blips Design

## Goal

Warn the local player about nearby bombs on the radar rim while keeping bomb warnings immediately distinguishable from enemy-player blips.

## Design

Keep existing enemy blips unchanged: they remain maroon, elongated rim slithers with a pale center thread. Draw bombs as compact amber diamonds with a bright center and soft glow. Their smooth visual pulse accelerates as the fuse approaches detonation; do not add numeric countdown text or sound.

For each frame, select bombs whose center is within six tiles of the local player's current position, regardless of intervening walls. Rank eligible bombs by distance and show no more than the three nearest. Position each marker by projecting the bomb center onto the radar rim using the existing rounded-rim projection. Existing player indicators and tracking behavior remain unchanged.

Use each bomb's existing ID, tile coordinates, and scheduled detonation tick (`at`), together with `world.tick`, for marker identity, position, and fuse progress. Remove a marker when the bomb is removed from `world.bombs` or bursts. Do not leave it visible during the explosion.

## Implementation scope

Modify the radar rendering logic in `public/client/render.js`, reusing `rimPath`, `world.me()`, and `world.bombs`. Put the pure bomb selection and fuse pulse-rate calculations in `public/client/radar.js` so their distance boundary, nearest-three cap, and fuse progression can be tested directly in Node. Keep bomb tracking state separate from per-seat enemy-blip state so the two types cannot share or exchange pulse phases. Prune stale bomb state when bombs disappear, and keep the marker cap at three even when more nearby bombs are present.

## Verification

Add focused tests for:

- Bombs at the six-tile boundary being eligible, and bombs beyond it being excluded.
- At most three eligible bombs being shown, selected by nearest distance.
- Bomb pulse rate increasing as remaining fuse ticks decrease.
- A bomb marker being removed when the bomb is removed or bursts.
- Enemy blip rendering/state remaining independent of bomb indicators.

Run the focused tests, `node --check public/client/render.js`, and the browser module graph test (`node --test test/client-modules.test.js`).
