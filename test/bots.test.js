// Bots, measured the way STATUS.md quotes them: per bot per minute, over every map.
//
// Bot thinking uses Math.random, so this is a tripwire for a regression of the size that matters,
// not a benchmark. Ten minutes per map gives the kill-rate threshold enough samples to be useful.
// For real numbers: node server/botbench.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { bench } from '../server/botbench.js';

test('bots mostly die to each other, not to themselves', () => {
  /* Suicides are the number to push down; kills are the number that must not collapse while you
   * do it, because a bot that never bombs never dies and is also no fun to play against.
   *
   * The kill floor is 0.15 and it was 0.2, which was sitting ON the measurement. The bench seeds
   * a fresh room per map, so the figure moves between runs: ten-minute runs of the same code
   * measured 0.197, 0.225, 0.231 and 0.236 kills per bot per minute, and the assertion failed or
   * passed accordingly - about half the time, on code that had not changed. A threshold inside the
   * noise is not a test of anything. 0.15 still catches the failure this exists for, which is bots
   * going quiet altogether, and it is an order of magnitude away from the suicide rate.
   */
  const { totals } = bench({ minutes: 10, bots: 15 });
  const perMin = n => n / totals.botMinutes;
  assert.ok(perMin(totals.suicides) < 0.6, `suicides ${perMin(totals.suicides).toFixed(2)}/bot/min`);
  assert.ok(perMin(totals.kills) > 0.15, `kills ${perMin(totals.kills).toFixed(2)}/bot/min - bots stopped fighting`);
});
