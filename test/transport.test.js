import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(ROOT, file), 'utf8');
const transportSource = await read('public/client/transport.js');
const wireUrl = new URL('../shared/wire.js', import.meta.url).href;
const testableTransport = transportSource.replace(
  "from '/shared/wire.js'",
  `from '${wireUrl}'`,
);
const { createTransport } = await import(
  `data:text/javascript;base64,${Buffer.from(testableTransport).toString('base64')}`
);

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static latest;

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.closeStates = [];
    FakeWebSocket.latest = this;
  }

  send() {}

  close() {
    this.closeStates.push(this.readyState);
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.onclose?.({ code: 1000, reason: 'client close' }));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }
}

class FakeWebTransport {
  constructor() {
    this.ready = Promise.resolve();
    this.closed = new Promise(() => {});
    this.datagrams = {
      readable: { getReader: () => ({ read: () => new Promise(() => {}) }) },
      writable: { getWriter: () => ({ write: () => Promise.resolve() }) },
    };
  }

  createBidirectionalStream() {
    return Promise.resolve({
      readable: { getReader: () => ({ read: () => new Promise(() => {}) }) },
      writable: { getWriter: () => ({ write: () => Promise.resolve() }) },
    });
  }

  close() {}
}

test('a WebTransport winner does not abort a connecting WebSocket or report it as failed', async t => {
  const oldWebSocket = globalThis.WebSocket;
  const oldWebTransport = globalThis.WebTransport;
  t.after(() => {
    if (oldWebSocket === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = oldWebSocket;
    if (oldWebTransport === undefined) delete globalThis.WebTransport;
    else globalThis.WebTransport = oldWebTransport;
  });
  globalThis.WebSocket = FakeWebSocket;
  globalThis.WebTransport = FakeWebTransport;

  const opened = [];
  const notes = [];
  const transport = createTransport({
    onMessage() {},
    onOpen: kind => opened.push(kind),
    onClose() {},
    onNote: note => notes.push(note),
  });
  transport.connect({ ws: 'wss://example.test/ws', wt: 'https://example.test/wt' });
  await new Promise(resolve => setImmediate(resolve));

  const socket = FakeWebSocket.latest;
  assert.deepEqual(opened, ['webtransport']);
  assert.deepEqual(socket.closeStates, [],
    'the browser must not close a WebSocket before its handshake opens');
  socket.open();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(socket.closeStates, [FakeWebSocket.OPEN],
    'the losing WebSocket closes once it reaches OPEN');
  assert.deepEqual(notes, [], 'an expected losing transport is not reported as a failure');
  transport.close();
});

test('transport selection diagnostics are debug-level', async () => {
  const net = await read('public/client/net.js');
  assert.match(net, /console\.debug\(`transport: \$\{won\}`\)/,
    'the selected transport remains available as opt-in diagnostics');
  assert.match(net, /onNote:\s*note => console\.debug\(`transport: \$\{note\}`\)/,
    'fallback diagnostics do not clutter the default console');
});
