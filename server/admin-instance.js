import { sameSecret } from './config.js';

const PATH = '/internal/instance-metrics';

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
}

function validMetrics(metrics) {
  return Array.isArray(metrics) && metrics.every(point => point
    && typeof point === 'object'
    && Number.isFinite(point.at)
    && Number.isFinite(point.cpuPct) && point.cpuPct >= 0 && point.cpuPct <= 100
    && Number.isFinite(point.memoryPct) && point.memoryPct >= 0 && point.memoryPct <= 100
    && (point.diskPct === null
      || (Number.isFinite(point.diskPct) && point.diskPct >= 0 && point.diskPct <= 100)));
}

export function createAdminInstanceMetricsHandler({ regionId, token, metrics }) {
  if (regionId !== 'us' || typeof token !== 'string' || token.length < 32 || !metrics) {
    throw new TypeError('US instance metrics require a region, shared token, and metric history');
  }

  return async function handleInstanceMetrics(req, res) {
    if (new URL(req.url, 'http://localhost').pathname !== PATH) return false;
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET', 'Cache-Control': 'no-store' });
      res.end();
      return true;
    }
    const authorization = req.headers.authorization;
    const presented = typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice(7) : '';
    if (!sameSecret(presented, token)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return true;
    }
    sendJson(res, 200, { region: regionId, metrics: metrics.history() });
    return true;
  };
}

export function createAdminInstanceMetricsClient({
  origin,
  token,
  fetchImpl = fetch,
  timeoutMs = 3000,
}) {
  const base = new URL(origin);
  if (base.protocol !== 'https:' || typeof token !== 'string' || token.length < 32) {
    throw new TypeError('US instance metrics require an HTTPS origin and shared token');
  }
  const url = new URL(PATH, base).href;

  return async function getInstanceMetrics(regionId) {
    if (regionId !== 'us') throw new RangeError('US instance metrics only support the US region');
    const response = await fetchImpl(url, {
      method: 'GET',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response || response.ok !== true) {
      const status = Number.isFinite(response?.status) ? ` (HTTP ${response.status})` : '';
      throw new Error(`US instance metrics request failed${status}`);
    }
    const value = await response.json();
    if (value?.region !== 'us' || !validMetrics(value.metrics)) {
      throw new Error('US instance metrics response is invalid');
    }
    return value.metrics.map(point => ({ ...point }));
  };
}
