import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasBlockedLanguage, maskBlockedLanguage, nameKey } from '../server/names.js';

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

test('chat stars the blocked word and keeps the rest of the sentence', () => {
  assert.equal(maskBlockedLanguage('you absolute kaffer man'), 'you absolute *** man');
  assert.equal(maskBlockedLanguage('k.a.f.f.e.r'), '***');
  // Spread across spaces there is no single word to star, so the line goes.
  assert.equal(maskBlockedLanguage('n i g g e r'), '***');
  // Ordinary swearing passes through byte for byte.
  assert.equal(maskBlockedLanguage('fok, that shit was fucking close'),
    'fok, that shit was fucking close');
});

test('blocked fragments do not poison innocent longer words', () => {
  for (const word of ['raccoon', 'classic', 'assignment', 'passionate', 'spiel', 'hoër', 'poephol']) {
    assert.equal(hasBlockedLanguage(word), false, `${word} was blocked`);
  }
});
