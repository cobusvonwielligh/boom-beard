import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rainbowFireTones } from '../public/client/fire.js';

test('streak fire tones animate through the spectrum', () => {
  const first = rainbowFireTones(0);
  const later = rainbowFireTones(0.5);

  assert.notEqual(first.hue, later.hue);
  assert.notEqual(first.edge, later.edge);
  assert.notEqual(first.mid, first.edge);
  assert.notEqual(first.cool, first.mid);
});
