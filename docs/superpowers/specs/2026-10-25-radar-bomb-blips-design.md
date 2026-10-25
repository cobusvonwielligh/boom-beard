# Radar Bomb Blips Design

## Goal

Warn the local player about nearby bombs on the radar rim with a clear, escalating triangle that is immediately distinguishable from enemy-player blips.

## Design

Keep existing enemy blips unchanged: they remain maroon, elongated rim slithers with a pale center thread. Draw each bomb as a solid filled triangle with a fine pale outline and a subtle color-matched glow; do not add a separate fuse bar, interior meter, or countdown text. Orient the triangle tip toward the radar center. Begin green (`#56e38c`) and interpolate smoothly to danger red (`#ff334d`), reaching red at 80% of the fuse elapsed and remaining red through detonation. Increase the marker size smoothly from 9 to 17 screen pixels over its fuse. Flash the marker progressively faster, from 1.8 Hz at placement to 9.8 Hz near detonation, by pulsing its brightness and glow. Keep its visibility above 45% throughout the pulse so it never disappears between flashes. The growing size, accelerating pulse, and color transition together communicate urgency.

For each frame, select bombs whose center is within a circular radius of ten tiles from the local player's current position, regardless of intervening walls. Rank eligible bombs by distance and show no more than the three nearest. Position each marker by projecting the bomb center onto the radar rim using the existing rounded-rim projection. Existing player indicators and tracking behavior remain unchanged.

Use each bomb's existing ID, tile coordinates, scheduled detonation tick (`at`), and original fuse duration, together with `world.tick`, for marker identity, position, size, pulse, and color. Record the original fuse duration on the bomb at placement so fast-fuse bombs also start at the beginning of their visual progression; use the standard fuse duration only as a fallback for older bomb data. Remove a marker when the bomb is removed from `world.bombs` or bursts. Do not leave it visible during the explosion.

## Implementation scope

Modify the radar rendering logic in `public/client/render.js`, reusing `rimPath`, `world.me()`, and `world.bombs`. Put the pure bomb selection, fuse progress, size, color, and pulse-rate calculations in `public/client/radar.js` so their distance boundary, nearest-three cap, and urgency progression can be tested directly in Node. Keep bomb tracking state separate from per-seat enemy-blip state so the two types cannot share or exchange pulse phases. Prune stale bomb state when bombs disappear, and keep the marker cap at three even when more nearby bombs are present.

## Verification

Add focused tests for:

- Bombs at the ten-tile boundary being eligible, bombs beyond it being excluded, and diagonals using circular distance.
- At most three eligible bombs being shown, selected by nearest distance.
- Bomb pulse rate increasing as remaining fuse ticks decrease.
- Triangle growth from 9 to 17 screen pixels through the fuse and pulse rate increasing from 1.8 to 9.8 Hz.
- Green-to-red color progression reaching red at 80% elapsed and remaining red through detonation.
- Triangle pulse brightness staying above 45% so the marker remains continuously visible.
- A bomb marker being removed when the bomb is removed or bursts.
- Enemy blip rendering/state remaining independent of bomb indicators.

Run the focused tests, `node --check public/client/render.js`, and the browser module graph test (`node --test test/client-modules.test.js`).

The landing card should fit without vertical scrolling at 100% zoom at viewports at least 768 CSS px wide and 720 CSS px tall. On short supported screens, reflow the controls into two key/action pairs per row and make modest spacing reductions; below either minimum, retain the existing scroll fallback rather than clipping content or shrinking it excessively.
