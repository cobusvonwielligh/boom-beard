// The nightly restart, as a pure decision.
//
// Kept in its own module with no clock, no socket and no server in it, because every interesting
// case here is "what time is it and who is connected" - and a test that has to fake a Date to ask
// that question stops being a test of the rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWindow, shouldRestartNow, UPTIME_FLOOR_MS } from '../server/nightly-restart.js';

const night = { from: 23, to: 2 };
const up = UPTIME_FLOOR_MS + 1;

test('nightly restart window parsing', async t => {
  await t.test('parses an hour window that wraps midnight', () => {
    assert.deepEqual(parseWindow('23-2'), { from: 23, to: 2 });
    assert.deepEqual(parseWindow('1-5'), { from: 1, to: 5 });
    assert.deepEqual(parseWindow(' 23 - 2 '), { from: 23, to: 2 });
  });

  await t.test('blank or unparseable input disables it', () => {
    for (const bad of ['', '   ', undefined, null, 'nonsense', '23', '23-', '-2', 'a-b', '23-2-4']) {
      assert.equal(parseWindow(bad), null, `parseWindow(${JSON.stringify(bad)}) should be null`);
    }
  });

  await t.test('hours outside 0-23 are refused rather than clamped', () => {
    // Silently clamping 25 to 23 would give a server a restart window its operator never asked
    // for. A refusal leaves the feature off, which is the safe direction.
    for (const bad of ['24-2', '23-24', '-1-2', '23-99']) {
      assert.equal(parseWindow(bad), null, `parseWindow('${bad}') should be null`);
    }
  });

  await t.test('a single-hour window is allowed', () => {
    assert.deepEqual(parseWindow('3-3'), { from: 3, to: 3 });
  });
});

test('nightly restart decision', async t => {
  await t.test('fires inside a wrapping window with nobody connected', () => {
    for (const hour of [23, 0, 1]) {
      assert.equal(shouldRestartNow({ hour, humans: 0, uptimeMs: up, window: night }), true,
        `should have fired at ${hour}:00`);
    }
  });

  await t.test('never fires outside the window', () => {
    for (const hour of [2, 3, 4, 11, 12, 21, 22]) {
      assert.equal(shouldRestartNow({ hour, humans: 0, uptimeMs: up, window: night }), false,
        `should not have fired at ${hour}:00`);
    }
  });

  await t.test('a non-wrapping window behaves the same way', () => {
    const day = { from: 3, to: 5 };
    for (const hour of [3, 4]) {
      assert.equal(shouldRestartNow({ hour, humans: 0, uptimeMs: up, window: day }), true,
        `should have fired at ${hour}:00`);
    }
    for (const hour of [2, 5, 6, 23, 0]) {
      assert.equal(shouldRestartNow({ hour, humans: 0, uptimeMs: up, window: day }), false,
        `should not have fired at ${hour}:00`);
    }
  });

  /* The `to` hour is EXCLUSIVE, so "23-2" means 23:00, 00:00 and 01:00 and stops at 02:00.
   * An inclusive end would make a four-hour window out of a three-hour spelling. */
  await t.test('the end hour is exclusive', () => {
    assert.equal(shouldRestartNow({ hour: 2, humans: 0, uptimeMs: up, window: night }), false);
    assert.equal(shouldRestartNow({ hour: 1, humans: 0, uptimeMs: up, window: night }), true);
  });

  await t.test('a single-hour window covers exactly that hour', () => {
    const one = { from: 3, to: 3 };
    assert.equal(shouldRestartNow({ hour: 3, humans: 0, uptimeMs: up, window: one }), true);
    for (const hour of [2, 4, 23, 0]) {
      assert.equal(shouldRestartNow({ hour, humans: 0, uptimeMs: up, window: one }), false);
    }
  });

  await t.test('never fires with a human connected', () => {
    for (const humans of [1, 2, 16]) {
      assert.equal(shouldRestartNow({ hour: 23, humans, uptimeMs: up, window: night }), false,
        `${humans} people were playing`);
    }
  });

  /* An uptime floor, so a server that is crash-looping inside the window does not also
   * restart-loop. Without it a boot at 23:05 that takes ten seconds to come up would be told to
   * shut down again immediately, forever. */
  await t.test('never fires before the uptime floor', () => {
    for (const uptimeMs of [0, 1000, UPTIME_FLOOR_MS - 1]) {
      assert.equal(shouldRestartNow({ hour: 23, humans: 0, uptimeMs, window: night }), false,
        `fired after only ${uptimeMs} ms of uptime`);
    }
    assert.equal(shouldRestartNow({ hour: 23, humans: 0, uptimeMs: UPTIME_FLOOR_MS, window: night }), true);
  });

  await t.test('is off without a window', () => {
    for (const window of [null, undefined]) {
      assert.equal(shouldRestartNow({ hour: 23, humans: 0, uptimeMs: up, window }), false);
    }
  });

  await t.test('a negative or absent human count is treated as nobody', () => {
    // room.stats() gives players and bots separately; bots can briefly outnumber the seats the
    // subtraction reads, and a negative must not read as "somebody is here".
    assert.equal(shouldRestartNow({ hour: 23, humans: -1, uptimeMs: up, window: night }), true);
    assert.equal(shouldRestartNow({ hour: 23, uptimeMs: up, window: night }), true);
  });
});

