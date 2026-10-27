import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(path.join(ROOT, file), 'utf8');
const has = (source, pattern, message) => assert.ok(pattern.test(source), message);

test('password validation feedback is friendly and actionable', async () => {
  const main = await read('public/client/main.js');

  has(main, /function passwordErrorMessage\(why\)/,
    'password errors are converted into user-friendly feedback');
  for (const message of [
    "That password didn't match. Please try again.",
    'Too many tries just now. Please wait a moment, then try again.',
    'Please enter a password to continue.',
    'Please choose a password that is different from your name.',
    'Please choose a less repetitive password.',
  ]) {
    assert.ok(main.includes(message), `missing friendly password feedback: ${message}`);
  }
  has(main, /toast\(passwordErrorMessage\(why\),\s*PASSWORD_TOAST_MS\)/,
    'password validation uses the friendly feedback and longer toast duration');
});

test('password prompts and validation toasts stay visible for five seconds', async () => {
  const main = await read('public/client/main.js');
  has(main, /const PASSWORD_TOAST_MS\s*=\s*5000/,
    'password prompts and validation remain visible for five seconds');
  has(main, /toast\(pwMode === 'signup'[\s\S]*?PASSWORD_TOAST_MS\)/,
    'the signup prompt uses the extended toast duration');
  assert.ok(main.includes('Ahoy, ${nameInput.value.trim()}! Pick a password to claim your pirate name.'),
    'the signup prompt is friendly and pirate-themed');
});

test('player id and password fields share aligned label and input columns', async () => {
  const html = await read('public/index.html');
  const css = await read('public/style.css');

  has(html, /\.playerid-group label\s*{[^}]*width:\s*92px/s,
    'both form rows reserve the same label width');
  has(css, /#pwLabel\s*{\s*font-size:\s*0\.78em;/,
    'the password label is smaller to fit the shared label column');
  has(css, /#pwGroup\s*{[^}]*margin-bottom:\s*16px/s,
    'the password field has more space beneath it');
  has(css, /#menuWrap #play\s*{\s*margin-top:\s*20px;/,
    'the PLAY button has more space below the password field');
  has(css, /#menuWrap #watch\s*{\s*margin-top:\s*16px;/,
    'SPECTATE ONLY has more space below PLAY');
});
