import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { signupDigits, fetchSignupCount } from '../public/client/signup-meter.js';

const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('signup digits are padded, expandable, and honest about unknown values', () => {
  assert.equal(signupDigits(0), '00000');
  assert.equal(signupDigits(184), '00184');
  assert.equal(signupDigits(123456), '123456');
  for (const bad of [-1, 1.5, NaN, null, undefined, '12']) assert.equal(signupDigits(bad), '-----');
});

test('signup count fetch accepts only finite non-negative integers', async () => {
  const good = async () => ({ ok: true, json: async () => ({ count: 42 }) });
  const bad = async () => ({ ok: true, json: async () => ({ count: -1 }) });
  const down = async () => { throw new Error('offline'); };
  assert.equal(await fetchSignupCount(good), 42);
  assert.equal(await fetchSignupCount(bad), null);
  assert.equal(await fetchSignupCount(down), null);
});

test('the landing meter and owner signup diagnostics occupy their intended surfaces', () => {
  const html = read('public/index.html');
  const css = read('public/style.css');
  const main = read('public/client/main.js');
  const menu = html.slice(html.indexOf('<div id="menu">'), html.indexOf('<script type="module"'));
  assert.match(menu, /id="signupMeter"/);
  assert.match(menu, /id="signupDigits"/);
  assert.match(menu, /pirates registered/);
  assert.doesNotMatch(menu, /players registered|humans registered/);
  assert.match(html, /id="perfSignup24"/);
  assert.match(html, /id="perfSignup7"/);
  assert.match(html, /id="perfSignup30"/);
  assert.match(css, /#signupMeter\s*\{[^}]*position:\s*fixed[^}]*right:[^;]+;[^}]*bottom:/s);
  assert.match(css, /#signupDigits/);
  assert.match(main, /fetchSignupCount/);
  assert.match(main, /perfSignup24/);
  assert.match(main, /perfSignup7/);
  assert.match(main, /perfSignup30/);
});

test('the signup meter is scaled down from its bottom-right anchor', () => {
  const css = read('public/style.css');
  const meter = css.slice(css.indexOf('#signupMeter {'), css.indexOf('.signupLabel'));

  assert.match(meter, /transform:\s*scale\(0\.75\)/);
  assert.match(meter, /transform-origin:\s*bottom right/);
});
