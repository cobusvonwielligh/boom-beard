import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel));
const text = rel => read(rel).toString('utf8');

const ASSETS = [
  'public/assets/img/mascot.8f66a578.webp',
  'public/assets/img/bomb-barrels.4639014b.webp',
  'public/assets/img/title-boom-beard-bandanas-bomb.1f959c46.webp',
  'public/assets/img/avatar.cf938d0b.png',
  'public/assets/fonts/clegan.7308d830.ttf',
];

function webpDimensions(rel) {
  const bytes = read(rel);
  assert.equal(bytes.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(bytes.subarray(8, 12).toString('ascii'), 'WEBP');
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    if (type === 'VP8L') {
      assert.equal(bytes[data], 0x2f, 'invalid VP8L signature');
      const bits = bytes.readUInt32LE(data + 1);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    offset = data + length + (length & 1);
  }
  assert.fail(`${rel} has no VP8L dimensions`);
}

test('README banner points to an existing image asset', () => {
  const banner = text('README.md')
    .match(/<img src="([^"]+)" alt="Boom Beard" width="100%">/)?.[1];
  assert.ok(banner, 'README banner image is present');
  assert.ok(fs.existsSync(path.join(ROOT, banner)), `README banner asset does not exist: ${banner}`);
});

test('desktop metadata and the LCP image are explicit', () => {
  const html = text('public/index.html');
  assert.match(html, /<html lang="en">/);
  assert.match(html,
    /<meta\s+name="description"\s+content="Sixteen pirates\. One island\. Light the fuse and run\. Play Boom Beard, a fast browser arena game for up to 16 players\."\s*\/>/s);
  assert.match(html, /<link rel="canonical" href="https:\/\/boombeard\.co\.za\/" \/>/);
  assert.match(html,
    /src="\/assets\/img\/mascot\.8f66a578\.webp"[^>]*fetchpriority="high"/s);
  assert.doesNotMatch(html,
    /mascot\.png|bomb-barrels\.png|title-boom-beard-bandanas-bomb\.webp|avatar\.png|clegan\.ttf/);
});

test('all optimized asset references exist and old names are gone', () => {
  const css = text('public/style.css');
  const html = text('public/index.html');
  for (const rel of ASSETS) assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is missing`);
  assert.doesNotMatch(css,
    /mascot\.png|bomb-barrels\.png|title-boom-beard-bandanas-bomb\.webp|clegan\.ttf/);
  for (const rel of ASSETS) {
    const url = '/' + rel.replace(/^public\//, '');
    assert.ok(html.includes(url) || css.includes(url), `${url} is never referenced`);
  }
});

test('near-lossless WebPs preserve desktop dimensions and reduce bytes', () => {
  const mascot = 'public/assets/img/mascot.8f66a578.webp';
  const barrels = 'public/assets/img/bomb-barrels.4639014b.webp';
  assert.deepEqual(webpDimensions(mascot), { width: 384, height: 384 });
  assert.deepEqual(webpDimensions(barrels), { width: 440, height: 440 });
  assert.ok(read(mascot).length < 100_000, 'mascot WebP is unexpectedly large');
  assert.ok(read(barrels).length < 105_000, 'barrel WebP is unexpectedly large');
});

test('the server recognizes content-fingerprinted assets', () => {
  const server = text('server/index.js');
  assert.match(server, /fingerprinted.*max-age=31536000.*immutable/s);
});
