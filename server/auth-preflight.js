import { NAME_MAX_CHARS } from '../shared/constants.js';
import { playerName } from './net.js';
import { hasBlockedLanguage } from './names.js';
import { authenticateAccount } from './authenticate.js';

const PATH = '/auth/preflight';
const MAX_BODY_BYTES = 4096;

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

function sameOrigin(req, usingTls) {
  if (typeof req.headers.origin !== 'string' || typeof req.headers.host !== 'string') return false;
  try {
    const origin = new URL(req.headers.origin);
    return origin.host.toLowerCase() === req.headers.host.toLowerCase()
      && origin.protocol === (usingTls ? 'https:' : 'http:');
  } catch {
    return false;
  }
}

async function readJson(req) {
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) {
    const error = new RangeError('request body too large');
    error.statusCode = 413;
    throw error;
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new RangeError('request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  if (!bytes) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RangeError('expected a JSON object');
  }
  return value;
}

export function createAuthPreflightHandler({
  accounts,
  enabled = true,
  geography,
  usingTls = false,
}) {
  if (enabled && !accounts) {
    throw new TypeError('enabled password preflight requires an account store');
  }

  return async function handleAuthPreflight(req, res) {
    if (new URL(req.url, 'http://localhost').pathname !== PATH) return false;
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    if (!sameOrigin(req, usingTls)) {
      sendJson(res, 403, { error: 'request not allowed' });
      return true;
    }
    if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
      !== 'application/json') {
      sendJson(res, 415, { error: 'JSON required' });
      return true;
    }

    let body;
    try {
      body = await readJson(req);
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof RangeError) {
        sendJson(res, error.statusCode ?? 400, { error: 'invalid request' });
        return true;
      }
      throw error;
    }
    if (!enabled) {
      sendJson(res, 200, { ok: true, required: false });
      return true;
    }
    if (typeof body.name !== 'string' || !body.name.trim()
      || body.name.length > NAME_MAX_CHARS
      || (body.password !== undefined && body.password !== null
        && typeof body.password !== 'string')
      || (body.trust !== undefined && body.trust !== null
        && (typeof body.trust !== 'string' || body.trust.length > 128))) {
      sendJson(res, 400, { error: 'invalid request' });
      return true;
    }

    const name = playerName(body.name);
    if (hasBlockedLanguage(name)) {
      sendJson(res, 200, { ok: false, auth: 'name', why: 'choose a different player name' });
      return true;
    }

    const result = await authenticateAccount(accounts, name, {
      password: body.password ?? null,
      trust: body.trust ?? null,
    });
    if (!result.ok) {
      sendJson(res, 200, {
        ok: false,
        auth: result.auth,
        why: result.why,
        ...(result.waitMs ? { waitMs: result.waitMs } : null),
      });
      return true;
    }

    if (result.registered) {
      geography?.recordRegistration(req.socket.remoteAddress);
      console.log(`signup "${name}"`);
    }
    sendJson(res, 200, {
      ok: true,
      ...(result.trust ? { token: result.trust } : null),
    });
    return true;
  };
}
