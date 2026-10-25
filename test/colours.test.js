// Player colours belong to the player, not the seat number - see COLOUR_PREFERENCE.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoom } from '../server/room.js';
import { COLOUR_PREFERENCE, DISTINCT_PLAYERS, isDistinctColour, setSeatColours, playerColorName }
  from '../shared/constants.js';

const room = () => createRoom({ countIn: 0, onBroadcast: () => {} });
const palOf = r => r.welcomeFor(-1).pal;
const slotsIn = (r, pal = palOf(r)) =>
  r.state.players.map((p, i) => (p ? parseInt(pal[i], 16) : null)).filter(k => k !== null);

test('up to eight players all wear one of the eight distinct colours, no two alike', () => {
  const r = room();
  try {
    for (let n = 0; n < DISTINCT_PLAYERS; n++) r.join(`p${n}`, `player${n}`);
    const slots = slotsIn(r);
    assert.equal(new Set(slots).size, slots.length, 'two players share a colour');
    for (const k of slots) assert.ok(isDistinctColour(k), `slot ${k} is not one of the distinct eight`);
  } finally { r.stop(); }
});

test('fragmented seats still get distinct colours', () => {
  const r = room();
  try {
    // Fill twelve seats, then empty most of them, so the survivors sit in scattered seats.
    for (let n = 0; n < 12; n++) r.join(`p${n}`, `player${n}`);
    for (const seat of [0, 2, 3, 4, 5, 7, 8, 10]) r.kickSeat(seat);
    // A newcomer takes the lowest free seat, and a distinct colour nobody is wearing.
    const { seat } = r.join('new', 'newcomer');
    const pal = palOf(r);
    const mine = parseInt(pal[seat], 16);
    assert.ok(isDistinctColour(mine));
    const others = slotsIn(r, pal).filter((_, i, all) => i !== all.indexOf(mine));
    assert.ok(!others.includes(mine), 'the newcomer was given a colour already in use');
  } finally { r.stop(); }
});

test('colours never change mid-round, and settle onto the distinct eight between rounds', () => {
  const r = room();
  try {
    for (let n = 0; n < 12; n++) r.join(`p${n}`, `player${n}`);
    for (const seat of [0, 1, 2, 3, 4, 5, 6, 7]) r.kickSeat(seat);
    const before = palOf(r);
    r.tick();
    assert.equal(palOf(r), before, 'a colour moved mid-round');
    // Seats 8-11 were wearing the second-tier colours; a new round puts them on distinct ones.
    assert.ok(slotsIn(r).some(k => !isDistinctColour(k)), 'test setup: expected a non-distinct colour');
    r.restartRound();
    const slots = slotsIn(r);
    assert.equal(new Set(slots).size, slots.length);
    for (const k of slots) assert.ok(isDistinctColour(k));
  } finally { r.stop(); }
});

test('the first two players are red and cyan', () => {
  const r = room();
  try {
    r.join('a', 'alice');
    r.join('b', 'bob');
    assert.deepEqual(slotsIn(r), COLOUR_PREFERENCE.slice(0, 2));
  } finally { r.stop(); }
});

test('the client adopts the table, and ignores garbage', () => {
  try {
    assert.equal(setSeatColours('f'), true);
    assert.equal(playerColorName(0), 'white');
    assert.equal(setSeatColours('not hex!'), false);
    assert.equal(playerColorName(0), 'white');
  } finally { setSeatColours('0123456789abcdef'); }
});
