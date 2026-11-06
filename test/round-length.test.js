// A round is six minutes, down from ten.
//
// The constant is one line to change; the reason this file exists is everything that was tuned
// as a FRACTION of the round and therefore moved when it did. A schedule expressed as 0.7 of the
// round is not wrong at six minutes, but it is forty percent earlier in wall-clock terms than it
// was when it was tuned, and the ones that have to stay in order can now cross.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUND_TICKS, TICK_HZ, GULL_RAID_AT_MIN, GULL_RAID_AT_MAX,
  GULL_RAID_LATE_JOIN_FRACTION, GULL_FIRST_TICK,
} from '../shared/constants.js';

test('round length', async t => {
  await t.test('a round is six minutes', () => {
    assert.equal(ROUND_TICKS, 6 * 60 * TICK_HZ);
  });

  await t.test('the first gull arrives well before the round ends', () => {
    assert.ok(GULL_FIRST_TICK < ROUND_TICKS / 4,
      `the first gull is at ${GULL_FIRST_TICK} of a ${ROUND_TICKS}-tick round`);
  });

  // The raid picks a target from the players who joined before the cutoff, so the cutoff has to
  // be settled before the earliest the raid can launch. At ten minutes these were far apart and
  // nobody had to think about it.
  await t.test('the raid window lands inside the round and after the late-join cutoff', () => {
    const earliest = ROUND_TICKS * GULL_RAID_AT_MIN;
    const latest = ROUND_TICKS * GULL_RAID_AT_MAX;
    const cutoff = ROUND_TICKS * GULL_RAID_LATE_JOIN_FRACTION;
    assert.ok(cutoff < earliest, 'late joiners must be settled before the raid picks a target');
    assert.ok(latest < ROUND_TICKS, 'the raid must land before the round ends');
  });
});
