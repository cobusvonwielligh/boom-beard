import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdminData, createMetricHistory } from '../server/admin-data.js';

const DAY = 24 * 60 * 60_000;
const now = Date.UTC(2026, 5, 20, 12);
const stamp = (daysAgo, hour = 12) => now - daysAgo * DAY + (hour - 12) * 60 * 60_000;
const day = daysAgo => new Date(stamp(daysAgo)).toISOString().slice(0, 10);

function dataFor(accounts, careers = []) {
  return createAdminData({
    accounts: { listForAdmin: () => accounts },
    leaderboard: { all: () => careers },
    metrics: { history: () => [{ at: now, cpuPct: 12, memoryPct: 3, diskPct: 70 }] },
    now: () => now,
  });
}

test('admin player rows join lifetime stats by normalized name and paginate safely', () => {
  const data = dataFor([
    { name: 'CobusVW', created: stamp(0), lastSeen: stamp(0, 11) },
    { name: 'new-player', created: stamp(1), lastSeen: null },
    { name: 'quiet-player', created: stamp(2), lastSeen: null },
  ], [{
    playerId: 'private-id',
    name: 'cobusvw',
    score: 850,
    xp: 850,
    level: 2,
    tier: 'Rookie',
    kills: 12,
    deaths: 4,
    coins: 5,
    gold: 1,
    silver: 2,
    bronze: 3,
  }]);

  const first = data.players({ page: 1, pageSize: 2 });
  assert.equal(first.total, 3);
  assert.equal(first.pages, 2);
  assert.deepEqual(first.items.map(player => player.name), ['CobusVW', 'new-player']);
  assert.equal(first.items[0].xp, 850);
  assert.equal(first.items[0].score, 850);
  assert.equal(first.items[0].level, 2);
  assert.equal(first.items[0].playerId, undefined);
  assert.equal(first.items[1].xp, 0);

  const filtered = data.players({
    from: day(1), to: day(0), search: 'COBUS', sort: 'xp', direction: 'desc',
  });
  assert.deepEqual(filtered.items.map(player => player.name), ['CobusVW']);
});

test('admin player date filters reject invalid and reversed dates', () => {
  const data = dataFor([]);
  assert.throws(() => data.players({ from: '2026-02-30' }), /date/);
  assert.throws(() => data.players({ from: day(1), to: day(2) }), /date range/);
});

test('registration history compares the selected period with the previous equal period', () => {
  const data = dataFor([
    { name: 'today', created: stamp(0) },
    { name: 'two-days-ago', created: stamp(2) },
    { name: 'previous-period', created: stamp(8) },
  ]);
  const series = data.registrations({ period: '7' });

  assert.equal(series.days.length, 7);
  assert.equal(series.currentTotal, 2);
  assert.equal(series.previousTotal, 1);
  assert.equal(series.change, 1);
  assert.equal(series.changePct, 100);
  assert.equal(series.direction, 'up');
  assert.equal(series.days.at(-1).date, day(0));
});

test('registration history marks a first increase as new when the previous period was empty', () => {
  const data = dataFor([{ name: 'first', created: stamp(0) }]);
  const series = data.registrations({ period: '7' });

  assert.equal(series.previousTotal, 0);
  assert.equal(series.change, 1);
  assert.equal(series.changePct, null);
  assert.equal(series.direction, 'up');
});

test('admin metrics are returned from the bounded resource-history provider', () => {
  const data = dataFor([]);
  assert.deepEqual(data.metrics(), [{ at: now, cpuPct: 12, memoryPct: 3, diskPct: 70 }]);
});

test('geography summaries and static country boundaries are exposed to the admin UI', () => {
  const geography = {
    summary: ({ period }) => ({ period, countries: [{ country: 'US', hits: 3, registrations: 1 }] }),
  };
  const map = [{ country: 'US', name: 'United States of America', path: 'M0,0L1,1Z' }];
  const data = createAdminData({
    accounts: { listForAdmin: () => [] },
    leaderboard: { all: () => [] },
    metrics: { history: () => [] },
    geography,
    worldMap: () => map,
  });

  assert.deepEqual(data.geography({ period: '7' }), {
    period: '7', countries: [{ country: 'US', hits: 3, registrations: 1 }],
  });
  assert.deepEqual(data.worldMap(), map);
});

test('resource samples are timestamped, copied, and pruned after the retention window', () => {
  let at = 100;
  const history = createMetricHistory(
    () => ({ cpuPct: 1.5, memoryPct: 2.5, diskPct: null }),
    { intervalMs: 60_000, retentionMs: 1000, now: () => at },
  );
  assert.deepEqual(history.history(), [
    { at: 100, cpuPct: 1.5, memoryPct: 2.5, diskPct: null },
  ]);
  at = 1101;
  assert.deepEqual(history.history(), []);
  history.stop();
});
