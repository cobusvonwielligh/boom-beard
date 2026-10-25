// Fire kills on a box smaller than the sprite. See HITBOX_FIRE_NUM.
//
// The case that matters is hiding: a shoulder past the edge of a wall is not a death, a body in
// the blast is. Both assertions are needed - a grace wide enough to survive the blast itself
// would be worse than no grace at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIRE_TICKS, BLOCK, HITBOX_UNITS, HITBOX_FIRE_NUM, HITBOX_FIRE_DEN, MAX_HP,
} from '../shared/constants.js';
import { MAPS } from '../shared/maps.js';
import { createState, createPlayer, tileCentre, tileAt } from '../shared/sim/state.js';
import { tick } from '../shared/sim/round.js';

/** A player `nudge` units right of a floor tile centre, with the tile to their right on fire. */
function hiding(nudge) {
  const s = createState(MAPS[0]);
  let at = null;
  for (let ty = 1; ty < s.map.h - 1 && !at; ty++) {
    for (let tx = 1; tx < s.map.w - 2; tx++) {
      if (tileAt(s.map, tx, ty) === BLOCK.FLOOR && tileAt(s.map, tx + 1, ty) === BLOCK.FLOOR) {
        at = { tx, ty }; break;
      }
    }
  }
  const p = createPlayer(0, 'you');
  p.alive = true; p.x = tileCentre(at.tx) + nudge; p.y = tileCentre(at.ty);
  s.players[0] = p;
  s.players[5] = createPlayer(5, 'them');
  s.fires.push({
    tx: at.tx + 1, ty: at.ty, kind: 'arm', rot: 0, until: s.tick + FIRE_TICKS, owner: 5, src: 101,
  });
  tick(s, new Array(16).fill(0));
  return p;
}

const spriteHalf = HITBOX_UNITS >> 1;
const fireHalf = ((HITBOX_UNITS * HITBOX_FIRE_NUM / HITBOX_FIRE_DEN) | 0) >> 1;

test('a sliver of sprite in the fire tile is not a death', () => {
  // Past the tile edge by the sprite, short of it by the lethal box.
  const nudge = (128 - spriteHalf) + ((spriteHalf - fireHalf) >> 1);
  assert.ok(nudge > 128 - spriteHalf && nudge < 128 - fireHalf, 'test nudge is in the grace band');
  assert.equal(hiding(nudge).hp, MAX_HP, 'the grace band is not being applied');
});

// "Dies" is "is hit" since health arrived: a whole pirate loses half, not his life. See MAX_HP.
test('a body in the fire tile is still hit', () => {
  assert.ok(hiding(128 - fireHalf + 8).hp < MAX_HP, 'the grace swallowed a real hit');
});
