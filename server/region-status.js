import { REGIONS } from '../shared/regions.js';

const isCount = value => Number.isSafeInteger(value) && value >= 0;

export function createRegionStatusHandler({ regionId, getStats }) {
  return function handleRegionStatus(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/region-status') return false;

    if (req.method !== 'GET') {
      res.writeHead(405, {
        Allow: 'GET',
        'Cache-Control': 'no-store',
      });
      res.end();
      return true;
    }

    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      Vary: 'Origin',
    };
    const origin = req.headers.origin;
    if (REGIONS.some(region => region.origin === origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
    }

    const stats = getStats();
    if (!stats || !isCount(stats.players) || !isCount(stats.bots) || !isCount(stats.maxPlayers)) {
      console.error('region status: invalid room statistics');
      res.writeHead(500, headers);
      res.end(JSON.stringify({ error: 'region status unavailable' }));
      return true;
    }

    res.writeHead(200, headers);
    res.end(JSON.stringify({
      region: regionId,
      humanPlayers: Math.max(0, stats.players - stats.bots),
      bots: stats.bots,
      maxPlayers: stats.maxPlayers,
    }));
    return true;
  };
}
