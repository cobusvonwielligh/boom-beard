import { SHOP_ITEMS, emptyShopQueue, normaliseShopQueue } from '../shared/shop.js';

const finite = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const timestamp = value => value == null ? null
  : Number.isFinite(Number(value)) ? Number(value) : null;
const MAX_DEVICES = 5;
const DEFAULT_KDF = { N: 1 << 15, r: 8, p: 1, len: 64 };

function recordsOf(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value.accounts && typeof value.accounts === 'object' ? value.accounts : value;
}

function credentialsOf(record) {
  const credentials = Array.isArray(record.credentials) && record.credentials.length
    ? record.credentials
    : [{ salt: record.salt, hash: record.hash, kdf: record.kdf }];
  const unique = new Map();
  for (const credential of credentials) {
    if (typeof credential?.salt !== 'string' || !/^[\da-f]{16,128}$/i.test(credential.salt)
      || typeof credential.hash !== 'string' || !/^[\da-f]{128}$/i.test(credential.hash)) continue;
    const sourceKdf = credential.kdf && typeof credential.kdf === 'object' ? credential.kdf : {};
    const kdf = {
      N: Number(sourceKdf.N ?? DEFAULT_KDF.N),
      r: Number(sourceKdf.r ?? DEFAULT_KDF.r),
      p: Number(sourceKdf.p ?? DEFAULT_KDF.p),
      len: Number(sourceKdf.len ?? DEFAULT_KDF.len),
    };
    if (!Number.isSafeInteger(kdf.N) || kdf.N < 1024 || kdf.N > DEFAULT_KDF.N
      || (kdf.N & (kdf.N - 1)) !== 0
      || !Number.isSafeInteger(kdf.r) || kdf.r < 1 || kdf.r > 8
      || !Number.isSafeInteger(kdf.p) || kdf.p < 1 || kdf.p > 4
      || kdf.len !== 64) continue;
    unique.set(`${credential.salt}\0${credential.hash}`, {
      salt: credential.salt,
      hash: credential.hash,
      kdf,
    });
  }
  return [...unique.values()];
}

function mergeDevices(...groups) {
  const devices = new Map();
  for (const group of groups) {
    for (const device of Array.isArray(group) ? group : []) {
      if (typeof device?.h !== 'string' || !/^[\da-f]{64}$/i.test(device.h)) continue;
      const current = devices.get(device.h);
      if (!current || finite(device.seen) > finite(current.seen)) {
        devices.set(device.h, { ...device });
      } else {
        current.exp = Math.max(finite(current.exp), finite(device.exp));
      }
    }
  }
  return [...devices.values()].sort((a, b) => finite(b.seen) - finite(a.seen)).slice(0, MAX_DEVICES);
}

export function mergeAccountRecords(zaRecords, usRecords) {
  const merged = new Map();
  for (const source of [recordsOf(zaRecords), recordsOf(usRecords)]) {
    for (const [rawKey, incoming] of Object.entries(source)) {
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) continue;
      const key = String(rawKey).trim().toLowerCase();
      if (!key || key.length > 64) continue;
      const incomingCredentials = credentialsOf(incoming);
      if (!incomingCredentials.length) continue;
      const existing = merged.get(key);
      const credentials = new Map();
      for (const item of [...(existing?.credentials ?? []), ...incomingCredentials]) {
        credentials.set(`${item.salt}\0${item.hash}`, item);
      }
      const allCredentials = [...credentials.values()];
      const existingCreated = timestamp(existing?.created);
      const incomingCreated = timestamp(incoming.created);
      const existingSeen = timestamp(existing?.lastSeen);
      const incomingSeen = timestamp(incoming.lastSeen);
      const primary = allCredentials[0];
      merged.set(key, {
        ...(existing ?? {}),
        ...incoming,
        name: incomingSeen !== null && (existingSeen === null || incomingSeen > existingSeen)
          ? String(incoming.name ?? rawKey) : String(existing?.name ?? incoming.name ?? rawKey),
        salt: primary?.salt ?? '',
        hash: primary?.hash ?? '',
        kdf: primary?.kdf ?? {},
        credentials: allCredentials,
        devices: mergeDevices(existing?.devices, incoming.devices),
        created: existingCreated === null ? incomingCreated
          : incomingCreated === null ? existingCreated : Math.min(existingCreated, incomingCreated),
        lastSeen: existingSeen === null ? incomingSeen
          : incomingSeen === null ? existingSeen : Math.max(existingSeen, incomingSeen),
        signupCountExcluded: Boolean(existing?.signupCountExcluded || incoming.signupCountExcluded),
      });
    }
  }
  return Object.fromEntries(merged);
}

const CAREER_FIELDS = ['score', 'kills', 'deaths', 'gold', 'silver', 'bronze', 'coins', 'spentCoins'];

function careerRecord(id, value) {
  const record = {
    name: String(value?.name ?? 'anon'),
    ...Object.fromEntries(CAREER_FIELDS.map(field => [field, finite(value?.[field])])),
    pendingShop: normaliseShopQueue(value?.pendingShop),
  };
  if (!String(id).startsWith('n:')) record.bot = true;
  return record;
}

export function mergeCareerRecords(zaPlayers, usPlayers) {
  const merged = new Map();
  const addSource = (source, region) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return;
    for (const [rawId, rawRecord] of Object.entries(source)) {
      if (!rawId || !rawRecord || typeof rawRecord !== 'object') continue;
      const id = rawId.startsWith('n:') ? rawId : (region === 'us' ? `us:${rawId}` : rawId);
      const incoming = careerRecord(id, rawRecord);
      const current = merged.get(id);
      if (!current) {
        merged.set(id, incoming);
        continue;
      }
      if (incoming.score > current.score) current.name = incoming.name;
      for (const field of CAREER_FIELDS) current[field] += incoming[field];
      const pendingShop = emptyShopQueue();
      for (const [key, item] of Object.entries(SHOP_ITEMS)) {
        pendingShop[key] = Math.min(item.cap,
          current.pendingShop[key] + incoming.pendingShop[key]);
      }
      current.pendingShop = pendingShop;
    }
  };
  addSource(zaPlayers, 'za');
  addSource(usPlayers, 'us');
  return Object.fromEntries(merged);
}
