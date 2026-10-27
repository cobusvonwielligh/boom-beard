import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { regionOrigin, transportUrls } from '../shared/regions.js';

test('uses the local server for ZA development while keeping US remote', () => {
  assert.equal(regionOrigin('za', 'http://localhost:8080'), 'http://localhost:8080');
  assert.equal(regionOrigin('za', 'https://boombeard.co.za'), 'https://boombeard.co.za');
  assert.equal(regionOrigin('us', 'http://localhost:8080'), 'https://52.21.210.27');
});

test('rejects unknown region IDs', () => {
  assert.throws(() => regionOrigin('ca', 'https://boombeard.co.za'), /unknown region/);
});

test('regional secure transport URLs use the selected host', () => {
  assert.deepEqual(transportUrls('https://52.21.210.27'), {
    ws: 'wss://52.21.210.27/ws',
    wt: 'https://52.21.210.27/wt',
  });
});

test('every TLS region starts WebTransport and reports whether its listener is available', async () => {
  const source = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(source, /if \(usingTls\) \{\s*startWebTransport\(\{/);
  assert.match(source, /port:\s*config\.port/);
  assert.match(source, /transports:\s*\{\s*\.\.\.hub\.transportCounts,\s*webtransport:\s*wt\s*\?\s*hub\.transportCounts\.webtransport\s*:\s*null/);
  assert.doesNotMatch(source, /if\s*\(config\.regionId\s*===\s*'za'[^)]*\)\s*\{\s*startWebTransport/);
});

test('local HTTP uses WebSocket without WebTransport', () => {
  assert.deepEqual(transportUrls('http://localhost:8080'), {
    ws: 'ws://localhost:8080/ws',
    wt: null,
  });
});

test('rejects unsupported transport origins', () => {
  assert.throws(() => transportUrls('file:///tmp/game'), /unsupported region protocol/);
});

test('play rechecks region availability before opening the game connection', async () => {
  const source = await readFile(new URL('../public/client/main.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function play(');
  const end = source.indexOf('/* The password box:', start);
  assert.notEqual(start, -1, 'play is asynchronous while it probes region status');
  assert.ok(end > start, 'play body ends before the password-box helpers');
  const play = source.slice(start, end);
  const probe = play.indexOf('await regionPicker.chooseRegion()');
  const connect = play.indexOf('net.connect(');
  assert.ok(probe >= 0 && connect > probe,
    'the registration/join path requires an explicit region choice before connecting');
  assert.doesNotMatch(source, /regionPicker\.start\(\)/);
});

test('game ping starts with the shared burst and resets across region changes', async () => {
  const source = await readFile(new URL('../public/client/net.js', import.meta.url), 'utf8');
  assert.match(source, /startPingBurst\(ping\)/);
  const connect = source.slice(source.indexOf('connect(name, observe'));
  assert.match(connect, /rtts\.length\s*=\s*0/);
  assert.match(source, /let pingSequence\s*=\s*0/);
});

test('in-game connection dot uses the same RTT colors as region cards', async () => {
  const [main, net, css] = await Promise.all([
    readFile(new URL('../public/client/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/client/net.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/style.css', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /onPing:\s*rtt\s*=>[\s\S]*?conn\.dataset\.ping\s*=\s*pingClass\(rtt\)/);
  assert.match(net, /onPing\?\.\(Math\.round\(rttMin\(\)\)\)/);
  assert.match(net, /onPing\?\.\(null\)/);
  assert.match(css, /#conn\[data-state="open"\]\[data-ping="pingGood"\]/);
  assert.match(css, /#conn\[data-state="open"\]\[data-ping="pingFair"\]/);
  assert.match(css, /#conn\[data-state="open"\]\[data-ping="pingPoor"\]/);
});

test('region dialog stays visible until the current toast has faded', async () => {
  const main = await readFile(new URL('../public/client/main.js', import.meta.url), 'utf8');
  assert.match(main, /regionPicker\.isHoldingForConnect\(\)[\s\S]*?waitForToastDismissal\(\)\.then\(enterMap\)/);
  assert.match(main, /if \(regionPicker\.isHoldingForConnect\(\)\) regionPicker\.close\(\);/);
  assert.match(main, /const inRegionDialog = regionPicker\.isHoldingForConnect\(\);/);
  assert.match(main, /toastDeadline = performance\.now\(\) \+ duration \+ 250;/);
  assert.match(main, /waitForToastDismissal\(\)\.then\(\(\) => regionPicker\.close\(\)\)/);
  assert.match(main, /regionPicker\.isHoldingForConnect\(\)\s*&&\s*s !== 'connecting'\s*&&\s*s !== 'open'[\s\S]*?waitForToastDismissal\(\)/);
});

test('ZA security policy allows direct US probes without a regional hostname', async () => {
  const source = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');
  const connect = source.match(/"connect-src ([^"]+)"/)?.[1];
  assert.ok(connect, 'connect-src directive exists');
  assert.match(connect, /https:\/\/52\.21\.210\.27/);
  assert.doesNotMatch(connect, /us\.boombeard\.co\.za/);
});
