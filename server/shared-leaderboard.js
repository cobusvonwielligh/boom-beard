import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { progressFor } from '../shared/constants.js';
import { SHOP_ITEMS, addShopBundle, emptyShopQueue, normaliseShopQueue } from '../shared/shop.js';
import { mergeCareerRecords } from './shared-data-merge.js';

const CACHE_VERSION = 1;
const FILE_MODE = 0o600;
const CAREER_FIELDS = ['score', 'kills', 'deaths', 'gold', 'silver', 'bronze', 'coins', 'spentCoins'];

const cleanDelta = delta => Object.fromEntries(
  CAREER_FIELDS.filter(field => Number.isSafeInteger(delta?.[field])
    && delta[field] > 0 && delta[field] <= 1_000_000_000)
    .map(field => [field, delta[field]]),
);
const hasQueue = queue => Object.values(normaliseShopQueue(queue)).some(Boolean);
const humanRecords = players => Object.fromEntries(Object.entries(players ?? {})
  .filter(([id, record]) => id.startsWith('n:') && record && typeof record === 'object'));

function toView(playerId, record) {
  return {
    playerId,
    name: record.name,
    score: record.score,
    kills: record.kills,
    deaths: record.deaths,
    gold: record.gold ?? 0,
    silver: record.silver ?? 0,
    bronze: record.bronze ?? 0,
    coins: record.coins ?? 0,
    ...progressFor(record.score),
  };
}

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export function createSharedLeaderboard({
  localLeaderboard,
  client,
  outbox,
  dataDir,
  regionId,
  refreshEveryMs = 30_000,
}) {
  if (!localLeaderboard || !client || !outbox || !dataDir || regionId !== 'us') {
    throw new TypeError('shared leaderboard requires the US region, local store, client, outbox, and data dir');
  }
  const cacheFile = path.join(dataDir, 'shared-leaderboard.json');
  let globalPlayers = {};
  let writeSequence = 0;
  let shopResults = new Map();
  let flushChain = Promise.resolve();

  try {
    const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    if (saved?.version !== CACHE_VERSION || !saved.players || typeof saved.players !== 'object') {
      throw new Error('shared leaderboard cache has an invalid shape');
    }
    globalPlayers = mergeCareerRecords({}, humanRecords(saved.players));
    fs.chmodSync(cacheFile, FILE_MODE);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`cannot load shared leaderboard cache: ${error.message}`);
  }

  function persistCache() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${cacheFile}.${process.pid}.${++writeSequence}.tmp`;
    const fd = fs.openSync(temporary, 'w', FILE_MODE);
    try {
      fs.writeFileSync(fd, JSON.stringify({ version: CACHE_VERSION, players: globalPlayers }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, cacheFile);
    fs.chmodSync(cacheFile, FILE_MODE);
    const dir = fs.openSync(dataDir, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }

  function replaceSnapshot(snapshot) {
    if (!snapshot || typeof snapshot.players !== 'object' || Array.isArray(snapshot.players)) {
      throw new Error('ZA returned an invalid career snapshot');
    }
    globalPlayers = mergeCareerRecords({}, humanRecords(snapshot.players));
    persistCache();
  }

  function visiblePlayers() {
    const players = structuredClone(globalPlayers);
    const ensurePlayer = (id, name = 'anon') => {
      players[id] ??= {
        name, score: 0, kills: 0, deaths: 0, gold: 0, silver: 0, bronze: 0,
        coins: 0, spentCoins: 0, pendingShop: emptyShopQueue(),
      };
      return players[id];
    };

    for (const operation of outbox.pending()) {
      const record = ensurePlayer(operation.playerKey, operation.name);
      if (operation.op === 'career.apply' && operation.kind === 'record') {
        for (const [field, amount] of Object.entries(cleanDelta(operation.delta))) {
          record[field] = (record[field] ?? 0) + amount;
        }
      } else if (operation.op === 'career.apply' && operation.kind === 'award') {
        const medal = ['gold', 'silver', 'bronze'][operation.place];
        if (medal) record[medal] = (record[medal] ?? 0) + 1;
      } else if (operation.op === 'shop.buy') {
        const item = SHOP_ITEMS[operation.item];
        const current = normaliseShopQueue(record.pendingShop);
        const next = item && addShopBundle(current, operation.item);
        if (next && (record.coins - record.spentCoins) >= item.cost) {
          record.spentCoins = (record.spentCoins ?? 0) + item.cost;
          record.pendingShop = next;
        }
      } else if (operation.op === 'shop.consume') {
        const pending = normaliseShopQueue(record.pendingShop);
        const consumed = normaliseShopQueue(operation.consumed);
        for (const key of Object.keys(pending)) {
          pending[key] = Math.max(0, pending[key] - consumed[key]);
        }
        record.pendingShop = pending;
      }
    }
    return players;
  }

  async function sendPendingOperation(operation) {
    const fields = operation.op === 'career.apply'
      ? ['operationId', 'regionId', 'kind', 'playerKey', 'name', 'delta', 'place']
      : operation.op === 'shop.buy'
        ? ['operationId', 'regionId', 'playerKey', 'item']
        : operation.op === 'shop.consume'
          ? ['operationId', 'regionId', 'playerKey', 'consumed']
          : null;
    if (!fields) throw new Error('shared outbox contains an unsupported operation');
    const payload = Object.fromEntries(fields
      .filter(field => Object.hasOwn(operation, field))
      .map(field => [field, operation[field]]));
    const response = await client.request(operation.op, payload);
    if (response?.snapshot) replaceSnapshot(response.snapshot);
    if (operation.op === 'shop.buy') shopResults.set(operation.operationId, response.result);
    return { operationId: response?.operationId };
  }

  function flushOutbox({ throwErrors = false } = {}) {
    const next = flushChain.catch(() => {}).then(() => outbox.flush(sendPendingOperation));
    flushChain = next;
    return next.catch(error => {
      console.warn(`shared-data: sync pending (${error.message})`);
      if (throwErrors) throw error;
      return false;
    });
  }

  async function refresh() {
    const snapshot = await client.request('career.snapshot');
    replaceSnapshot(snapshot);
    return snapshot;
  }

  const refreshTimer = setInterval(() => {
    refresh().catch(error => console.warn(`shared-data: snapshot refresh failed (${error.message})`));
  }, refreshEveryMs);
  refreshTimer.unref?.();

  function record(playerId, delta = {}) {
    const operationDelta = cleanDelta(delta);
    localLeaderboard.record(playerId, {
      ...operationDelta,
      ...(delta.name == null ? null : { name: delta.name }),
    });
    if (typeof playerId !== 'string' || !playerId.startsWith('n:')) return;
    if (!Object.keys(operationDelta).length) return;
    outbox.enqueue({
      operationId: crypto.randomUUID(),
      regionId,
      op: 'career.apply',
      kind: 'record',
      playerKey: playerId,
      name: delta.name == null ? 'anon' : String(delta.name),
      delta: operationDelta,
    });
    void flushOutbox();
  }

  function award(playerId, place, name) {
    localLeaderboard.award(playerId, place, name);
    if (typeof playerId !== 'string' || !playerId.startsWith('n:')
      || !Number.isInteger(place) || place < 0 || place > 2) return;
    outbox.enqueue({
      operationId: crypto.randomUUID(),
      regionId,
      op: 'career.apply',
      kind: 'award',
      playerKey: playerId,
      name: name == null ? 'anon' : String(name),
      place,
    });
    void flushOutbox();
  }

  function get(playerId) {
    if (typeof playerId !== 'string' || !playerId.startsWith('n:')) {
      return localLeaderboard.get(playerId);
    }
    const record = visiblePlayers()[playerId];
    return record ? toView(playerId, record) : null;
  }

  function all() {
    const combined = new Map(Object.entries(visiblePlayers()));
    for (const player of localLeaderboard.all()) {
      if (player.playerId.startsWith('n:')) continue;
      combined.set(player.playerId, {
        name: player.name,
        score: player.score,
        kills: player.kills,
        deaths: player.deaths,
        gold: player.gold,
        silver: player.silver,
        bronze: player.bronze,
        coins: player.coins,
        spentCoins: 0,
        pendingShop: emptyShopQueue(),
      });
    }
    return [...combined].map(([id, player]) => toView(id, player))
      .sort((a, b) => b.score - a.score || b.kills - a.kills || byName(a, b));
  }

  function economy(playerId) {
    const player = visiblePlayers()[playerId];
    if (!player) return null;
    return {
      wallet: Math.max(0, (player.coins ?? 0) - (player.spentCoins ?? 0)),
      pending: normaliseShopQueue(player.pendingShop),
    };
  }

  async function buy(playerId, itemKey) {
    let operation = outbox.pending().find(item =>
      item.op === 'shop.buy' && item.playerKey === playerId && item.item === itemKey);
    if (!operation) {
      operation = {
        operationId: crypto.randomUUID(),
        regionId,
        op: 'shop.buy',
        playerKey: playerId,
        item: itemKey,
      };
      outbox.enqueue(operation);
    }
    await flushOutbox({ throwErrors: true });
    const result = shopResults.get(operation.operationId);
    shopResults.delete(operation.operationId);
    if (!result) throw new Error('ZA did not return the shop purchase result');
    return result;
  }

  function consumePending(playerId) {
    const pending = economy(playerId)?.pending ?? emptyShopQueue();
    if (!hasQueue(pending)) return pending;
    localLeaderboard.consumePending(playerId);
    outbox.enqueue({
      operationId: crypto.randomUUID(),
      regionId,
      op: 'shop.consume',
      playerKey: playerId,
      consumed: pending,
    });
    void flushOutbox();
    return pending;
  }

  function flush() {
    return Promise.all([localLeaderboard.flush(), flushOutbox()]);
  }

  async function stop() {
    clearInterval(refreshTimer);
    await flushOutbox();
    return localLeaderboard.stop();
  }

  function flushSync() {
    return localLeaderboard.flushSync();
  }

  return Object.freeze({
    record,
    award,
    get,
    top: (count = 10) => all().slice(0, count),
    all,
    economy,
    buy,
    consumePending,
    flush,
    flushSync,
    stop,
    refresh,
    sharedSnapshot: () => ({ players: visiblePlayers() }),
    file: localLeaderboard.file,
    get cacheFile() { return cacheFile; },
  });
}
