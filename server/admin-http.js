import fs from 'node:fs';
import { ADMIN_SESSION_TTL_MS } from './admin-auth.js';

const COOKIE = 'bvAdmin';
const MAX_BODY_BYTES = 4096;

function sendJson(res, status, value, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(value));
}

function sendNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end('not found');
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

function loopback(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip?.startsWith('::ffff:127.');
}

function cookieValue(req) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === COOKIE) return value.join('=');
  }
  return null;
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
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      const error = new RangeError('request body too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!bytes) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RangeError('expected a JSON object');
  }
  return value;
}

export function createAdminHttpHandler({ auth, data, pageFile, usingTls = false }) {
  return async function handleAdmin(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (pathname !== '/admin' && pathname !== '/admin/' && !pathname.startsWith('/admin/')) {
      return false;
    }
    if (!usingTls && !loopback(req.socket.remoteAddress)) {
      sendNotFound(res);
      return true;
    }
    if (!auth.enabled) {
      sendNotFound(res);
      return true;
    }

    if (pathname === '/admin' || pathname === '/admin/') {
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      });
      res.end(fs.readFileSync(pageFile));
      return true;
    }

    if (pathname === '/admin/api/login') {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
      if (!sameOrigin(req, usingTls)) {
        sendJson(res, 403, { error: 'request not allowed' });
        return true;
      }
      if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        sendJson(res, 415, { error: 'JSON required' });
        return true;
      }

      let credentials;
      try {
        credentials = await readJson(req);
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof RangeError) {
          sendJson(res, error.statusCode ?? 400, { error: 'invalid request' });
          return true;
        }
        throw error;
      }
      const result = auth.login({
        name: credentials.name,
        deviceToken: credentials.deviceToken,
        adminKey: credentials.adminKey,
        password: credentials.password,
        ip: req.socket.remoteAddress,
      });
      if (!result.ok) {
        const retryAfter = result.retryAfterMs
          ? Math.max(1, Math.ceil(result.retryAfterMs / 1000)) : null;
        sendJson(res, retryAfter ? 429 : 401, { error: 'not authorized' },
          retryAfter ? { 'Retry-After': String(retryAfter) } : {});
        return true;
      }

      const secure = usingTls ? '; Secure' : '';
      res.setHeader('Set-Cookie',
        `${COOKIE}=${result.token}; Path=/admin; HttpOnly; SameSite=Strict; ` +
        `Max-Age=${Math.floor(ADMIN_SESSION_TTL_MS / 1000)}${secure}`);
      sendJson(res, 200, { ok: true });
      return true;
    }

    if (pathname === '/admin/api/logout') {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
      if (!sameOrigin(req, usingTls)) {
        sendJson(res, 403, { error: 'request not allowed' });
        return true;
      }
      auth.logout(cookieValue(req));
      const secure = usingTls ? '; Secure' : '';
      res.writeHead(204, {
        'Cache-Control': 'no-store',
        'Set-Cookie': `${COOKIE}=; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
      });
      res.end();
      return true;
    }

    if (pathname === '/admin/api/session') {
      const authorized = req.method === 'GET' && auth.check(cookieValue(req));
      sendJson(res, 200, { ok: authorized });
      return true;
    }

    if (!pathname.startsWith('/admin/api/')) {
      sendNotFound(res);
      return true;
    }

    const endpoint = pathname.slice('/admin/api/'.length);
    if (req.method !== 'GET' || !auth.check(cookieValue(req))) {
      sendJson(res, 401, { error: 'not authorized' });
      return true;
    }
    const params = url.searchParams;
    try {
      if (endpoint === 'metrics') {
        sendJson(res, 200, data.metrics());
        return true;
      }
      if (endpoint === 'registrations') {
        sendJson(res, 200, data.registrations({ period: params.get('period') ?? '30' }));
        return true;
      }
      if (endpoint === 'geography') {
        sendJson(res, 200, data.geography({ period: params.get('period') ?? '30' }));
        return true;
      }
      if (endpoint === 'worldmap') {
        sendJson(res, 200, data.worldMap());
        return true;
      }
      if (endpoint === 'players') {
        sendJson(res, 200, data.players({
          from: params.get('from') ?? undefined,
          to: params.get('to') ?? undefined,
          search: params.get('search') ?? '',
          sort: params.get('sort') ?? 'registered',
          direction: params.get('direction') ?? 'desc',
          page: params.get('page') ?? 1,
          pageSize: params.get('pageSize') ?? 25,
        }));
        return true;
      }
    } catch (error) {
      if (error instanceof RangeError) {
        sendJson(res, 400, { error: error.message });
        return true;
      }
      throw error;
    }

    sendNotFound(res);
    return true;
  };
}
