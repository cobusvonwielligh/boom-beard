import test from 'node:test';
import assert from 'node:assert/strict';
import { delayBotInput } from '../server/ai.js';

test('bot inputs take one simulation tick to reach the game', () => {
  const brain = {};

  assert.equal(delayBotInput(brain, 7), 0);
  assert.equal(delayBotInput(brain, 3), 7);
  assert.equal(delayBotInput(brain, 0), 3);
  assert.equal(delayBotInput(brain, 0), 0);
});

test('count-in clears delayed bot input instead of carrying it into live play', () => {
  const brain = {};

  assert.equal(delayBotInput(brain, 7), 0);
  assert.equal(delayBotInput(brain, 0, { frozen: true }), 0);
  assert.equal(delayBotInput(brain, 3), 0);
  assert.equal(delayBotInput(brain, 0), 3);
});
