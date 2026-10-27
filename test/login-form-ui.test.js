import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(ROOT, file), 'utf8');

test('player id and password use a real form submission', async () => {
  const [html, main] = await Promise.all([
    read('public/index.html'), read('public/client/main.js'),
  ]);
  const formStart = html.indexOf('<form id="playerForm"');
  const formEnd = html.indexOf('</form>', formStart);
  const form = html.slice(formStart, formEnd);

  assert.ok(formStart >= 0 && formEnd > formStart, 'player form is present');
  assert.match(form, /id="name"/, 'player id belongs to the form');
  assert.match(form, /id="pw"/, 'password belongs to the same form');
  assert.match(html, /<button id="play" type="submit" form="playerForm">play<\/button>/,
    'PLAY submits the player form');
  assert.match(html, /<button id="watch" type="button"/,
    'spectating does not submit the player form');
  assert.match(main, /\$\('playerForm'\)\.addEventListener\('submit',\s*event => \{\s*event\.preventDefault\(\);\s*play\(false\);\s*\}\)/,
    'form submission reuses the existing play validation without navigation');
  assert.doesNotMatch(main, /nameInput\.onkeydown\s*=|\$\('pw'\)\.onkeydown\s*=/,
    'Enter is handled by form submission instead of duplicate key handlers');
});
