// Escape asks before it throws you out of a live round.
//
// It used to leave outright. A tapped Escape is a reflex - it is what closes everything else on
// the page - and spending it on "abandon the round you are winning" with no confirmation is the
// one keystroke in the game that cannot be taken back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(ROOT, file), 'utf8');
const has = (source, pattern, message) => assert.ok(pattern.test(source), message);

test('the leave confirmation exists with both choices and is labelled', async () => {
  const html = await read('public/index.html');

  has(html, /<dialog\s+id="leaveDialog"/, 'there is no #leaveDialog');
  has(html, /id="leaveDialog"[^>]*aria-labelledby="leaveDialogHeading"/s,
    'the dialog is not labelled by its own heading');
  has(html, /<h2[^>]*id="leaveDialogHeading"[^>]*>/, 'the dialog has no real heading element');
  has(html, /id="leaveConfirm"/, 'there is no confirm button');
  has(html, /id="leaveCancel"/, 'there is no cancel button');
});

test('escape opens the confirmation instead of leaving', async () => {
  const main = await read('public/client/main.js');

  // The whole point: the running branch of onEscape must no longer call leave() directly.
  const onEscape = main.match(/const onEscape = tapEscape\(\(\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(onEscape, 'onEscape is no longer recognisable - this test needs updating with it');
  assert.ok(!/\brunning\b[^\n]*\bleave\(\)/.test(onEscape),
    'escape still leaves the game directly instead of asking');
  has(onEscape, /askToLeave\(\)/, 'escape does not open the leave confirmation');

  // Symmetric: escape with the dialog already open closes it rather than stacking another.
  has(onEscape, /leaveDialog/, 'escape cannot dismiss the confirmation it opened');
});

test('only the confirm button leaves, and cancel merely closes', async () => {
  const main = await read('public/client/main.js');

  has(main, /\$\('leaveConfirm'\)\.onclick\s*=[^\n]*leave/, 'confirm is not wired to leave()');
  const cancel = main.match(/\$\('leaveCancel'\)\.onclick\s*=[^\n]*/)?.[0] ?? '';
  assert.ok(cancel, 'cancel is not wired to anything');
  assert.ok(!/leave\b/.test(cancel), 'cancel leaves the game, which is the opposite of cancel');
});

test('the confirmation does not pause the game or stop input', async () => {
  const main = await read('public/client/main.js');
  const ask = main.match(/function askToLeave\(\)[\s\S]*?\n\}/)?.[0];
  assert.ok(ask, 'there is no askToLeave()');
  /* A browser arena cannot pause for one player. A modal that implied otherwise would get people
   * killed while they read it, so the loop keeps running and the dialog says so. */
  assert.ok(!/\brunning = false\b|\bpause\b/.test(ask),
    'the leave confirmation stops the game, which it cannot honestly do');
});

test('the leave confirmation is styled alongside the region dialog', async () => {
  const css = await read('public/style.css');
  has(css, /#leaveDialog|\.leaveDialog/, 'the dialog has no styling at all');
});
