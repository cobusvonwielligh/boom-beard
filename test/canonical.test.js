// The canonical-host redirect. Mostly here for the two cases that would hurt: bouncing the
// deploy health check, and letting a request header into the authority part of a Location.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalTarget, gameOnlyRedirect, requestHost } from '../server/canonical.js';

const live = over => canonicalTarget({ url: '/', want: 'boombeard.co.za', tls: true, ...over });

test('aliases bounce to the canonical name', () => {
  assert.equal(live({ host: 'www.boombeard.co.za' }), 'https://boombeard.co.za/');
  assert.equal(live({ host: '15.240.88.189.sslip.io' }), 'https://boombeard.co.za/');
  assert.equal(live({ host: '15.240.88.189' }), 'https://boombeard.co.za/');
  assert.equal(live({ host: 'BoomBeard.Co.Za:443' }), null, 'case and port are not a difference');
});

test('the canonical name itself is served, not redirected', () => {
  assert.equal(live({ host: 'boombeard.co.za' }), null);
  assert.equal(live({ host: 'boombeard.co.za:443' }), null);
});

test('loopback is never redirected - deploy health-checks https://localhost', () => {
  assert.equal(live({ host: 'localhost' }), null);
  assert.equal(live({ host: 'localhost:443' }), null);
  assert.equal(live({ host: '127.0.0.1' }), null);
  assert.equal(live({ host: '[::1]' }), null);
});

test('/healthz and /deploy answer on any name', () => {
  assert.equal(live({ host: 'www.boombeard.co.za', url: '/healthz' }), null);
  assert.equal(live({ host: '15.240.88.189', url: '/deploy' }), null);
  assert.equal(live({ host: 'www.boombeard.co.za', url: '/healthz?x=1' }), null);
});

test('stays out of the way without TLS or with a local public_host', () => {
  assert.equal(canonicalTarget({ host: 'www.x.com', url: '/', want: 'x.com', tls: false }), null);
  assert.equal(canonicalTarget({ host: 'www.x.com', url: '/', want: 'localhost', tls: true }), null);
  assert.equal(canonicalTarget({ host: 'www.x.com', url: '/', want: '', tls: true }), null);
});

test('query strings and paths survive the bounce', () => {
  assert.equal(live({ host: 'www.boombeard.co.za', url: '/client/main.js?v=2' }),
    'https://boombeard.co.za/client/main.js?v=2');
});

test('a junk Host header cannot reach the Location', () => {
  // The destination always comes from config, so even a nonsense Host only decides whether to
  // redirect - never where to. An unparseable one is served locally rather than bounced.
  assert.equal(requestHost('evil.com\r\nX-Injected: 1'), null);
  assert.equal(live({ host: 'evil.com\r\nX-Injected: 1' }), null);
  assert.equal(live({ host: 'anything.at.all' }), 'https://boombeard.co.za/');
  assert.equal(requestHost(undefined), null);
  assert.equal(requestHost(''), null);
});

test('the US game host redirects site and admin routes to ZA without forwarding queries', () => {
  assert.equal(gameOnlyRedirect({ regionId: 'us', url: '/' }), 'https://boombeard.co.za/');
  assert.equal(gameOnlyRedirect({ regionId: 'us', url: '/client/main.js' }), 'https://boombeard.co.za/');
  assert.equal(gameOnlyRedirect({ regionId: 'us', url: '/admin' }), 'https://boombeard.co.za/admin');
  assert.equal(gameOnlyRedirect({ regionId: 'us', url: '/admin/api/login?secret=value' }),
    'https://boombeard.co.za/admin');
  assert.equal(gameOnlyRedirect({ regionId: 'us', url: '/?admin=secret' }), 'https://boombeard.co.za/');
  assert.equal(gameOnlyRedirect({ regionId: 'us', url: '/region-status' }), null);
  assert.equal(gameOnlyRedirect({ regionId: 'us', url: '/healthz' }), null);
  assert.equal(gameOnlyRedirect({ regionId: 'us', url: '/deploy' }), null);
  assert.equal(gameOnlyRedirect({ regionId: 'za', url: '/' }), null);
});
