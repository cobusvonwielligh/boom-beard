import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the public sitemap lists only the canonical homepage', () => {
  assert.equal(read('public/sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://boombeard.co.za/</loc>
  </url>
</urlset>
`);
});

test('robots.txt permits crawling and advertises the sitemap', () => {
  assert.equal(read('public/robots.txt'), `User-agent: *
Allow: /

Sitemap: https://boombeard.co.za/sitemap.xml
`);
});

test('the static server sends sitemap files with correct content types', () => {
  const server = read('server/index.js');
  assert.match(server, /'\.xml':\s*'application\/xml; charset=utf-8'/);
  assert.match(server, /'\.txt':\s*'text\/plain; charset=utf-8'/);
});
