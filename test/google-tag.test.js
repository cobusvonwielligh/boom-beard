import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

test('Google Ads tag has denied Consent Mode v2 defaults before loading', () => {
  assert.equal((html.match(/AW-18535357585/g) || []).length, 2);
  const consent = html.search(/gtag\((['"])consent\1,\s*(['"])default\2/);
  const loader = html.indexOf('googletagmanager.com/gtag/js?id=AW-18535357585');
  const config = html.search(/gtag\((['"])config\1,\s*(['"])AW-18535357585\2/);
  assert.ok(consent > 0 && consent < loader && loader < config, 'consent/tag/config order is unsafe');
  for (const key of ['ad_storage', 'ad_user_data', 'ad_personalization', 'analytics_storage']) {
    assert.match(html, new RegExp(`${key}\\s*:\\s*['"]denied['"]`));
  }
});

test('the document has an explicit head and the Google Ads CSP allowlist', () => {
  assert.match(html, /<html lang="en">\s*<head>/);
  assert.match(html, /<\/head>\s*<body>/);
  for (const host of [
    'www.googletagmanager.com', 'www.googleadservices.com', 'googleads.g.doubleclick.net',
    'pagead2.googlesyndication.com', 'www.google.com', 'ad.doubleclick.net',
  ]) assert.ok(server.includes(host), `${host} missing from CSP`);
  assert.match(server, /frame-src[^\n]*www\.googletagmanager\.com/);
});
