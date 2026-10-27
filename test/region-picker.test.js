import { test } from 'node:test';
import assert from 'node:assert/strict';
import { closestReachable, selectedRegionId } from '../shared/region-selection.js';
import { REGIONS } from '../shared/regions.js';
import { pingClass, probeRegion, probeRegions } from '../public/client/region-picker.js';
import { startPingBurst } from '../public/client/ping-burst.js';

const regions = REGIONS;

const status = (region, overrides = {}) => ({
  region,
  map: region === 'us' ? 'twins' : 'arena',
  humanPlayers: 3,
  bots: 2,
  maxPlayers: 16,
  ...overrides,
});

class PongSocket {
  static OPEN = 1;
  static samples = [18, 12, 16, 9, 14];
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.sent = [];
    PongSocket.instances.push(this);
    setImmediate(() => {
      this.readyState = 1;
      this.listeners.open?.();
    });
  }

  addEventListener(name, callback) { this.listeners[name] = callback; }
  send(body) {
    const message = JSON.parse(body);
    this.sent.push(message);
    const sample = PongSocket.samples[this.sent.length - 1];
    setTimeout(() => {
      this.listeners.message?.({
        data: JSON.stringify({ t: 'pong', c: message.c }),
        sample,
      });
    }, 0);
  }
  close() {
    this.readyState = 3;
    this.listeners.close?.();
  }
}

function fakeClockSocket(samples) {
  PongSocket.samples = samples;
  PongSocket.instances = [];
  let time = 0;
  class TimedPongSocket extends PongSocket {
    send(body) {
      const message = JSON.parse(body);
      this.sent.push(message);
      const sentAt = time;
      const sample = samples[this.sent.length - 1];
      setTimeout(() => {
        time = sentAt + sample;
        this.listeners.message?.({
          data: JSON.stringify({ t: 'pong', c: message.c }),
        });
      }, 0);
    }
  }
  return { WebSocketImpl: TimedPongSocket, now: () => time };
}

test('probes regions in parallel with no-cache, credential-free CORS requests', async () => {
  const pending = new Map();
  const fetchImpl = (url, options) => new Promise(resolve => {
    pending.set(url, { resolve, options });
  });
  const pingOptions = fakeClockSocket([18, 12, 16, 9, 14]);
  const probes = probeRegions(regions, {
    fetchImpl,
    ...pingOptions,
    gapMs: 0,
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
      ...status('za'), id: 'za', name: 'South Africa',
      flag: '/assets/img/flag-south-africa-round-xs.png', statusReady: true,
      online: true, rttMs: 9, reason: null,
    },
    {
      ...status('us'), id: 'us', name: 'United States',
      flag: '/assets/img/flag-united-states-icons-round-64px.png', statusReady: true,
      online: true, rttMs: 9, reason: null,
    },
  ]);
});

test('keeps a failed region visible as offline while other probes succeed', async () => {
  const results = await probeRegions(regions, {
    ...fakeClockSocket([18, 12, 16, 9, 14]),
    gapMs: 0,
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

test('uses five correlated game pongs and emits the first sample immediately', async () => {
  const samples = [18, 12, 16, 9, 14];
  const { WebSocketImpl, now } = fakeClockSocket(samples);
  const emitted = [];
  let firstArrivedBeforeRemaining = false;
  const result = await probeRegion(regions[0], {
    fetchImpl: async () => ({ ok: true, json: async () => status('za') }),
    WebSocketImpl,
    now,
    gapMs: 0,
    onPingSample: sample => {
      emitted.push(sample);
      if (emitted.length === 1) {
        firstArrivedBeforeRemaining = PongSocket.instances[0].sent.length < 5;
      }
    },
  });

  assert.equal(result.rttMs, 9);
  assert.equal(result.online, true);
  assert.deepEqual(emitted, samples);
  assert.equal(firstArrivedBeforeRemaining, true);
  const socket = PongSocket.instances[0];
  assert.equal(socket.url, 'wss://boombeard.co.za/ws');
  assert.deepEqual(socket.sent.map(message => message.t), Array(5).fill('ping'));
  assert.equal(new Set(socket.sent.map(message => message.c)).size, 5);
  assert.equal(socket.readyState, 3);
});

test('ping burst sends immediately and spaces all five measurements by 100 ms', () => {
  const scheduled = new Map();
  const sent = [];
  const delays = [];
  const cleared = [];
  let nextTimerId = 0;
  const cancel = startPingBurst(() => sent.push(sent.length), {
    count: 5,
    gapMs: 100,
    setTimeoutImpl: (callback, delay) => {
      const id = ++nextTimerId;
      scheduled.set(id, callback);
      delays.push(delay);
      return id;
    },
    clearTimeoutImpl: id => {
      cleared.push(id);
      scheduled.delete(id);
    },
  });

  assert.deepEqual(sent, [0]);
  assert.equal(scheduled.size, 1);
  for (let i = 0; i < 4; i++) {
    const [timerId, sendNext] = scheduled.entries().next().value;
    scheduled.delete(timerId);
    sendNext();
  }
  assert.deepEqual(sent, [0, 1, 2, 3, 4]);
  assert.deepEqual(delays, [100, 100, 100, 100]);
  assert.equal(scheduled.size, 0);
  cancel();
  assert.deepEqual(cleared, []);
});

test('ping burst cancellation prevents every later send', () => {
  const scheduled = new Map();
  const sent = [];
  let nextTimerId = 0;
  const cancel = startPingBurst(() => sent.push(sent.length), {
    count: 5,
    setTimeoutImpl: callback => {
      const id = ++nextTimerId;
      scheduled.set(id, callback);
      return id;
    },
    clearTimeoutImpl: id => scheduled.delete(id),
  });
  cancel();
  assert.deepEqual(sent, [0]);
  assert.equal(scheduled.size, 0);
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

test('region metadata points to the supplied equal-box flag assets', () => {
  assert.equal(REGIONS.find(region => region.id === 'za').flag,
    '/assets/img/flag-south-africa-round-xs.png');
  assert.equal(REGIONS.find(region => region.id === 'us').flag,
    '/assets/img/flag-united-states-icons-round-64px.png');
});
