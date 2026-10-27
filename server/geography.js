import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';

const VERSION = 1;
const DAY_MS = 24 * 60 * 60_000;
const RETENTION_DAYS = 365;
const PERIODS = new Map([['7', 7], ['30', 30], ['90', 90], ['365', 365]]);
const COUNTRY_CODE = /^[A-Z]{2}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const dayLabel = at => new Date(at).toISOString().slice(0, 10);

function normalizedIp(value) {
  if (typeof value !== 'string') return null;
  const ip = value.startsWith('::ffff:') ? value.slice(7) : value;
  return isIP(ip) ? ip : null;
}

function cleanCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function createGeography({
  dataDir,
  lookupCountry,
  now = Date.now,
  flushEveryMs = 10_000,
} = {}) {
  const file = path.join(dataDir, 'geography.json');
  const days = new Map();
  let dirty = false;
  let writeSequence = 0;

  function prune() {
    const cutoff = dayLabel(now() - RETENTION_DAYS * DAY_MS);
    for (const date of days.keys()) {
      if (date < cutoff) {
        days.delete(date);
        dirty = true;
      }
    }
  }

  function load() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return;
      const aside = `${file}.unreadable-${now()}`;
      try { fs.renameSync(file, aside); } catch (renameError) {
        console.error(`geography: could not preserve the damaged file (${renameError.message})`);
      }
      console.error(`geography: ${file} unreadable (${error.message}); kept as ${aside}`);
      return;
    }

    if (parsed?.version !== VERSION || !parsed.days || typeof parsed.days !== 'object') {
      const aside = `${file}.unreadable-${now()}`;
      fs.renameSync(file, aside);
      console.error(`geography: unsupported file format; kept as ${aside}`);
      return;
    }

    for (const [date, byCountry] of Object.entries(parsed.days)) {
      if (!DATE.test(date) || !byCountry || typeof byCountry !== 'object') continue;
      const counts = new Map();
      for (const [country, values] of Object.entries(byCountry)) {
        if (!COUNTRY_CODE.test(country) || !values || typeof values !== 'object') continue;
        const hits = cleanCount(values.hits);
        const registrations = cleanCount(values.registrations);
        if (hits || registrations) counts.set(country, { hits, registrations });
      }
      if (counts.size) days.set(date, counts);
    }
    prune();
  }

  function record(ip, field) {
    const address = normalizedIp(ip);
    if (!address) return false;
    let result;
    try {
      result = lookupCountry(address);
    } catch (error) {
      console.warn(`geography: country lookup failed (${error.message})`);
      return false;
    }
    const country = typeof result === 'string' ? result.toUpperCase() : '';
    if (!COUNTRY_CODE.test(country)) return false;

    const nowAt = now();
    const today = dayLabel(nowAt);
    prune();
    let byCountry = days.get(today);
    if (!byCountry) days.set(today, byCountry = new Map());
    let counts = byCountry.get(country);
    if (!counts) byCountry.set(country, counts = { hits: 0, registrations: 0 });
    counts[field]++;
    dirty = true;
    return true;
  }

  function summary({ period = '30' } = {}) {
    prune();
    const periodDays = PERIODS.get(String(period));
    if (period !== 'all' && periodDays === undefined) {
      throw new RangeError('invalid geography period');
    }

    const today = Math.floor(now() / DAY_MS) * DAY_MS;
    const earliest = days.size ? Math.min(...[...days.keys()].map(date => Date.parse(`${date}T00:00:00Z`))) : null;
    const span = period === 'all'
      ? earliest === null ? 30 : Math.max(1, Math.floor((today - earliest) / DAY_MS) + 1)
      : periodDays;
    const from = period === 'all' && earliest !== null
      ? dayLabel(earliest)
      : dayLabel(today - (span - 1) * DAY_MS);
    const fromAt = Date.parse(`${from}T00:00:00Z`);
    const totals = new Map();
    let totalHits = 0, totalRegistrations = 0;
    for (const [date, byCountry] of days) {
      const at = Date.parse(`${date}T00:00:00Z`);
      if (at < fromAt || at > today) continue;
      for (const [country, values] of byCountry) {
        let sum = totals.get(country);
        if (!sum) totals.set(country, sum = { hits: 0, registrations: 0 });
        sum.hits += values.hits;
        sum.registrations += values.registrations;
        totalHits += values.hits;
        totalRegistrations += values.registrations;
      }
    }
    return {
      period: String(period),
      from,
      to: dayLabel(today),
      totalHits,
      totalRegistrations,
      countries: [...totals]
        .map(([country, values]) => ({ country, ...values }))
        .sort((a, b) => (b.hits + b.registrations) - (a.hits + a.registrations)
          || a.country.localeCompare(b.country)),
    };
  }

  function flushSync() {
    if (!dirty) return true;
    const tmp = `${file}.${process.pid}.${++writeSequence}.tmp`;
    const content = JSON.stringify({
      version: VERSION,
      days: Object.fromEntries([...days].map(([date, byCountry]) => [
        date, Object.fromEntries(byCountry),
      ])),
    });
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, file);
      fs.chmodSync(file, 0o600);
      dirty = false;
      return true;
    } catch (error) {
      dirty = true;
      console.error(`geography: could not save (${error.message})`);
      try { fs.unlinkSync(tmp); } catch { /* the failed write may not have created it */ }
      return false;
    }
  }

  load();
  const timer = setInterval(() => { if (dirty) flushSync(); }, flushEveryMs);
  timer.unref();

  return Object.freeze({
    recordHit: ip => record(ip, 'hits'),
    recordRegistration: ip => record(ip, 'registrations'),
    summary,
    flushSync,
    stop() { clearInterval(timer); return flushSync(); },
    file,
  });
}
