# Landing Title Size Design

## Goal

Make the landing-page Boom Beard wordmark comically larger while keeping the entire artwork visible and preserving a usable, non-clipped landing layout.

## Design

Double the title artwork's current width multiplier from 6.6 to 13.2, retaining the existing viewport-width cap and centered alignment. Raise the artwork 8 CSS pixels from its current baseline. Expand the title's reserved layout space responsively so the enlarged artwork is not clipped at the top and does not overlap the slogan or controls. Keep the existing compact-screen behavior and vertical-scroll fallback below the supported viewport minimum rather than clipping the card.

The title image, accessible name, wordmark artwork, and existing responsive scale tiers remain unchanged apart from this size and placement adjustment.

## Verification

Use the browser to inspect the title bounds and card layout at 1152×1080 and at the supported compact minimum of 768×720 CSS pixels. Confirm that the wordmark is approximately twice its previous width when the viewport permits, remains fully visible, sits slightly higher, does not overlap the slogan or controls, and does not introduce vertical overflow at the supported minimum. Confirm smaller viewports retain the existing scroll fallback.
