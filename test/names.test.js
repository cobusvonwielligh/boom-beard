import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasBlockedLanguage, nameKey } from '../server/names.js';

test('name keys close case, spacing and Unicode compatibility loopholes', () => {
  assert.equal(nameKey('  Cobus   Van Wyk '), 'cobus van wyk');
  assert.equal(nameKey('ＣＯＢＵＳ'), 'cobus');
});

test('the severe-language filter catches plain and obfuscated slurs', () => {
  assert.equal(hasBlockedLanguage('kaffer'), true);
  assert.equal(hasBlockedLanguage('k.a.f.f.e.r'), true);
  assert.equal(hasBlockedLanguage('n1gg3r'), true);
  assert.equal(hasBlockedLanguage('moffie'), true);
});

test('ordinary English and Afrikaans swearing remains allowed', () => {
  for (const word of ['fuck', 'shit', 'fok', 'kak', 'bliksem', 'naai']) {
    assert.equal(hasBlockedLanguage(word), false, `${word} was blocked`);
  }
});

test('blocked fragments do not poison innocent longer words', () => {
  for (const word of ['raccoon', 'classic', 'assignment', 'passionate']) {
    assert.equal(hasBlockedLanguage(word), false, `${word} was blocked`);
  }
});
