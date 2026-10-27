import https from 'node:https';
import { isIP } from 'node:net';

function defaultRequest(options, body, signal) {
  return new Promise((resolve, reject) => {
    const req = https.request({ ...options, signal }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}

export function createSharedDataClient({
  host,
  servername,
  token,
  requestImpl = defaultRequest,
  timeoutMs = 5000,
}) {
  if (!host || !servername || !token) {
    throw new TypeError('shared-data host, server name, and token are required');
  }
  if (!isIP(host)) throw new TypeError('shared-data host must be an IP address');
  if (typeof token !== 'string' || token.length < 32) {
    throw new TypeError('shared-data token must be at least 32 characters');
  }
  if (typeof requestImpl !== 'function') throw new TypeError('requestImpl must be a function');

  async function request(op, params = {}) {
    if (typeof op !== 'string' || !op || !params || typeof params !== 'object'
      || Array.isArray(params)) {
      throw new TypeError('shared-data requests require an operation and object parameters');
    }
    const body = JSON.stringify({ ...params, op });
    const controller = new AbortController();
    let timeoutId;
    const timeoutError = new Error(`shared-data request timed out after ${timeoutMs} ms`);
    const timeout = new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort(timeoutError);
        reject(timeoutError);
      }, timeoutMs);
    });
    const options = {
      host,
      port: 443,
      servername,
      rejectUnauthorized: true,
      method: 'POST',
      path: '/internal/shared-data',
      headers: {
        host: servername,
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    };

    try {
      const response = await Promise.race([requestImpl(options, body, controller.signal), timeout]);
      if (!Number.isInteger(response?.statusCode) || response.statusCode < 200
        || response.statusCode >= 300) {
        throw new Error(`shared-data service returned HTTP ${response?.statusCode ?? 'unknown'}`);
      }
      let parsed;
      try {
        parsed = JSON.parse(String(response.body ?? ''));
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error('shared-data service returned invalid JSON');
        throw error;
      }
      if (parsed?.ok !== true || !Object.hasOwn(parsed, 'result')) {
        throw new Error('shared-data service returned an invalid response');
      }
      return parsed.result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return Object.freeze({ request });
}

export function createSharedAccounts({ client, onAuthenticated = async () => {} }) {
  if (!client || typeof client.request !== 'function') {
    throw new TypeError('a shared-data client is required');
  }
  const authenticated = async result => {
    if (result?.ok) await onAuthenticated();
    return result;
  };
  return Object.freeze({
    has: name => client.request('account.has', { name }),
    checkDevice: async (name, token) => {
      const trusted = await client.request('account.checkDevice', { name, token });
      if (trusted) await onAuthenticated();
      return trusted;
    },
    lockedFor: name => client.request('account.lockedFor', { name }),
    register: async (name, password) =>
      authenticated(await client.request('account.register', { name, password })),
    verify: async (name, password) =>
      authenticated(await client.request('account.verify', { name, password })),
    stats: () => { throw new Error('shared account statistics are available on ZA only'); },
    listForAdmin: () => { throw new Error('account administration is available on ZA only'); },
  });
}
