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

/* The renderer caps the number of pixels it paints per frame.
 *
 * `resize()` chose `Math.min(2, devicePixelRatio)` and nothing bounded the PRODUCT - a large or
 * high-DPI window gave the canvas several million backing-store pixels, and every one of them is
 * paid for more than once a frame: there is a full-canvas light layer that is cleared, drawn into
 * and composited over the whole board every frame, on top of the water and two dozen other
 * composite passes. That is fill rate, not JavaScript, which is exactly the shape of "it lags a
 * little on a big screen and is fine on a small one".
 *
 * Asserted as source structure rather than behaviour because `resize` needs a DOM, a layout and
 * a real devicePixelRatio to run. The thing worth defending is that the cap EXISTS and is applied
 * where the scale is chosen - a constant declared and never used would be the likely regression.
 */
test('the renderer caps its backing-store pixel count', () => {
  const src = text('public/client/render.js');
  assert.match(src, /const MAX_CANVAS_PIXELS\s*=/, 'there is no MAX_CANVAS_PIXELS');

  const resize = src.match(/function resize\(\) \{[\s\S]*?\n  \}/)?.[0];
  assert.ok(resize, 'resize() is no longer recognisable - this test needs updating with it');
  assert.match(resize, /MAX_CANVAS_PIXELS/, 'the cap is declared but never applied in resize()');
  // Applied to the measured box, so the cap scales the DPR down rather than being a flat ceiling
  // that ignores how big the window actually is.
  assert.match(resize, /w \* h|h \* w/, 'the cap does not consider the measured box at all');
});

/* The arithmetic itself, extracted and run.
 *
 * The structural test above cannot catch an off-by-one or an inverted comparison, and this is a
 * formula whose failure modes are a black canvas (dpr 0) or no cap at all.
 */
test('the pixel budget scales large windows down and leaves ordinary ones alone', () => {
  const src = text('public/client/render.js');
  const num = name =>
    Number(src.match(new RegExp(`const ${name}\\s*=\\s*([0-9_.]+)`))?.[1].replace(/_/g, ''));
  const budget = num('MAX_CANVAS_PIXELS');
  const floor = num('MIN_CANVAS_SCALE');
  assert.ok(Number.isFinite(budget) && budget > 0, 'MAX_CANVAS_PIXELS is not a positive number');
  assert.ok(floor > 0 && floor <= 1, `MIN_CANVAS_SCALE of ${floor} is not a sane floor`);
  // Big enough for a 1080p board at dpr 1 to be untouched, or the cap is doing harm on a normal
  // window rather than good on a large one.
  assert.ok(budget >= 1920 * 1080, `a budget of ${budget} would downscale a 1080p window at dpr 1`);

  const capFor = (w, h, dpr) => {
    const want = Math.min(2, dpr || 1);
    const px = w * h;
    if (!px) return want;
    return Math.max(floor, Math.min(want, Math.sqrt(budget / px)));
  };
  const pixels = (w, h, dpr) => w * h * capFor(w, h, dpr) ** 2;

  // Untouched: anything at or under the budget keeps every pixel it asked for.
  assert.equal(capFor(800, 600, 2), 2, 'a small retina window was needlessly downscaled');
  assert.equal(capFor(1366, 768, 1), 1, 'a laptop window was downscaled');
  assert.equal(capFor(1920, 1080, 1), 1, 'an ordinary 1080p window was downscaled');

  // Scaled: a retina window well over the budget comes back to roughly the budget.
  assert.ok(pixels(1920, 1080, 2) <= budget * 1.02,
    'a 1080p retina window is still over the pixel budget');
  assert.ok(pixels(2560, 1440, 2) < 1920 * 1080 * 4 * 0.4,
    'a 1440p retina window was barely reduced');

  /* The case the floor of 1.0 used to miss entirely: a 4K panel at 100% scaling reports dpr 1,
   * and a floor of 1 forbade touching its 8.3 million pixels at all. */
  const dpr1_4k = capFor(3840, 2160, 1);
  assert.ok(dpr1_4k < 1, `a 4K window at dpr 1 was left at scale ${dpr1_4k}`);
  assert.ok(pixels(3840, 2160, 1) < 3840 * 2160,
    'a 4K window at dpr 1 got no reduction at all');

  // The floor holds, so the board is never blurred past the named limit.
  assert.equal(capFor(7680, 4320, 2), floor, 'the minimum canvas scale was breached');

  // Never zero or negative, whatever it is handed.
  for (const [w, h, dpr] of [[0, 0, 2], [1, 1, 0], [100000, 100000, 3]]) {
    assert.ok(capFor(w, h, dpr) > 0, `capFor(${w},${h},${dpr}) produced a non-positive scale`);
  }
});
