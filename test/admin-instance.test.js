import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  createAdminInstanceMetricsClient,
  createAdminInstanceMetricsHandler,
} from '../server/admin-instance.js';

const TOKEN = 's'.repeat(64);
const samples = [{ at: 1, cpuPct: 20, memoryPct: 30, diskPct: 40 }];

function request({ method = 'GET', authorization = `Bearer ${TOKEN}` } = {}) {
  const req = Readable.from([]);
  req.method = method;
  req.url = '/internal/instance-metrics';
  req.headers = { authorization };
  return req;
}

function response() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(status, headers = {}) {
      this.statusCode = status;
      Object.assign(this.headers, headers);
    },
    end(body = '') { this.body = body; },
  };
}

test('US metrics endpoint returns only the authenticated local resource history', async () => {
  let reads = 0;
  const handler = createAdminInstanceMetricsHandler({
    regionId: 'us',
    token: TOKEN,
    metrics: { history: () => { reads++; return samples; } },
  });
  const res = response();
  assert.equal(await handler(request(), res), true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { region: 'us', metrics: samples });
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.headers['Access-Control-Allow-Origin'], undefined);
  assert.equal(reads, 1);
});

test('US metrics endpoint rejects bad credentials and methods before reading samples', async () => {
  let reads = 0;
  const handler = createAdminInstanceMetricsHandler({
    regionId: 'us',
    token: TOKEN,
    metrics: { history: () => { reads++; return samples; } },
  });
  const denied = response();
  await handler(request({ authorization: 'Bearer wrong' }), denied);
  assert.equal(denied.statusCode, 401);

  const method = response();
  await handler(request({ method: 'POST' }), method);
  assert.equal(method.statusCode, 405);
  assert.equal(reads, 0);
});

test('admin metrics client validates region, response status, and sample shapes', async () => {
  const client = createAdminInstanceMetricsClient({
    origin: 'https://52.21.210.27',
    token: TOKEN,
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://52.21.210.27/internal/instance-metrics');
      assert.deepEqual(options.headers, { Authorization: `Bearer ${TOKEN}` });
      return { ok: true, json: async () => ({ region: 'us', metrics: samples }) };
    },
  });
  assert.deepEqual(await client('us'), samples);
  await assert.rejects(client('za'), /US/);

  const invalid = createAdminInstanceMetricsClient({
    origin: 'https://52.21.210.27',
    token: TOKEN,
    fetchImpl: async () => ({ ok: true, json: async () => ({ region: 'us', metrics: [{}] }) }),
  });
  await assert.rejects(invalid('us'), /invalid/i);
});
