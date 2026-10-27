// Health has to reach the client: your own pirate and everybody else's. See MAX_HP.
//
// The client's world.js copies the server's state in two places - hydrate() for other players
// and reconcile() for you - and health was once only in the first, so your own pirate never went
// to half on your own screen. world.js imports with browser paths ('/shared/...'), so this test
// maps those onto the repository before importing it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { MAX_HP, RESPAWN_COUNTDOWN_TICKS } from '../shared/constants.js';
import { MAPS, buildMap, encodeCells } from '../shared/maps.js';
import { createRoom } from '../server/room.js';

const root = pathToFileURL(process.cwd() + '/').href;
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec.startsWith('/shared/')) return next(new URL('.' + spec, ${JSON.stringify(root)}).href, ctx);
    return next(spec, ctx);
  }`));
const { createWorld } = await import('../public/client/world.js');

function worldWith(players, you = 0) {
  const w = createWorld();
  const map = buildMap(MAPS[0]);
  w.applyWelcome({
    you, tick: 10, map: { id: 'm', w: map.w, h: map.h, cells: encodeCells(map.cells), spawns: [] },
    players: players.map(p => ({ ...p, name: `p${p.i}` })), bombs: [], perks: [], puddles: [],
  });
  return w;
}
const wire = (i, extra = {}) => ({ i, x: 384, y: 384, d: 3, st: 1, b: 1, f: 1, sp: 0, sh: 0, s: 0, k: 0, dd: 0, stat: 0, ...extra });
const snap = (w, tick, players) => w.applySnap({ tick, ack: tick, players, bombs: [], perks: [], puddles: [], ev: [] });

test('your own pirate goes to half health, and back to whole', () => {
  const w = worldWith([wire(0), wire(1)]);
  assert.equal(w.me().hp, MAX_HP);
  snap(w, 11, [wire(0, { hp: 1 }), wire(1)]);
  assert.equal(w.me().hp, 1, 'your own half health never reached your own client');
  snap(w, 12, [wire(0), wire(1)]);
  assert.equal(w.me().hp, MAX_HP, 'a respawn did not make you whole again');
});

test('another pirate goes to half health', () => {
  const w = worldWith([wire(0), wire(1)]);
  snap(w, 11, [wire(0), wire(1, { hp: 1 })]);
  assert.equal(w.players[1].hp, 1);
  snap(w, 12, [wire(0), wire(1)]);
  assert.equal(w.players[1].hp, MAX_HP);
});

test('a remote respawn appears at its new position without showing its stale position', () => {
  const w = worldWith([wire(0), wire(1, { x: 700, y: 700, st: 0 })]);
  snap(w, 12, [wire(0), wire(1, { x: 700, y: 700, st: 0 })]);
  snap(w, 14, [wire(0), wire(1, { x: 700, y: 700, st: 0 })]);

  snap(w, 16, [wire(0), wire(1, { x: 2600, y: 700, st: 1 })]);

  assert.equal(w.players[1].alive, true);
  assert.equal(w.players[1].rx, 2600, 'the remote player briefly appeared at their old position');
  assert.equal(w.players[1].ry, 700);
  assert.deepEqual(w.players[1].buf.map(point => point.tick), [16],
    'pre-respawn snapshots remained in the interpolation buffer');
});

test('the server sends health only when it is not whole, and only for the living', () => {
  const sent = [];
  const r = createRoom({ countIn: 0, onBroadcast: m => { const x = typeof m === 'function' ? m(0) : m; if (x.t === 'snap') sent.push(x); } });
  try {
    const { seat } = r.join('a', 'alice');
    r.requestRespawn(seat);
    for (let i = 0; i <= RESPAWN_COUNTDOWN_TICKS; i++) r.tick();
    r.tick(); r.tick();
    const whole = sent.at(-1).players.find(p => p.i === seat);
    assert.equal(whole.hp, undefined, 'whole health was put on the wire');
    r.state.players[seat].hp = 1;
    r.tick(); r.tick();
    assert.equal(sent.at(-1).players.find(p => p.i === seat).hp, 1, 'half health never left the server');
  } finally { r.stop(); }
});