test('the server consults the decision and reuses the existing clean shutdown', async () => {
  const { readFile } = await import('node:fs/promises');
  const index = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');

  assert.match(index, /shouldRestartNow/, 'server/index.js never asks the decision');
  /* SIGTERM, not a second shutdown path. The existing handler banks the round, awaits the
   * leaderboard save and then exits, and `Restart=always` in the unit brings the new process up.
   * A separate exit here would be a second way to stop the server that nothing else tests. */
  assert.match(index, /SIGTERM'\)|'SIGTERM'/, 'the restart does not go through SIGTERM');
  assert.doesNotMatch(index, /shouldRestartNow[\s\S]{0,400}process\.exit/,
    'the nightly restart exits directly instead of reusing the SIGTERM path');
});

test('the restart window is configurable and off by default', async () => {
  const { readFile } = await import('node:fs/promises');
  const config = await readFile(new URL('../server/config.js', import.meta.url), 'utf8');
  const example = await readFile(new URL('../config.example.ini', import.meta.url), 'utf8');

  assert.match(config, /nightlyRestart/, 'config exposes no nightlyRestart');
  assert.match(config, /NIGHTLY_RESTART'[^\n]*'server'[^\n]*'nightly_restart'[^\n]*''/,
    'the knob is not env-overridable, or is not blank by default');
  assert.match(example, /nightly_restart/, 'config.example.ini does not document the knob');
});

/* The one piece of arithmetic in the wiring, against a real room.
 *
 * `players - bots` is how the server turns room.stats() into a human count, and the tests above
 * only read source text. If stats() ever stops reporting those two fields, or starts counting
 * bots outside `players`, the restart would either never fire or fire on a room full of people -
 * and nothing else in the suite would notice.
 */
test('players minus bots is the human count a real room reports', async () => {
  const { createRoom } = await import('../server/room.js');
  const room = createRoom({ countIn: 0, onBroadcast: () => {} });
  try {
    const humans = () => {
      const { players = 0, bots = 0 } = room.stats();
      return players - bots;
    };
    assert.equal(humans(), 0, 'an empty room already reports somebody');

    room.join('human-id', 'ann');
    assert.equal(humans(), 1, 'a joined player is not counted as a human');

    // Bots must never hold the server open overnight. Added unconditionally: a `?.` here would
    // let the whole assertion vanish silently the day the API is renamed.
    room.setBots(3);
    assert.equal(room.stats().bots, 3, 'the bots are not reported as bots');
    assert.equal(humans(), 1, 'a bot was counted as a human');

    // And with the person gone, a room of nothing but bots reads as empty.
    room.disconnect(0);
    assert.equal(humans(), 0, `a room of ${room.stats().bots} bots reads as occupied`);
  } finally {
    room.stop();
  }
});
