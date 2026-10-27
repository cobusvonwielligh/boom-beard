import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closestReachable, selectedRegionId } from '../shared/region-selection.js';
import { REGIONS } from '../shared/regions.js';
import { pingClass, probeRegion, probeRegions } from '../public/client/region-picker.js';

const regions = REGIONS;

const status = (region, overrides = {}) => ({
  region,
  humanPlayers: 3,
  bots: 2,
  maxPlayers: 16,
  ...overrides,
});

test('probes regions in parallel with no-cache, credential-free CORS requests', async () => {
  const pending = new Map();
  const fetchImpl = (url, options) => new Promise(resolve => {
    pending.set(url, { resolve, options });
  });
  let calls = 0;
  const probes = probeRegions(regions, {
    fetchImpl,
    now: () => (++calls <= regions.length ? 10 : 22.6),
  });

  assert.equal(pending.size, 2);
  for (const region of regions) {
    const request = pending.get(`${region.origin}/region-status`);
    assert.deepEqual(request.options, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      mode: 'cors',
      signal: request.options.signal,
    });
    assert.ok(request.options.signal instanceof AbortSignal);
    request.resolve({
      ok: true,
      json: async () => status(region.id),
    });
  }

  assert.deepEqual(await probes, [
    {
      ...status('za'), id: 'za', name: 'South Africa', flag: '/assets/img/flags/za.svg',
      online: true, rttMs: 13, reason: null,
    },
    {
      ...status('us'), id: 'us', name: 'United States', flag: '/assets/img/flags/us.svg',
      online: true, rttMs: 13, reason: null,
    },
  ]);
});

test('keeps a failed region visible as offline while other probes succeed', async () => {
  const results = await probeRegions(regions, {
    fetchImpl: async url => {
      if (url.startsWith(regions[0].origin)) throw new TypeError('network unavailable');
      return { ok: true, json: async () => status('us') };
    },
    now: () => 10,
  });

  assert.equal(results[0].online, false);
  assert.match(results[0].reason, /network/i);
  assert.equal(results[1].online, true);
});

test('reports timeout and malformed status responses as offline', async () => {
  const timedOut = await probeRegion(regions[0], {
    timeoutMs: 1,
    fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });
  const invalid = await probeRegion(regions[1], {
    fetchImpl: async () => ({ ok: true, json: async () => status('za') }),
  });

  assert.equal(timedOut.online, false);
  assert.match(timedOut.reason, /timed out/i);
  assert.equal(invalid.online, false);
  assert.match(invalid.reason, /invalid/i);
});

test('surfaces unexpected probe errors instead of disguising them as offline', async () => {
  await assert.rejects(
    probeRegion(regions[0], {
      fetchImpl: async () => { throw new Error('programming failure'); },
    }),
    /programming failure/,
  );
});

test('a saved manual region is never replaced by the faster reachable region', () => {
  const results = [
    { id: 'za', online: true, rttMs: 90 },
    { id: 'us', online: false, rttMs: null },
  ];

  assert.equal(closestReachable(results), 'za');
  assert.equal(selectedRegionId(results, 'us'), null);
});

test('ping colors use the requested boundaries', () => {
  assert.equal(pingClass(0), 'pingGood');
  assert.equal(pingClass(50), 'pingGood');
  assert.equal(pingClass(51), 'pingFair');
  assert.equal(pingClass(99), 'pingFair');
  assert.equal(pingClass(100), 'pingPoor');
  assert.equal(pingClass(null), '');
});
