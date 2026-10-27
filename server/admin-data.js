import { progressFor } from '../shared/constants.js';
import { worldMapFeatures } from './world-map.js';

const DAY_MS = 24 * 60 * 60_000;
const PERIODS = new Map([['7', 7], ['30', 30], ['90', 90], ['365', 365]]);
const SORT_FIELDS = new Set(['registered', 'name', 'level', 'xp', 'kills', 'deaths', 'coins']);

function dayStart(value) {
  if (!value) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError('invalid date');
  }
  const at = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== value) {
    throw new RangeError('invalid date');
  }
  return at;
}

function positiveInteger(value, fallback, field) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new RangeError(`invalid ${field}`);
  return number;
}

function compareNullable(a, b) {
  if (a == null) return b == null ? 0 : 1;
  if (b == null) return -1;
  return typeof a === 'string' ? a.localeCompare(b) : a - b;
}

const nameKey = name => String(name ?? '').trim().toLowerCase();
const dayLabel = at => new Date(at).toISOString().slice(0, 10);

export function createAdminData({
  accounts, leaderboard, metrics, geography, worldMap = worldMapFeatures, now = Date.now,
}) {
  function players({
    from, to, search = '', sort = 'registered', direction = 'desc', page = 1, pageSize = 25,
  } = {}) {
    const fromAt = dayStart(from);
    const toAt = dayStart(to);
    const toExclusive = toAt === null ? null : toAt + DAY_MS;
    if (fromAt !== null && toExclusive !== null && fromAt >= toExclusive) {
      throw new RangeError('invalid date range');
    }

    const currentPage = positiveInteger(page, 1, 'page');
    const size = positiveInteger(pageSize, 25, 'page size');
    if (size > 100) throw new RangeError('invalid page size');
    if (!SORT_FIELDS.has(sort)) throw new RangeError('invalid sort field');
    if (direction !== 'asc' && direction !== 'desc') throw new RangeError('invalid sort direction');
    if (typeof search !== 'string' || search.length > 100) throw new RangeError('invalid search');

    const careers = new Map(leaderboard.all().map(career => [nameKey(career.name), career]));
    const needle = search.trim().toLowerCase();
    const rows = accounts.listForAdmin().map(account => {
      const career = careers.get(nameKey(account.name));
      const score = career?.score ?? 0;
      const progress = career ? {
        xp: career.xp ?? score,
        level: career.level ?? 0,
        tier: career.tier ?? 'Rookie',
      } : progressFor(0);
      return {
        name: account.name,
        created: account.created,
        lastSeen: account.lastSeen,
        score,
        xp: progress.xp,
        level: progress.level,
        tier: progress.tier,
        kills: career?.kills ?? 0,
        deaths: career?.deaths ?? 0,
        coins: career?.coins ?? 0,
        gold: career?.gold ?? 0,
        silver: career?.silver ?? 0,
        bronze: career?.bronze ?? 0,
      };
    }).filter(row => {
      if (needle && !row.name.toLowerCase().includes(needle)) return false;
      if (fromAt !== null || toExclusive !== null) {
        if (!Number.isFinite(row.created)) return false;
        if (fromAt !== null && row.created < fromAt) return false;
        if (toExclusive !== null && row.created >= toExclusive) return false;
      }
      return true;
    });

    const sign = direction === 'asc' ? 1 : -1;
    const field = sort === 'registered' ? 'created' : sort;
    rows.sort((a, b) => {
      const compared = compareNullable(a[field], b[field]);
      if (a[field] == null || b[field] == null) {
        return compared || a.name.localeCompare(b.name);
      }
      return compared * sign || a.name.localeCompare(b.name);
    });

    const total = rows.length;
    const pages = Math.ceil(total / size);
    const boundedPage = pages ? Math.min(currentPage, pages) : 1;
    const offset = (boundedPage - 1) * size;
    return {
      items: rows.slice(offset, offset + size),
      total,
      page: boundedPage,
      pageSize: size,
      pages,
    };
  }

  function registrations({ period = '30' } = {}) {
    const currentTime = Number(now());
    const today = Math.floor(currentTime / DAY_MS) * DAY_MS;
    const registered = accounts.listForAdmin()
      .map(account => Number(account.created))
      .filter(at => Number.isFinite(at) && at <= currentTime);
    const earliest = registered.length
      ? registered.reduce((minimum, at) => Math.min(minimum, at), Infinity)
      : null;
    const periodDays = PERIODS.get(String(period));
    if (period !== 'all' && periodDays === undefined) throw new RangeError('invalid registration period');

    const days = period === 'all'
      ? earliest === null ? 30 : Math.max(1, Math.floor((today - Math.floor(earliest / DAY_MS) * DAY_MS) / DAY_MS) + 1)
      : periodDays;
    const start = period === 'all' && earliest !== null
      ? Math.floor(earliest / DAY_MS) * DAY_MS
      : today - (days - 1) * DAY_MS;
    const previousStart = start - days * DAY_MS;
    const counts = new Array(days).fill(0);
    let currentTotal = 0, previousTotal = 0;

    for (const at of registered) {
      const date = Math.floor(at / DAY_MS) * DAY_MS;
      if (date >= start && date <= today) {
        counts[(date - start) / DAY_MS]++;
        currentTotal++;
      } else if (date >= previousStart && date < start) {
        previousTotal++;
      }
    }

    const change = currentTotal - previousTotal;
    const changePct = previousTotal === 0
      ? currentTotal === 0 ? 0 : null
      : +((change / previousTotal) * 100).toFixed(1);
    return {
      period: String(period),
      days: counts.map((count, i) => ({ date: dayLabel(start + i * DAY_MS), count })),
      currentTotal,
      previousTotal,
      change,
      changePct,
      direction: change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
      currentStart: dayLabel(start),
      currentEnd: dayLabel(today),
      previousStart: dayLabel(previousStart),
      previousEnd: dayLabel(start - DAY_MS),
    };
  }

  return Object.freeze({
    players,
    registrations,
    metrics: () => metrics.history(),
    geography: options => geography.summary(options),
    worldMap: () => worldMap(),
  });
}

export function createMetricHistory(readMetrics, {
  intervalMs = 10_000,
  retentionMs = 60 * 60_000,
  now = Date.now,
} = {}) {
  const points = [];

  function sample() {
    const metrics = readMetrics();
    const at = now();
    points.push({
      at,
      cpuPct: metrics.cpuPct,
      memoryPct: metrics.memoryPct,
      diskPct: metrics.diskPct ?? null,
    });
    const cutoff = at - retentionMs;
    while (points.length && points[0].at < cutoff) points.shift();
  }

  sample();
  const timer = setInterval(sample, intervalMs);
  timer.unref();

  return Object.freeze({
    history() {
      const cutoff = now() - retentionMs;
      while (points.length && points[0].at < cutoff) points.shift();
      return points.map(point => ({ ...point }));
    },
    stop() { clearInterval(timer); },
  });
}
