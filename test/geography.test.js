import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGeography } from '../server/geography.js';

const DAY = 24 * 60 * 60_000;

function dataDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-geography-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('geography stores only daily country aggregates for page hits and registrations', async t => {
  const dir = dataDir(t);
  const ipCountries = new Map([
    ['198.51.100.10', 'US'],
    ['203.0.113.5', 'ZA'],
  ]);
  const geography = createGeography({
    dataDir: dir,
    lookupCountry: ip => ipCountries.get(ip) ?? null,
    now: () => Date.UTC(2026, 9, 27, 12),
  });
  t.after(() => geography.stop());

  geography.recordHit('198.51.100.10');
  geography.recordHit('198.51.100.10');
  geography.recordRegistration('198.51.100.10');
  geography.recordRegistration('203.0.113.5');
  geography.recordHit('127.0.0.1');
  geography.flushSync();

  assert.deepEqual(geography.summary({ period: '7' }), {
    period: '7',
    from: '2026-10-21',
    to: '2026-10-27',
    totalHits: 2,
    totalRegistrations: 2,
    countries: [
      { country: 'US', hits: 2, registrations: 1 },
      { country: 'ZA', hits: 0, registrations: 1 },
    ],
  });

  const stored = fs.readFileSync(path.join(dir, 'geography.json'), 'utf8');
  assert.doesNotMatch(stored, /198\.51\.100\.10|203\.0\.113\.5|cobusvw/i);

  const reloaded = createGeography({
    dataDir: dir,
    lookupCountry: () => null,
    now: () => Date.UTC(2026, 9, 27, 12),
  });
  t.after(() => reloaded.stop());
  assert.deepEqual(reloaded.summary({ period: '7' }), geography.summary({ period: '7' }));
});

test('country analytics accepts IPv4-mapped addresses but discards unknown locations', t => {
  const dir = dataDir(t);
  let lookedUp = '';
  const geography = createGeography({
    dataDir: dir,
    lookupCountry: ip => { lookedUp = ip; return ip === '192.0.2.1' ? 'CA' : null; },
    now: () => Date.UTC(2026, 9, 27),
  });
  t.after(() => geography.stop());

  assert.equal(geography.recordHit('::ffff:192.0.2.1'), true);
  assert.equal(lookedUp, '192.0.2.1');
  assert.equal(geography.recordHit('127.0.0.1'), false);
  assert.equal(geography.recordHit('not-an-ip'), false);
  assert.deepEqual(geography.summary({ period: '7' }).countries,
    [{ country: 'CA', hits: 1, registrations: 0 }]);
});

test('country analytics discards aggregates outside the retention window', t => {
  let now = Date.UTC(2026, 9, 27, 12);
  const dir = dataDir(t);
  const geography = createGeography({
    dataDir: dir,
    lookupCountry: () => 'US',
    now: () => now,
  });
  t.after(() => geography.stop());

  geography.recordHit('198.51.100.10');
  geography.flushSync();
  now += 366 * DAY;

  const reloaded = createGeography({
    dataDir: dir,
    lookupCountry: () => 'US',
    now: () => now,
  });
  t.after(() => reloaded.stop());
  assert.deepEqual(reloaded.summary({ period: 'all' }).countries, []);
  reloaded.flushSync();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'geography.json'), 'utf8')).days, {});
});
