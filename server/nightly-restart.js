// Should the server shut itself down right now so systemd can bring it back fresh?
//
// A pure decision, deliberately in its own file with no clock and no sockets in it. Every
// interesting question here is "what hour is it and who is connected", and the version that
// reaches for `new Date()` and `hub.health()` itself cannot be tested without faking both.
// server/index.js supplies the facts once a minute; this file only ever answers.
//
// The restart exists because the long-lived process is the thing most likely to have quietly
// accumulated something over a day of play. It is NOT the fix for the client-side frame cost
// described in docs/superpowers/specs/2026-11-06-rails-kick-and-tuning-design.md - that is a
// different problem with a different cause, and this one is a janitor.

/* Long enough that a crash loop inside the window cannot become a restart loop.
 *
 * Without it, a boot at 23:05 that takes ten seconds to come up is immediately told to shut down
 * again, forever, and the box looks exactly like a server that will not start. An hour is far
 * longer than needed to break that cycle and still leaves a three-hour window with three chances
 * in it on any normal night.
 */
export const UPTIME_FLOOR_MS = 60 * 60 * 1000;

/**
 * Parse an `H-H` hour range. Returns `{ from, to }`, or null for anything else.
 *
 * `to` is EXCLUSIVE: `23-2` is 23:00, 00:00 and 01:00. An inclusive end would quietly make a
 * four-hour window out of a three-hour spelling. The one exception is `from === to`, which is a
 * single hour rather than an empty range - nobody writes `3-3` meaning "never".
 *
 * Out-of-range hours are REFUSED rather than clamped. Clamping `25-2` to `23-2` would hand a
 * server a restart window its operator never asked for; refusing leaves the feature off, which
 * is the safe direction for a typo in a config file.
 */
export function parseWindow(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return null;
  const from = Number(m[1]), to = Number(m[2]);
  if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
  if (from < 0 || from > 23 || to < 0 || to > 23) return null;
  return { from, to };
}

/** Is `hour` inside the window? Handles a window that wraps past midnight. */
function inWindow(hour, { from, to }) {
  if (from === to) return hour === from;
  return from < to ? hour >= from && hour < to : hour >= from || hour < to;
}

/**
 * The whole rule, in one place.
 *
 * @param hour      local hour, 0-23, from the server's own clock
 * @param humans    connected players that are not bots. Bots must never hold the server open.
 * @param uptimeMs  how long this process has been up
 * @param window    from parseWindow, or null to disable
 */
export function shouldRestartNow({ hour, humans = 0, uptimeMs = 0, window } = {}) {
  if (!window) return false;
  // Negative is possible: `players` and `bots` come from separate counts in room.stats(), and a
  // moment where bots outnumber the occupied seats must read as "nobody here", not as "somebody".
  if (humans > 0) return false;
  if (uptimeMs < UPTIME_FLOOR_MS) return false;
  return inWindow(hour, window);
}
