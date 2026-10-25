# Visible Block Chamfer Design

## Goal

Make the whole visible silhouette of the appropriate solid map blocks more chamfered, rather than changing only an inset face, bevel detail, or collision behavior.

## Design

Increase the outer silhouette radius from 6 to 8 CSS pixels for the block types already designated for rounded terrain: soft, reinforced, monolith, and inland iron. Apply the radius to the outer clipping path that masks the complete tile artwork, and keep the rendered shadow and secondary masks consistent with that silhouette so they do not make a rounded block appear square.

Do not alter collision rules. Do not apply this radius indiscriminately to columns, kegs, shrubs, ice, or water. Iron blocks at the coast retain their existing coast-shaped clipping; only their exposed inland corners use the rounded radius. Adjacent solid wall edges remain joined rather than becoming isolated lozenges.

## Verification

Test the actual `drawTile` clipping call for each rounded block type, verify the renderer uses matching outer masks and shadows only for those types, and inspect a live map containing crates, reinforced blocks, monoliths, inland iron, and coastline rocks. Confirm the complete block silhouettes are chamfered, non-target objects remain unchanged, and collision behavior is untouched.
