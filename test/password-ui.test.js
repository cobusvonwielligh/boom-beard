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

test('password validation toasts last 33 percent longer than regular toasts', async () => {
  const main = await read('public/client/main.js');
  has(main, /const PASSWORD_TOAST_MS\s*=\s*Math\.round\(1600\s*\*\s*1\.33\)/,
    'password validation duration is 33 percent longer than the 1600ms regular toast');
});
