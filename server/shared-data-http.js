import { sameSecret } from './config.js';
import { SHOP_ITEMS } from '../shared/shop.js';

const PATH = '/internal/shared-data';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const OPERATIONS = new Set([
  'account.has',
  'account.checkDevice',
  'account.lockedFor',
  'account.register',
  'account.verify',
  'account.stats',
  'career.snapshot',
  'career.apply',
  'shop.buy',
  'shop.consume',
  'migration.import',
]);

function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

async function readJson(req, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    const error = new Error('JSON content type required');
    error.status = 415;
    throw error;
  }
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    const error = new Error('request body too large');
    error.status = 413;
    throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      const error = new Error('request body too large');
      error.status = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) {
      const invalid = new Error('invalid JSON request body');
      invalid.status = 400;
      throw invalid;
    }
    throw error;
  }
}

function requireName(body) {
  if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 64) {
    const error = new Error('invalid account name');
    error.status = 400;
    throw error;
  }
  return body.name;
}

function invalidRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

function persistAccounts(accounts) {
  if (typeof accounts.flushSync !== 'function' || accounts.flushSync() !== true) {
    throw new Error('could not persist shared account state');
  }
}

export function createSharedDataHttpHandler({
  regionId,
  token,
  accounts,
  leaderboard,
}) {
  if (typeof token !== 'string' || token.length < 32) {
    throw new TypeError('shared-data token must be at least 32 characters');
  }
  return async function handleSharedData(req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname !== PATH) return false;
    if (regionId !== 'za') {
      json(res, 404, { ok: false, error: 'not found' });
      return true;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    const authorization = req.headers.authorization;
    const presented = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7) : '';
    if (!sameSecret(presented, token)) {
      json(res, 401, { ok: false, error: 'unauthorized' });
      return true;
    }

    let body;
    try {
      body = await readJson(req, MAX_BODY_BYTES);
    } catch (error) {
      json(res, error.status ?? 400, { ok: false, error: error.status === 413
        ? 'request too large' : error.status === 415 ? 'JSON required' : 'invalid request' });
      return true;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.op !== 'string' || !OPERATIONS.has(body.op)) {
      json(res, 400, { ok: false, error: 'invalid operation' });
      return true;
    }

    try {
      let result;
      switch (body.op) {
        case 'account.has':
          result = await accounts.has(requireName(body));
          break;
        case 'account.checkDevice':
          if (typeof body.token !== 'string' || body.token.length > 128) {
            throw invalidRequest('invalid device token');
          }
          result = await accounts.checkDevice(requireName(body), body.token);
          if (result) persistAccounts(accounts);
          break;
        case 'account.lockedFor':
          result = await accounts.lockedFor(requireName(body));
          break;
        case 'account.register':
          if (typeof body.password !== 'string') throw invalidRequest('invalid password');
          result = await accounts.register(requireName(body), body.password);
          if (result?.ok) persistAccounts(accounts);
          break;
        case 'account.verify':
          if (typeof body.password !== 'string') throw invalidRequest('invalid password');
          result = await accounts.verify(requireName(body), body.password);
          if (result?.ok) persistAccounts(accounts);
          break;
        case 'account.stats':
          result = accounts.stats();
          break;
        case 'career.snapshot':
          result = leaderboard.sharedSnapshot();
          break;
        case 'career.apply':
        case 'shop.buy':
        case 'shop.consume': {
          if (typeof body.operationId !== 'string' || body.operationId.length > 128) {
            throw invalidRequest('invalid operation ID');
          }
          if (body.regionId !== 'us' || typeof body.playerKey !== 'string'
            || !body.playerKey.startsWith('n:')) {
            throw invalidRequest('shared mutations require a US human player');
          }
          if (body.op === 'career.apply') {
            if (body.kind === 'record') {
              const allowed = new Set(['score', 'kills', 'deaths', 'coins']);
              if (!body.delta || typeof body.delta !== 'object' || Array.isArray(body.delta)
                || Object.entries(body.delta).some(([field, amount]) =>
                  !allowed.has(field) || !Number.isSafeInteger(amount) || amount < 0
                    || amount > 1_000_000_000)) {
                throw invalidRequest('invalid career delta');
              }
            } else if (body.kind === 'award') {
              if (!Number.isInteger(body.place) || body.place < 0 || body.place > 2) {
                throw invalidRequest('invalid career award');
              }
            } else {
              throw invalidRequest('invalid career mutation');
            }
          } else if (body.op === 'shop.buy') {
            if (typeof body.item !== 'string' || !Object.hasOwn(SHOP_ITEMS, body.item)) {
              throw invalidRequest('invalid shop item');
            }
          } else if (!body.consumed || typeof body.consumed !== 'object'
            || Array.isArray(body.consumed)
            || Object.entries(body.consumed).some(([key, count]) =>
              !Object.hasOwn(SHOP_ITEMS, key) || !Number.isSafeInteger(count)
                || count < 0 || count > SHOP_ITEMS[key].cap)) {
            throw invalidRequest('invalid shop consumption');
          }
          result = leaderboard.applySharedOperation(body.operationId, body);
          break;
        }
        case 'migration.import':
          if (typeof body.migrationId !== 'string' || body.migrationId.length > 128
            || !body.accounts || typeof body.accounts !== 'object' || Array.isArray(body.accounts)
            || !body.players || typeof body.players !== 'object' || Array.isArray(body.players)) {
            throw invalidRequest('invalid migration payload');
          }
          result = {
            accounts: accounts.importSharedRecords(body.accounts, body.migrationId),
            careers: leaderboard.mergeSharedSnapshot(body.players, body.migrationId),
          };
          break;
        default:
          throw new Error('unsupported operation');
      }
      json(res, 200, { ok: true, result });
    } catch (error) {
      if (error.status === 400) {
        json(res, 400, { ok: false, error: error.message });
        return true;
      }
      console.error(`shared-data: ${body.op} failed (${error.message})`);
      json(res, 503, { ok: false, error: 'shared-data unavailable' });
    }
    return true;
  };
}
